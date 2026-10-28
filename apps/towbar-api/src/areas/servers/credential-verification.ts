import {
  authorizeQueuedEffect,
  captureQueuedActor,
} from "../auth/actor-context.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  decryptCredential,
  encryptCredential,
  parseCredentialsMasterKey,
} from "@workspace/towbar-core";
import {
  serverCredentialVerifications,
  servers,
  sshHostKeys,
} from "@workspace/towbar-database/schema";

import { getEnv } from "../../env.js";
import { HttpError, conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueueServerCheck } from "../../infrastructure/temporal.js";
import {
  promoteVerifiedServerPrivateKey,
  readSecretMetadata,
  validateServerCredentialValues,
} from "../secrets/store.js";
import { getServer, sshLoginSecretSchema } from "./service.js";
import { getWorkspacePrivateKeyValue } from "../private-keys/service.js";

type VerificationOutcome =
  | { result: Record<string, unknown>; status: "succeeded" }
  | {
      errorCode: string;
      errorMessage: string;
      result?: Record<string, unknown>;
      status: "failed";
    };

const publicSelection = {
  createdAt: serverCredentialVerifications.createdAt,
  errorCode: serverCredentialVerifications.errorCode,
  errorMessage: serverCredentialVerifications.errorMessage,
  finishedAt: serverCredentialVerifications.finishedAt,
  id: serverCredentialVerifications.id,
  result: serverCredentialVerifications.result,
  startedAt: serverCredentialVerifications.startedAt,
  status: serverCredentialVerifications.status,
} as const;

function associatedData(input: {
  id: string;
  serverId: string;
  workspaceId: string;
}) {
  return `server-credential-verification:${input.workspaceId}:${input.serverId}:${input.id}`;
}

