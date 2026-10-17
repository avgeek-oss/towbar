import { lockDomainClaims } from "../deployments/domain-claims.js";
import { validateQueuedAppJob } from "../apps/jobs.js";
import { requireActiveAutomation } from "../auth/automation-authority.js";
import { authorizeQueuedEffect } from "../auth/actor-context.js";
import { operationPermissions } from "./permissions.js";
import { resolveServerCredentials } from "../secrets/store.js";
import type { SecretDatabase } from "../secrets/store.js";
import { and, eq, isNull } from "drizzle-orm";

import { backupOperationResultSchema } from "@workspace/towbar-core";
import {
  apps,
  resourceOperations,
  servers,
  sourceEnvironments,
  sshHostKeys,
} from "@workspace/towbar-database/schema";

import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { getDecryptedAwsCredential } from "../aws/service.js";
import { getDecryptedGcpCredential } from "../gcp/service.js";
import {
  requireResourcePasswords,
  resolveRuntimeEnvironmentSecrets,
} from "../deployments/deployment-secrets.js";
import { sshLoginSecretSchema } from "../servers/service.js";
import { getCleanupExpected, getRetentionBackups } from "./queries.js";
import { resolveIntegration } from "../integrations/service.js";

export async function getOperationExecutionContext(operationId: string) {
  const [operation] = await getTowbarDatabase()
    .select()
    .from(resourceOperations)
    .where(eq(resourceOperations.id, operationId))
    .limit(1);
  if (!operation) throw notFound("Resource operation");
  if (operation.request.type === "run_job")
    await validateQueuedAppJob({ ...operation, request: operation.request });
  if (operation.request.type === "cleanup_orphans") {
    await authorizeQueuedEffect(
      operation.requestedByActor,
      operation.workspaceId,
      operationPermissions(operation.request),
    );
    return await getCleanupExecutionContext(operation);
  }
  if (operation.state === "queued") {
    const actor = await authorizeQueuedEffect(
      operation.requestedByActor,
      operation.workspaceId,
      operationPermissions(operation.request),
    );
    if (
      actor.kind === "system" &&
      operation.request.type === "backup" &&
      operation.resourceId
    )
      await requireActiveAutomation({
        workspaceId: operation.workspaceId,
        deployableId: operation.resourceId,
        config: operation.appSnapshot,
      });
    const claimed = await getTowbarDatabase()
      .update(resourceOperations)
      .set({ startedAt: new Date(), state: "running", updatedAt: new Date() })
      .where(
        and(
          eq(resourceOperations.id, operationId),
          eq(resourceOperations.state, "queued"),
        ),
      )
      .returning({ id: resourceOperations.id });
    if (!claimed.length && operation.request.type === "run_job")
      throw conflict(
        "This job run was already claimed",
        "APP_JOB_ALREADY_STARTED",
      );
  } else if (
    operation.state !== "running" ||
    operation.request.type === "run_job"
  ) {
    throw conflict("Resource operation is already complete");
  }
  const trustedHostKeys = await getTowbarDatabase()
    .select({
      algorithm: sshHostKeys.algorithm,
      fingerprint: sshHostKeys.fingerprint,
      publicKey: sshHostKeys.publicKey,
    })
    .from(sshHostKeys)
    .where(
      and(
        eq(sshHostKeys.serverId, operation.serverId),
        isNull(sshHostKeys.revokedAt),
      ),
    );
  const currentRelease = operation.request.release;
  const sourceId = requireOperationSource(operation.sourceId);
  const cleanupExpected = await getCleanupExpected(operation.serverId);
  const [environment] = operation.resourceId
    ? await getTowbarDatabase()
        .select({ name: sourceEnvironments.name })
        .from(apps)
        .innerJoin(
          sourceEnvironments,
          eq(sourceEnvironments.id, apps.sourceEnvironmentId),
        )
        .where(eq(apps.id, operation.resourceId))
        .limit(1)
    : [];
  const restoreBackup =
    operation.request.type === "restore" && operation.resourceId
      ? await getRestoreBackup({
          backupId: operation.request.backupId,
          resourceId: operation.resourceId,
          sourceId: sourceId!,
          workspaceId: operation.workspaceId,
        })
      : null;
  return {
    cleanupExpected,
    currentRelease,
    deployable: operation.appSnapshot,
    deployableId: operation.resourceId,
    environment: environment?.name ?? null,
    operationId: operation.id,
    request: operation.request,
    retentionBackups:
      operation.request.type === "backup" && operation.resourceId
        ? await getRetentionBackups(operation.resourceId, operation.appSnapshot)
        : [],
    restoreBackup,
    server: operation.serverSnapshot,
    sourceId,
    trustedHostKeys,
  };
}

