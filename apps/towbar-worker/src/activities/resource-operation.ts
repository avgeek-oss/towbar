import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { rootCertificates } from "node:tls";
import { ApplicationFailure, Context } from "@temporalio/activity";

import { executeResourceOperation } from "@workspace/towbar-deployer";
import { isNormalizedResource } from "@workspace/towbar-core";
import { createPolicyHttpsAgent } from "@workspace/towbar-core/network-policy";

import { signedApiRequest } from "../infrastructure/towbar-api.js";
import { getEnv } from "../env.js";
import { gcsStorage, s3Storage } from "./resource-operation-storage.js";

import type {
  BackupStorage,
  ResourceOperationExecutionContext,
  ResourceOperationSecrets,
} from "@workspace/towbar-deployer";
import type { BackupProvider } from "@workspace/towbar-core";

export async function executeResourceOperationActivity(operationId: string) {
  const activity = Context.current();
  const pulse = setInterval(() => activity.heartbeat({ operationId }), 10_000);
  let s3Client: S3Client | undefined;
  try {
    const contextResponse = await signedApiRequest<{
      context: ResourceOperationExecutionContext;
    }>("GET", `/v1/internal/resource-operations/${operationId}/context`);
    const secretsResponse = await signedApiRequest<{
      secrets: ResourceOperationSecrets;
    }>(
      "POST",
      `/v1/internal/resource-operations/${operationId}/secrets/resolve`,
    );
    const { context } = contextResponse;
    const { secrets } = secretsResponse;

    const { client, storage, storages } = initializeBackupStorages(
      context,
      secrets,
    );
    s3Client = client;

    const result = await executeResourceOperation({
      context,
      hooks: {
        progress: async (progress) => {
          await signedApiRequest(
            "POST",
            `/v1/internal/resource-operations/${operationId}/progress`,
            progress,
          );
        },
      },
      secrets,
      ...(storage ? { storage, storages } : {}),
      signal: activity.cancellationSignal,
    });
    await signedApiRequest(
      "POST",
      `/v1/internal/resource-operations/${operationId}/events`,
      { result, state: "succeeded" },
    );
  } catch (error) {
    await handleResourceOperationError(operationId, error);
  } finally {
    clearInterval(pulse);
    s3Client?.destroy();
  }
}

export function initializeBackupStorages(
  context: Pick<
    ResourceOperationExecutionContext,
    "deployable" | "restoreBackup" | "request"
  >,
  secrets: Pick<ResourceOperationSecrets, "aws" | "gcp"> & {
    namedStorage?: ResourceOperationSecrets["namedStorage"];
  },
) {
  const backup =
    context.deployable && isNormalizedResource(context.deployable)
      ? context.deployable.backup
      : undefined;
  const retained =
    context.request.type === "restore"
      ? context.restoreBackup?.result
      : undefined;
  const provider =
    context.request.type === "restore"
      ? (retained?.restoreFrom ?? "s3")
      : (backup?.restoreFrom ?? "s3");
  let client: S3Client | undefined;
  const storages: Partial<Record<BackupProvider, BackupStorage>> = {};
  if (secrets.namedStorage) {
    const named = secrets.namedStorage;
    if (named.provider === "s3" || named.provider === "r2") {
      client = new S3Client({
        credentials: named.credentials,
        endpoint: named.configuration.endpoint,
        forcePathStyle: named.configuration.addressingStyle === "path",
        region: named.configuration.region,
        maxAttempts: 4,
        requestHandler: new NodeHttpHandler({
          httpsAgent: createPolicyHttpsAgent({
            allowPrivateNetwork: named.configuration.allowPrivateNetwork,
            ...(named.configuration.customCa
              ? { ca: [...rootCertificates, named.configuration.customCa] }
              : {}),
          }),
        }),
      });
      return {
        client,
        storage: s3Storage(
          client,
          named.provider === "r2" ? "R2-managed" : undefined,
        ),
        storages,
      };
    }
    if (named.provider === "gcs") {
      return {
        client,
        storage: gcsStorage(JSON.parse(named.credentials.serviceAccountJson)),
        storages,
      };
    }
    throw new Error("Named backup provider is unsupported");
  }
  if (secrets.aws) {
    client = new S3Client({
      credentials: {
        accessKeyId: secrets.aws.accessKeyId,
        secretAccessKey: secrets.aws.secretAccessKey,
      },
      region:
        retained && provider === "s3"
          ? (retained.region ?? secrets.aws.region)
          : (backup?.s3?.region ?? secrets.aws.region),
    });
    storages.s3 = s3Storage(client);
  }
  if (secrets.gcp) {
    const key = JSON.parse(secrets.gcp.serviceAccountKey) as Parameters<
      typeof gcsStorage
    >[0];
    storages.gcs = gcsStorage(key);
  }
  return {
    client,
    storage: provider === "r2" ? storages.s3 : storages[provider],
    storages,
  };
}

async function handleResourceOperationError(
  operationId: string,
  error: unknown,
): Promise<never> {
  const cancelled = error instanceof Error && error.name === "AbortError";
  const result = restoreFailureResult(error);
  await signedApiRequest(
    "POST",
    `/v1/internal/resource-operations/${operationId}/events`,
    {
      errorCode: classifyError(error),
      errorMessage: safeErrorMessage(error),
      ...(result ? { result } : {}),
      state: cancelled ? "cancelled" : "failed",
    },
  ).catch(() => undefined);
  throw ApplicationFailure.create({
    message: safeErrorMessage(error),
    type: classifyError(error),
  });
}

export async function markResourceOperationInterruptedActivity(
  operationId: string,
) {
  await signedApiRequest(
    "POST",
    `/v1/internal/resource-operations/${operationId}/events`,
    {
      errorCode: "RESOURCE_OPERATION_INTERRUPTED",
      errorMessage: "The worker stopped before this operation completed",
      state: "failed",
    },
  );
}

export async function runMaintenanceSweepActivity() {
  await signedApiRequest("POST", "/v1/internal/maintenance/sweep", {
    version: getEnv().SOURCE_COMMIT,
  });
}

function restoreFailureResult(error: unknown) {
  if (typeof error === "object" && error !== null && "cleanupResult" in error)
    return error.cleanupResult;
  if (typeof error === "object" && error !== null && "jobResult" in error)
    return error.jobResult;
  if (typeof error === "object" && error !== null && "restoreResult" in error) {
    return (error as { restoreResult: unknown }).restoreResult;
  }
  return undefined;
}

function classifyError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return "RESOURCE_OPERATION_CANCELLED";
  }
  return "RESOURCE_OPERATION_FAILED";
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
        .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
        .slice(0, 1_000)
    : "Resource operation failed";
}