export async function requestServerCredentialVerification(input: {
  expectedRevision: string | null;
  privateKeyId: string;
  requestedBy: string | null;
  serverId: string;
  workspaceId: string;
}) {
  const privateKey = await getWorkspacePrivateKeyValue(
    input.privateKeyId,
    input.workspaceId,
  );
  validateServerCredentialValues({ privateKey });
  const server = await getServer(input.serverId, input.workspaceId);
  const metadata = await readSecretMetadata({
    type: "server",
    id: input.serverId,
    workspaceId: input.workspaceId,
    environment: "production",
    stage: "credentials",
  });
  if (metadata.revision !== input.expectedRevision)
    throw conflict(
      "Server credentials changed after loading. Refresh before saving.",
      "SECRET_VERSION_CHANGED",
    );
  const database = getTowbarDatabase();
  const [active] = await database
    .select({ id: serverCredentialVerifications.id })
    .from(serverCredentialVerifications)
    .where(
      and(
        eq(serverCredentialVerifications.serverId, input.serverId),
        inArray(serverCredentialVerifications.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (active)
    throw conflict(
      "An SSH credential verification is already running for this server.",
      "CREDENTIAL_VERIFICATION_ACTIVE",
    );
  const id = randomUUID();
  const [verification] = await database
    .insert(serverCredentialVerifications)
    .values({
      id,
      encryptedPrivateKey: encryptCredential({
        associatedData: associatedData({ ...input, id }),
        masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
        value: privateKey,
      }),
      expectedCredentialRevision: input.expectedRevision,
      privateKeyId: input.privateKeyId,
      requestedBy: input.requestedBy,
      ...captureQueuedActor(input.workspaceId, ["admin"]),
      serverId: input.serverId,
    })
    .returning(publicSelection);
  if (!verification)
    throw new Error("Unable to create credential verification");
  try {
    await enqueueServerCheck({
      buildConcurrency: server.config.buildConcurrency ?? 1,
      checkId: verification.id,
      serverIp: server.canonicalIp,
    });
    return verification;
  } catch (error) {
    await database
      .update(serverCredentialVerifications)
      .set({
        encryptedPrivateKey: null,
        errorCode: "TEMPORAL_UNAVAILABLE",
        errorMessage: "Credential verification queue is unavailable",
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(serverCredentialVerifications.id, verification.id));
    throw error;
  }
}

export async function getServerCredentialVerification(input: {
  id: string;
  serverId: string;
  workspaceId: string;
}) {
  await getServer(input.serverId, input.workspaceId);
  const [verification] = await getTowbarDatabase()
    .select(publicSelection)
    .from(serverCredentialVerifications)
    .where(
      and(
        eq(serverCredentialVerifications.id, input.id),
        eq(serverCredentialVerifications.serverId, input.serverId),
      ),
    )
    .limit(1);
  if (!verification) throw notFound("Credential verification");
  return verification;
}

export async function getServerCredentialVerificationExecutionContext(
  verificationId: string,
) {
  const [verification] = await getTowbarDatabase()
    .select({
      config: servers.config,
      encryptedPrivateKey: serverCredentialVerifications.encryptedPrivateKey,
      requestedByActor: serverCredentialVerifications.requestedByActor,
      status: serverCredentialVerifications.status,
      serverId: servers.id,
      workspaceId: servers.workspaceId,
    })
    .from(serverCredentialVerifications)
    .innerJoin(servers, eq(servers.id, serverCredentialVerifications.serverId))
    .where(
      and(
        eq(serverCredentialVerifications.id, verificationId),
        isNull(servers.archivedAt),
        inArray(serverCredentialVerifications.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (!verification?.encryptedPrivateKey) return null;
  if (verification.status === "queued")
    await authorizeQueuedEffect(
      verification.requestedByActor,
      verification.workspaceId,
      ["admin"],
    );
  const privateKey = decryptCredential<string>({
    associatedData: associatedData({ ...verification, id: verificationId }),
    envelope: verification.encryptedPrivateKey,
    masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
  });
  const trustedHostKeys = await getTowbarDatabase()
    .select({
      algorithm: sshHostKeys.algorithm,
      fingerprint: sshHostKeys.fingerprint,
      publicKey: sshHostKeys.publicKey,
    })
    .from(sshHostKeys)
    .where(
      and(
        eq(sshHostKeys.serverId, verification.serverId),
        isNull(sshHostKeys.revokedAt),
      ),
    );
  const [running] = await getTowbarDatabase()
    .update(serverCredentialVerifications)
    .set({ startedAt: new Date(), status: "running" })
    .where(
      and(
        eq(serverCredentialVerifications.id, verificationId),
        inArray(serverCredentialVerifications.status, ["queued", "running"]),
      ),
    )
    .returning({ id: serverCredentialVerifications.id });
  if (!running) return null;
  return {
    checkId: verificationId,
    config: verification.config,
    expectedContainerNames: [],
    expectedDeployables: [],
    expectedImageTags: [],
    login: sshLoginSecretSchema.parse({ privateKey }),
    purpose: "credential-verification" as const,
    trustedHostKeys,
  };
}

export async function finishServerCredentialVerification(
  verificationId: string,
  input: VerificationOutcome,
) {
  return await getTowbarDatabase().transaction(async (transaction) => {
    const [verification] = await transaction
      .select({
        encryptedPrivateKey: serverCredentialVerifications.encryptedPrivateKey,
        expectedCredentialRevision:
          serverCredentialVerifications.expectedCredentialRevision,
        requestedBy: serverCredentialVerifications.requestedBy,
        privateKeyId: serverCredentialVerifications.privateKeyId,
        serverId: serverCredentialVerifications.serverId,
        status: serverCredentialVerifications.status,
        workspaceId: servers.workspaceId,
      })
      .from(serverCredentialVerifications)
      .innerJoin(
        servers,
        eq(servers.id, serverCredentialVerifications.serverId),
      )
      .where(eq(serverCredentialVerifications.id, verificationId))
      .for("update", { of: serverCredentialVerifications })
      .limit(1);
    if (!verification) return null;
    if (!["queued", "running"].includes(verification.status)) {
      const [existing] = await transaction
        .select(publicSelection)
        .from(serverCredentialVerifications)
        .where(eq(serverCredentialVerifications.id, verificationId))
        .limit(1);
      return existing ?? null;
    }

    let outcome = input;
    if (input.status === "succeeded") {
      try {
        if (!verification.encryptedPrivateKey)
          throw conflict(
            "The SSH credential candidate is no longer available.",
            "CREDENTIAL_VERIFICATION_EXPIRED",
          );
        if (!verification.privateKeyId)
          throw conflict(
            "The stored private key is no longer available.",
            "PRIVATE_KEY_NOT_AVAILABLE",
          );
        const privateKey = decryptCredential<string>({
          associatedData: associatedData({
            ...verification,
            id: verificationId,
          }),
          envelope: verification.encryptedPrivateKey,
          masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
        });
        await promoteVerifiedServerPrivateKey(
          {
            expectedRevision: verification.expectedCredentialRevision,
            privateKey,
            privateKeyId: verification.privateKeyId,
            serverId: verification.serverId,
            workspaceId: verification.workspaceId,
          },
          transaction,
        );
      } catch (error) {
        outcome = {
          errorCode:
            error instanceof HttpError
              ? error.code
              : "CREDENTIAL_PROMOTION_FAILED",
          errorMessage:
            error instanceof HttpError
              ? error.publicMessage
              : "The verified SSH credential could not be saved.",
          status: "failed",
        };
      }
    }
    const [updated] = await transaction
      .update(serverCredentialVerifications)
      .set({
        encryptedPrivateKey: null,
        errorCode: outcome.status === "failed" ? outcome.errorCode : null,
        errorMessage: outcome.status === "failed" ? outcome.errorMessage : null,
        finishedAt: new Date(),
        result: outcome.result ?? null,
        status: outcome.status,
      })
      .where(eq(serverCredentialVerifications.id, verificationId))
      .returning(publicSelection);
    return updated ?? null;
  });
}

export async function markServerCredentialVerificationInterrupted(
  verificationId: string,
) {
  const database = getTowbarDatabase();
  const [verification] = await database
    .update(serverCredentialVerifications)
    .set({
      encryptedPrivateKey: null,
      errorCode: "CREDENTIAL_VERIFICATION_INTERRUPTED",
      errorMessage:
        "The SSH credential verification was interrupted or timed out before it completed.",
      finishedAt: new Date(),
      status: "failed",
    })
    .where(
      and(
        eq(serverCredentialVerifications.id, verificationId),
        inArray(serverCredentialVerifications.status, ["queued", "running"]),
      ),
    )
    .returning(publicSelection);
  if (verification) return verification;
  const [existing] = await database
    .select(publicSelection)
    .from(serverCredentialVerifications)
    .where(eq(serverCredentialVerifications.id, verificationId))
    .limit(1);
  return existing ?? null;
}