export async function resolveOperationSecrets(operationId: string) {
  return await getTowbarDatabase().transaction(
    async (database) => {
      const [operation] = await database
        .select({
          app: resourceOperations.appSnapshot,
          request: resourceOperations.request,
          resourceId: resourceOperations.resourceId,
          server: resourceOperations.serverSnapshot,
          serverId: resourceOperations.serverId,
          sourceId: resourceOperations.sourceId,
          workspaceId: resourceOperations.workspaceId,
          requestedByActor: resourceOperations.requestedByActor,
        })
        .from(resourceOperations)
        .where(eq(resourceOperations.id, operationId))
        .limit(1);
      if (!operation) throw notFound("Resource operation");
      if (operation.request.type === "run_job") {
        await authorizeQueuedEffect(
          operation.requestedByActor,
          operation.workspaceId,
          ["workload.operate"],
        );
        await validateQueuedAppJob({
          ...operation,
          request: operation.request,
        });
      }
      const credentials = await resolveServerCredentials(operation, database);
      const login = sshLoginSecretSchema.parse({
        privateKey: credentials.values.privateKey,
      });
      const runtime =
        ["capture_logs", "restore", "run_job"].includes(
          operation.request.type,
        ) &&
        operation.app &&
        operation.resourceId
          ? await resolveRuntimeEnvironmentSecrets(
              {
                appId: operation.resourceId,
                sourceId: requireOperationSource(operation.sourceId),
                workspaceId: operation.workspaceId,
              },
              database,
            )
          : {};
      if (operation.request.type === "restore")
        requireResourcePasswords(operation.app?.kind, runtime);

      const { aws, gcp, sensitiveStorageValues } =
        await resolveCloudStorageSecrets(operation, database);
      const namedStorage = await resolveNamedStorage(operation, database);

      return {
        aws,
        gcp,
        login,
        namedStorage,
        runtime,
        sensitiveValues: [
          login.privateKey,
          ...sensitiveStorageValues,
          ...namedStorageSensitiveValues(namedStorage),
          ...Object.values(runtime),
        ],
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

async function resolveNamedStorage(
  operation: {
    app: unknown;
    request: { type: string; policyIndex?: number };
    resourceId: string | null;
    sourceId: string | null;
    workspaceId: string;
  },
  database: SecretDatabase,
) {
  if (!["backup", "restore"].includes(operation.request.type)) return null;
  if (!operation.app || typeof operation.app !== "object")
    throw conflict("Backup operation is missing its Resource snapshot");
  const integration =
    "backup" in operation.app
      ? (operation.app as { backup?: { integration?: string } }).backup
          ?.integration
      : undefined;
  if (!integration) return null;
  if (!operation.sourceId || !operation.resourceId)
    throw conflict("Backup integration scope could not be resolved");
  const [environment] = await database
    .select({ name: sourceEnvironments.name })
    .from(apps)
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .where(eq(apps.id, operation.resourceId))
    .limit(1);
  const resolved = await resolveIntegration({
    workspaceId: operation.workspaceId,
    slug: integration,
    providers: ["s3", "r2", "gcs"],
    target: {
      kind: "repository",
      purpose: "backup",
      repositoryId: operation.sourceId,
      environment: environment?.name ?? "production",
    },
  });
  const input = resolved.connectionInput;
  if (!["s3", "r2", "gcs"].includes(input.provider))
    throw conflict("Backup integration is not object storage");
  return input as import("@workspace/towbar-core").NamedBackupStorageConnection;
}

function namedStorageSensitiveValues(
  storage: import("@workspace/towbar-core").NamedBackupStorageConnection | null,
) {
  if (!storage) return [];
  if (storage.provider === "s3" || storage.provider === "r2")
    return [storage.credentials.secretAccessKey];
  return [storage.credentials.serviceAccountJson];
}

function extractBackupConfig(
  app: unknown,
): import("@workspace/towbar-core").NormalizedResource["backup"] | undefined {
  if (app && typeof app === "object" && "backup" in app) {
    return (
      app as {
        backup?: import("@workspace/towbar-core").NormalizedResource["backup"];
      }
    ).backup;
  }
  return undefined;
}

async function resolveTargetRestoreProvider(
  operation: {
    request: { type: string; backupId?: string };
  },
  database?: SecretDatabase,
): Promise<"s3" | "gcs" | undefined> {
  if (operation.request.type !== "restore" || !operation.request.backupId) {
    return undefined;
  }
  const db = database ?? getTowbarDatabase();
  const [targetBackup] = await db
    .select({ result: resourceOperations.result })
    .from(resourceOperations)
    .where(eq(resourceOperations.id, operation.request.backupId))
    .limit(1);
  if (!targetBackup?.result) {
    return undefined;
  }
  const parsed = backupOperationResultSchema.safeParse(targetBackup.result);
  if (!parsed.success) {
    return undefined;
  }
  const provider = parsed.data.restoreFrom ?? "s3";
  return provider === "r2" ? undefined : provider;
}

function determineRequiredProviders(
  requiresBackup: boolean,
  backupConfig:
    import("@workspace/towbar-core").NormalizedResource["backup"] | undefined,
  restoreFromProvider?: "s3" | "gcs",
) {
  if (!requiresBackup) {
    return { needsAws: false, needsGcp: false };
  }
  return {
    needsAws:
      !backupConfig ||
      Boolean(backupConfig.s3) ||
      backupConfig.restoreFrom === "s3" ||
      restoreFromProvider === "s3",
    needsGcp: Boolean(
      backupConfig?.gcs ||
      backupConfig?.restoreFrom === "gcs" ||
      restoreFromProvider === "gcs",
    ),
  };
}

async function resolveCloudStorageSecrets(
  operation: {
    app: unknown;
    request: { type: string; backupId?: string };
    workspaceId: string;
  },
  database?: SecretDatabase,
) {
  const requiresBackup = ["backup", "restore"].includes(operation.request.type);
  const backupConfig = extractBackupConfig(operation.app);
  const restoreFromProvider = await resolveTargetRestoreProvider(
    operation,
    database,
  );
  const { needsAws, needsGcp } = determineRequiredProviders(
    requiresBackup,
    backupConfig,
    restoreFromProvider,
  );

  const [awsCredential, gcpCredential] = await Promise.all([
    needsAws
      ? getDecryptedAwsCredential({
          workspaceId: operation.workspaceId,
        }).catch(() => null)
      : null,
    needsGcp
      ? getDecryptedGcpCredential({
          workspaceId: operation.workspaceId,
        }).catch(() => null)
      : null,
  ]);

  const aws = awsCredential
    ? { ...awsCredential.payload, region: awsCredential.region }
    : null;

  const gcp = gcpCredential
    ? {
        projectId: gcpCredential.projectId,
        serviceAccountKey: JSON.stringify(gcpCredential.payload),
      }
    : null;

  const sensitiveStorageValues = [
    ...(awsCredential ? [awsCredential.payload.secretAccessKey] : []),
    ...(gcpCredential ? [gcpCredential.payload.private_key] : []),
  ];

  return { aws, gcp, sensitiveStorageValues };
}

function requireOperationSource(sourceId: string | null) {
  if (!sourceId) {
    throw conflict(
      "This Resource operation has no Source context",
      "RESOURCE_OPERATION_SOURCE_MISSING",
    );
  }
  return sourceId;
}

async function getRestoreBackup(input: {
  backupId: string;
  resourceId: string;
  sourceId: string;
  workspaceId: string;
}) {
  const [backup] = await getTowbarDatabase()
    .select({
      createdAt: resourceOperations.createdAt,
      id: resourceOperations.id,
      result: resourceOperations.result,
    })
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.id, input.backupId),
        eq(resourceOperations.resourceId, input.resourceId),
        eq(resourceOperations.sourceId, input.sourceId),
        eq(resourceOperations.workspaceId, input.workspaceId),
        eq(resourceOperations.type, "backup"),
        eq(resourceOperations.state, "succeeded"),
        isNull(resourceOperations.deletedAt),
      ),
    )
    .limit(1);
  if (!backup) throw notFound("Retained backup");
  return {
    createdAt: backup.createdAt.toISOString(),
    id: backup.id,
    result: backupOperationResultSchema.parse(backup.result),
  };
}

async function getCleanupExecutionContext(
  operation: typeof resourceOperations.$inferSelect,
) {
  return await getTowbarDatabase().transaction(async (database) => {
    await lockDomainClaims(database, operation.workspaceId);
    const [current] = await database
      .select()
      .from(resourceOperations)
      .where(eq(resourceOperations.id, operation.id))
      .for("update");
    if (
      !current ||
      current.state !== "queued" ||
      current.request.type !== "cleanup_orphans"
    )
      throw conflict(
        "Cleanup has already started or completed",
        "CLEANUP_ALREADY_STARTED",
      );
    const [server] = await database
      .select()
      .from(servers)
      .where(and(eq(servers.id, current.serverId), isNull(servers.archivedAt)));
    if (!server)
      throw conflict("Cleanup server is unavailable", "SERVER_UNAVAILABLE");
    if (server.config.ip !== current.serverSnapshot.ip)
      throw conflict(
        "Server address changed after cleanup was queued. Request cleanup again.",
        "CLEANUP_SERVER_CHANGED",
      );
    const cleanupExpected = await getCleanupExpected(
      server.id,
      database,
      current.request.retirementId,
    );
    if (!current.request.trigger || current.request.scope === "selected")
      cleanupExpected.retiring = [];
    const request = {
      ...current.request,
      retiringDeployableIds:
        cleanupExpected.retiring?.map((app) => app.deployableId) ?? [],
    };
    await database
      .update(resourceOperations)
      .set({
        request,
        state: "running",
        startedAt: new Date(),
        updatedAt: new Date(),
        serverSnapshot: server.config,
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(resourceOperations.id, current.id));
    const trustedHostKeys = await database
      .select({
        algorithm: sshHostKeys.algorithm,
        fingerprint: sshHostKeys.fingerprint,
        publicKey: sshHostKeys.publicKey,
      })
      .from(sshHostKeys)
      .where(
        and(eq(sshHostKeys.serverId, server.id), isNull(sshHostKeys.revokedAt)),
      );
    return {
      cleanupExpected,
      request,
      trustedHostKeys,
      server: server.config,
      operationId: current.id,
      currentRelease: null,
      deployable: null,
      deployableId: null,
      sourceId: null,
      environment: null,
      retentionBackups: [],
      restoreBackup: null,
    };
  });
}
