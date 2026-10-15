import { createHash, randomBytes, randomUUID } from "node:crypto";
import { actorAllows } from "@workspace/towbar-access";
import { and, eq, inArray, isNull, notExists } from "drizzle-orm";
import {
  decryptCredential,
  encryptCredential,
  logCollectionStatusSchema,
  logCollectorVersion,
  parseCredentialsMasterKey,
} from "@workspace/towbar-core";
import {
  logCollectorRequests,
  logCollectors,
  serverPreparations,
  servers,
  sshHostKeys,
} from "@workspace/towbar-database/schema";
import { getEnv } from "../../env.js";
import {
  HttpError,
  badRequest,
  conflict,
  notFound,
} from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueueLogCollector } from "../../infrastructure/temporal.js";
import {
  auditAttribution,
  authorizeQueuedEffect,
  captureQueuedActor,
  withActor,
} from "../auth/actor-context.js";
import { recordAuditEvent } from "../../infrastructure/audit.js";
import { resolveServerCredentials } from "../secrets/store.js";
import { getServer } from "../servers/service.js";
import {
  getLogConfiguration,
  requireLogConfiguration,
} from "./configuration.js";
import { hashLogCredential } from "./ingest.js";
import { verifyLogStorage } from "./readiness.js";
export { logStorageStatus, verifyLogStorage } from "./readiness.js";

export async function getLogCollection(serverId: string, workspaceId: string) {
  await getServer(serverId, workspaceId);
  const [collector] = await getTowbarDatabase()
    .select()
    .from(logCollectors)
    .where(eq(logCollectors.serverId, serverId));
  if (!collector)
    return logCollectionStatusSchema.parse({
      serverId,
      desiredState: "disabled",
      status: "disabled",
      generation: null,
      version: null,
      lastReportAt: null,
      lastIngestedAt: null,
      errorMessage: null,
      supportedContainers: 0,
      unsupportedContainers: 0,
      queueBytes: 0,
      droppedRecords: 0,
    });
  const offline =
    collector.desiredState === "enabled" &&
    collector.lastReportAt &&
    Date.now() - collector.lastReportAt.getTime() > 90000;
  const status = offline
    ? "offline"
    : collector.desiredState === "enabled" && collector.queueBytes > 536870912
      ? "backlogged"
      : collector.status;
  return logCollectionStatusSchema.parse({
    serverId,
    desiredState: collector.desiredState,
    status,
    generation: collector.generation,
    version: collector.installedVersion,
    lastReportAt: collector.lastReportAt?.toISOString() ?? null,
    lastIngestedAt: collector.lastIngestedAt?.toISOString() ?? null,
    errorMessage: collector.errorMessage,
    supportedContainers: collector.supportedContainers,
    unsupportedContainers: collector.unsupportedContainers,
    queueBytes: collector.queueBytes,
    droppedRecords: collector.droppedRecords,
  });
}

export async function admitLogCollection(input: {
  serverId: string;
  workspaceId: string;
  enabled: boolean;
  idempotencyKey: string;
}) {
  return admitCollector(input);
}

async function admitCollector(
  input: Parameters<typeof admitLogCollection>[0],
  preparationId?: string,
) {
  const { requestedByActor } = captureQueuedActor(input.workspaceId, [
    "server.collectLogs",
  ]);
  const key = input.idempotencyKey.trim();
  if (!key || key.length > 255)
    throw badRequest(
      "A valid Idempotency-Key header is required",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  const keyHash = createHash("sha256").update(key).digest("hex");
  const db = getTowbarDatabase();
  const replay = async () => {
    const [request] = await db
      .select()
      .from(logCollectorRequests)
      .where(
        and(
          eq(logCollectorRequests.workspaceId, input.workspaceId),
          eq(logCollectorRequests.keyHash, keyHash),
        ),
      );
    if (!request) return null;
    assertMatchingLogRequest(request, input);
    const current = await getLogCollection(input.serverId, input.workspaceId);
    if (current.generation !== request.generation)
      throw conflict(
        "This operation was superseded. Inspect the current collector before starting a new action.",
        "LOGS_OPERATION_SUPERSEDED",
      );
    return { ...current, replayed: true };
  };
  const previous = await replay();
  if (previous) return previous;
  if (input.enabled) {
    requireLogConfiguration();
    await verifyLogStorage(input.workspaceId);
  }
  const endpoint = new URL("/v1/logs/ingest", getEnv().TOWBAR_API_BASE_URL);
  if (input.enabled && endpoint.protocol !== "https:")
    throw conflict("Log collection requires an HTTPS Towbar API URL.");
  const generation = randomUUID();
  const replayed = await db.transaction(async (tx) => {
    const [server] = await tx
      .select()
      .from(servers)
      .where(
        and(
          eq(servers.id, input.serverId),
          eq(servers.workspaceId, input.workspaceId),
          isNull(servers.archivedAt),
        ),
      )
      .for("update");
    if (!server) throw notFound("Server");
    if (preparationId) {
      const [preparation] = await tx
        .select()
        .from(serverPreparations)
        .where(
          and(
            eq(serverPreparations.id, preparationId),
            eq(serverPreparations.serverId, server.id),
            eq(serverPreparations.status, "running"),
            eq(serverPreparations.configDigest, server.configDigest),
          ),
        );
      if (!preparation)
        throw conflict(
          "Server setup is no longer active or its configuration changed.",
        );
    } else if (input.enabled && !server.preparedAt) {
      throw conflict("Prepare this server before installing the collector.");
    }
    const [current] = await tx
      .select()
      .from(logCollectors)
      .where(eq(logCollectors.serverId, input.serverId))
      .for("update");
    const [request] = await tx
      .select()
      .from(logCollectorRequests)
      .where(
        and(
          eq(logCollectorRequests.workspaceId, input.workspaceId),
          eq(logCollectorRequests.keyHash, keyHash),
        ),
      );
    if (request) {
      assertMatchingLogRequest(request, input);
      if (current?.generation !== request.generation)
        throw conflict(
          "This operation was superseded. Inspect the current collector before starting a new action.",
          "LOGS_OPERATION_SUPERSEDED",
        );
      return true;
    }
    if (preparationId && current?.desiredState === "disabled")
      throw conflict("Log collection was disabled during server setup.");
    if (current && ["queued", "installing"].includes(current.status))
      throw conflict("A log collector operation is already in progress.");
    const token = input.enabled
      ? `twlg_${randomBytes(32).toString("hex")}`
      : null;
    const values = {
      serverId: input.serverId,
      generation,
      status: "queued",
      desiredState: input.enabled ? "enabled" : "disabled",
      tokenHash: token ? hashLogCredential(token) : null,
      encryptedToken: token
        ? encryptCredential({
            associatedData: `logs:${input.serverId}:${generation}`,
            masterKey: parseCredentialsMasterKey(
              getEnv().TOWBAR_CREDENTIALS_KEY,
            ),
            value: token,
          })
        : null,
      requestedByActor,
      lastIngestedAt: null,
      errorMessage: null,
      updatedAt: new Date(),
    };
    const reservation = await tx
      .insert(logCollectorRequests)
      .values({
        workspaceId: input.workspaceId,
        keyHash,
        serverId: input.serverId,
        generation,
        enabled: input.enabled,
      })
      .onConflictDoNothing()
      .returning();
    if (!reservation.length)
      throw conflict(
        "This Idempotency-Key belongs to another collector action.",
        "IDEMPOTENCY_KEY_REUSED",
      );
    await tx
      .insert(logCollectors)
      .values(values)
      .onConflictDoUpdate({ target: logCollectors.serverId, set: values });
    await recordAuditEvent(tx, {
      workspaceId: input.workspaceId,
      actorUserId: null,
      action: input.enabled
        ? "logs.install_requested"
        : "logs.disable_requested",
      targetType: "server",
      targetId: input.serverId,
      metadata: { generation, version: logCollectorVersion },
      ...auditAttribution(),
    });
    return false;
  });
  const current = await getLogCollection(input.serverId, input.workspaceId);
  return { ...current, replayed };
}

export async function getPreparationLogCollectorContext(preparationId: string) {
  const db = getTowbarDatabase();
  const [row] = await db
    .select({ preparation: serverPreparations, server: servers })
    .from(serverPreparations)
    .innerJoin(servers, eq(servers.id, serverPreparations.serverId))
    .where(
      and(eq(serverPreparations.id, preparationId), isNull(servers.archivedAt)),
    );
  if (
    !row ||
    row.preparation.status !== "running" ||
    row.preparation.configDigest !== row.server.configDigest
  )
    throw conflict(
      "Server setup is no longer active or its configuration changed.",
    );
  if (
    !row.preparation.steps.some(
      (step) => step.id === "installing_caddy" && step.status === "succeeded",
    )
  )
    throw conflict(
      "Install Caddy before installing the log collector during setup.",
    );
  const actor = await authorizeQueuedEffect(
    row.preparation.requestedByActor,
    row.server.workspaceId,
    ["server.prepare"],
  );
  if (!getLogConfiguration())
    return {
      context: null,
      message:
        "Skipped: connect ClickHouse in config.yml to enable log collection. You can install the collector later in Settings → OTEL Logs Collector.",
    };
  if (!actorAllows(actor, ["server.collectLogs"], row.server.workspaceId))
    return {
      context: null,
      message:
        "Skipped: the requesting account cannot enable log collection. An administrator can enable it in Settings → OTEL Logs Collector.",
    };
  const [current] = await db
    .select()
    .from(logCollectors)
    .where(eq(logCollectors.serverId, row.server.id));
  if (current?.desiredState === "disabled")
    return {
      context: null,
      message:
        "Skipped: log collection was explicitly disabled for this server. Enable it in Settings → OTEL Logs Collector when needed.",
    };
  const result = await withActor(actor, () =>
    admitCollector(
      {
        serverId: row.server.id,
        workspaceId: row.server.workspaceId,
        enabled: true,
        idempotencyKey: `server-setup:${preparationId}`,
      },
      preparationId,
    ),
  );
  if (!result.generation)
    throw conflict("The collector installation has no active generation.");
  if (result.status === "failed")
    throw conflict(
      "Retry server setup to retry the failed collector installation.",
    );
  const context = await getLogCollectorExecutionContext(
    row.server.id,
    result.generation,
  );
  return {
    context,
    message: context
      ? "OTEL Logs Collector is installed and enabled. Waiting for the first log from an eligible container."
      : "OTEL Logs Collector is already installed and enabled.",
  };
}

export async function getLogCollectorExecutionContext(
  serverId: string,
  generation: string,
) {
  const db = getTowbarDatabase();
  const [row] = await db
    .select({ collector: logCollectors, server: servers })
    .from(logCollectors)
    .innerJoin(servers, eq(servers.id, logCollectors.serverId))
    .where(
      and(
        eq(servers.id, serverId),
        eq(logCollectors.generation, generation),
        isNull(servers.archivedAt),
      ),
    )
    .limit(1);
  if (!row) throw conflict("The log collector operation is no longer active.");
  if (!["queued", "installing"].includes(row.collector.status)) return null;
  await authorizeQueuedEffect(
    row.collector.requestedByActor,
    row.server.workspaceId,
    ["server.collectLogs"],
  );
  if (row.collector.desiredState === "enabled") requireLogConfiguration();
  const credentials = await resolveServerCredentials({
    serverId,
    workspaceId: row.server.workspaceId,
  });
  const privateKey = credentials.values.privateKey;
  if (!privateKey)
    throw conflict("Configure this server's SSH private key first.");
  const trustedHostKeys = await db
    .select({
      algorithm: sshHostKeys.algorithm,
      fingerprint: sshHostKeys.fingerprint,
      publicKey: sshHostKeys.publicKey,
    })
    .from(sshHostKeys)
    .where(
      and(eq(sshHostKeys.serverId, serverId), isNull(sshHostKeys.revokedAt)),
    );
  if (!trustedHostKeys.length)
    throw conflict("Trust this server's SSH host key first.");
  await db
    .update(logCollectors)
    .set({ status: "installing", updatedAt: new Date() })
    .where(
      and(
        eq(logCollectors.serverId, serverId),
        eq(logCollectors.generation, generation),
      ),
    );
  return {
    serverId,
    generation,
    desiredState: row.collector.desiredState as "enabled" | "disabled",
    config: row.server.config,
    login: { privateKey },
    trustedHostKeys,
    endpoint: new URL("/v1/logs", getEnv().TOWBAR_API_BASE_URL).toString(),
    token: row.collector.encryptedToken
      ? decryptCredential<string>({
          associatedData: `logs:${serverId}:${generation}`,
          masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
          envelope: row.collector.encryptedToken,
        })
      : null,
  };
}

export async function finishLogCollectorOperation(
  serverId: string,
  generation: string,
  succeeded: boolean,
) {
  const db = getTowbarDatabase();
  const [collector] = await db
    .select()
    .from(logCollectors)
    .where(
      and(
        eq(logCollectors.serverId, serverId),
        eq(logCollectors.generation, generation),
        inArray(logCollectors.status, ["queued", "installing"]),
      ),
    );
  if (!collector || !["queued", "installing"].includes(collector.status))
    return;
  await db
    .update(logCollectors)
    .set({
      status: succeeded
        ? collector.desiredState === "enabled"
          ? collector.lastIngestedAt
            ? "collecting"
            : "waiting"
          : "disabled"
        : "failed",
      ...(succeeded
        ? { encryptedToken: null, installedVersion: logCollectorVersion }
        : {}),
      errorMessage: succeeded
        ? null
        : "Log collector setup failed. Check SSH access, Docker log availability, and outbound HTTPS.",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(logCollectors.serverId, serverId),
        eq(logCollectors.generation, generation),
        inArray(logCollectors.status, ["queued", "installing"]),
      ),
    );
}

export async function recoverLogCollectorOperations() {
  const db = getTowbarDatabase();
  let configured = false;
  try {
    configured = Boolean(getLogConfiguration());
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
  }
  if (!configured) {
    const enabled = await db
      .select({
        serverId: logCollectors.serverId,
        workspaceId: servers.workspaceId,
      })
      .from(logCollectors)
      .innerJoin(servers, eq(servers.id, logCollectors.serverId))
      .where(eq(logCollectors.desiredState, "enabled"))
      .limit(100);
    for (const collector of enabled)
      await db
        .update(logCollectors)
        .set({
          desiredState: "disabled",
          status: "queued",
          generation: randomUUID(),
          tokenHash: null,
          encryptedToken: null,
          updatedAt: new Date(),
          requestedByActor: {
            kind: "system",
            workspaceId: collector.workspaceId,
            source: "worker",
            grants: ["server.collectLogs"],
          },
        })
        .where(eq(logCollectors.serverId, collector.serverId));
  }
  const queued = await db
    .select({
      serverId: logCollectors.serverId,
      generation: logCollectors.generation,
    })
    .from(logCollectors)
    .where(
      and(
        inArray(logCollectors.status, ["queued", "installing"]),
        notExists(
          db
            .select({ id: serverPreparations.id })
            .from(serverPreparations)
            .where(
              and(
                eq(serverPreparations.serverId, logCollectors.serverId),
                inArray(serverPreparations.status, ["queued", "running"]),
              ),
            ),
        ),
      ),
    )
    .limit(100);
  for (const operation of queued) {
    const result = await enqueueLogCollector(operation);
    if (result.closed)
      await finishLogCollectorOperation(
        operation.serverId,
        operation.generation,
        false,
      );
  }
  return queued.length;
}

function assertMatchingLogRequest(
  request: { serverId: string; enabled: boolean },
  input: { serverId: string; enabled: boolean },
) {
  if (request.serverId !== input.serverId || request.enabled !== input.enabled)
    throw conflict(
      "Use a new Idempotency-Key for a different collector action.",
      "IDEMPOTENCY_KEY_REUSED",
    );
}

export async function requestLogCollection(
  input: Parameters<typeof admitLogCollection>[0],
) {
  const result = await admitLogCollection(input);
  if (!result.replayed && result.generation)
    await enqueueLogCollector({
      serverId: input.serverId,
      generation: result.generation,
    }).catch(() => null);
  return result;
}
