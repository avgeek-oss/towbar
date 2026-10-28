import {
  authorizeQueuedEffect,
  captureQueuedActor,
  withActor,
} from "../auth/actor-context.js";
import { removeServer } from "../servers/lifecycle.js";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  decryptCredential,
  encryptCredential,
  parseCredentialsMasterKey,
} from "@workspace/towbar-core";
import {
  monitoringAgents,
  servers,
  sshHostKeys,
} from "@workspace/towbar-database/schema";
import { getEnv } from "../../env.js";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueueMonitoringAgent } from "../../infrastructure/temporal.js";
import { getServer } from "../servers/service.js";
import { resolveServerCredentials } from "../secrets/store.js";
import { hashAgentToken } from "./ingest.js";

const busyStates = new Set(["queued", "installing", "uninstalling"]);
export async function getMonitoringAgent(
  serverId: string,
  workspaceId: string,
) {
  await getServer(serverId, workspaceId);
  const [agent] = await getTowbarDatabase()
    .select()
    .from(monitoringAgents)
    .where(eq(monitoringAgents.serverId, serverId));
  const now = Date.now();
  const stale =
    agent?.status === "online" &&
    (!agent.lastCollectedAt || now - agent.lastCollectedAt.getTime() > 90_000);
  return {
    status: stale ? "offline" : (agent?.status ?? "disabled"),
    desiredState: agent?.desiredState ?? "disabled",
    retentionDays: agent?.retentionDays ?? 15,
    version: agent?.installedVersion ?? null,
    lastReportAt: agent?.lastReportAt?.toISOString() ?? null,
    lastCollectedAt: agent?.lastCollectedAt?.toISOString() ?? null,
    diagnostics: agent?.diagnostics ?? null,
    errorMessage: agent?.errorMessage ?? null,
    sampleIntervalSeconds: 30,
    removingServer: Boolean(agent?.removalRequested),
  };
}
export async function updateMonitoringRetention(input: {
  serverId: string;
  workspaceId: string;
  retentionDays: number;
}) {
  await getServer(input.serverId, input.workspaceId);
  await getTowbarDatabase().transaction(async (tx) => {
    const [server] = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.id, input.serverId), isNull(servers.archivedAt)))
      .for("share")
      .limit(1);
    if (!server) throw notFound("Server");
    await tx
      .insert(monitoringAgents)
      .values({ serverId: input.serverId, retentionDays: input.retentionDays })
      .onConflictDoUpdate({
        target: monitoringAgents.serverId,
        set: { retentionDays: input.retentionDays, updatedAt: new Date() },
      });
  });
  return getMonitoringAgent(input.serverId, input.workspaceId);
}
export async function requestMonitoringAgent(input: {
  serverId: string;
  workspaceId: string;
  requestedBy: string | null;
  desiredState: "enabled" | "disabled";
  retentionDays?: number;
}) {
  const endpoint = new URL(
    "/v1/monitoring/metrics",
    getEnv().TOWBAR_API_BASE_URL,
  );
  if (input.desiredState === "enabled" && endpoint.protocol !== "https:")
    throw conflict("Monitoring requires an HTTPS Towbar API URL");
  const database = getTowbarDatabase();
  const generation = randomUUID();
  await database.transaction(async (tx) => {
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
      .for("update")
      .limit(1);
    if (!server) throw notFound("Server");
    const [current] = await tx
      .select()
      .from(monitoringAgents)
      .where(eq(monitoringAgents.serverId, server.id))
      .for("update")
      .limit(1);
    if (current && busyStates.has(current.status))
      throw conflict("A monitoring operation is already in progress");
    if (
      input.desiredState === "enabled" &&
      (!server.preparedAt ||
        server.preparedConfigDigest !== server.configDigest)
    )
      throw conflict("Prepare this server before installing monitoring");
    const token =
      input.desiredState === "enabled"
        ? `twma_${randomBytes(32).toString("hex")}`
        : null;
    const values = {
      serverId: server.id,
      generation,
      desiredState: input.desiredState,
      status: "queued",
      retentionDays: input.retentionDays ?? current?.retentionDays ?? 15,
      tokenHash: token ? hashAgentToken(token) : null,
      encryptedToken: token
        ? encryptCredential({
            associatedData: `monitoring:${server.id}:${generation}`,
            masterKey: parseCredentialsMasterKey(
              getEnv().TOWBAR_CREDENTIALS_KEY,
            ),
            value: token,
          })
        : null,
      errorMessage: null,
      requestedBy: input.requestedBy,
      ...captureQueuedActor(input.workspaceId, ["member"]),
      operationStartedAt: null,
      removalRequested: false,
      removalRequestedBy: null,
      updatedAt: new Date(),
    };
    await tx
      .insert(monitoringAgents)
      .values(values)
      .onConflictDoUpdate({ target: monitoringAgents.serverId, set: values });
  });
  try {
    await enqueueMonitoringAgent({ serverId: input.serverId, generation });
  } catch {
    /* The durable queued row is retried by maintenance after an API or Temporal outage. */
  }
  return getMonitoringAgent(input.serverId, input.workspaceId);
}
export async function getMonitoringExecutionContext(
  serverId: string,
  generation: string,
) {
  const database = getTowbarDatabase();
  const [row] = await database
    .select({ agent: monitoringAgents, server: servers })
    .from(monitoringAgents)
    .innerJoin(servers, eq(servers.id, monitoringAgents.serverId))
    .where(
      and(
        eq(servers.id, serverId),
        eq(monitoringAgents.generation, generation),
        isNull(servers.archivedAt),
      ),
    )
    .limit(1);
  if (!row) throw conflict("Monitoring operation is no longer active");
  if (row.agent.status === "queued")
    await authorizeQueuedEffect(
      row.agent.requestedByActor,
      row.server.workspaceId,
      [row.agent.removalRequested ? "admin" : "member"],
    );
  if (["waiting", "online", "disabled"].includes(row.agent.status)) return null;
  if (!busyStates.has(row.agent.status))
    throw conflict("Monitoring operation is no longer active");
  const credentials = await resolveServerCredentials({
    serverId,
    workspaceId: row.server.workspaceId,
  });
  const privateKey = credentials.values.privateKey;
  if (!privateKey)
    throw conflict("Configure this server's SSH private key first");
  const trustedHostKeys = await database
    .select({
      algorithm: sshHostKeys.algorithm,
      fingerprint: sshHostKeys.fingerprint,
      publicKey: sshHostKeys.publicKey,
    })
    .from(sshHostKeys)
    .where(
      and(eq(sshHostKeys.serverId, serverId), isNull(sshHostKeys.revokedAt)),
    );
  if (trustedHostKeys.length === 0)
    throw conflict("Trust this server's SSH host key first");
  await database
    .update(monitoringAgents)
    .set({
      status:
        row.agent.desiredState === "enabled" ? "installing" : "uninstalling",
      operationStartedAt: row.agent.operationStartedAt ?? new Date(),
    })
    .where(
      and(
        eq(monitoringAgents.serverId, serverId),
        eq(monitoringAgents.generation, generation),
      ),
    );
  return {
    serverId,
    generation,
    desiredState: row.agent.desiredState as "enabled" | "disabled",
    config: row.server.config,
    login: { privateKey },
    trustedHostKeys,
    endpoint: new URL(
      "/v1/monitoring/metrics",
      getEnv().TOWBAR_API_BASE_URL,
    ).toString(),
    token: row.agent.encryptedToken
      ? decryptCredential<string>({
          associatedData: `monitoring:${serverId}:${generation}`,
          masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
          envelope: row.agent.encryptedToken,
        })
      : null,
  };
}
export async function finishMonitoringOperation(
  serverId: string,
  generation: string,
  succeeded: boolean,
) {
  const db = getTowbarDatabase();
  const [agent] = await db
    .select()
    .from(monitoringAgents)
    .where(
      and(
        eq(monitoringAgents.serverId, serverId),
        eq(monitoringAgents.generation, generation),
      ),
    )
    .limit(1);
  if (!agent || !busyStates.has(agent.status)) return;
  const online =
    agent.lastCollectedAt &&
    agent.operationStartedAt &&
    agent.lastCollectedAt >= agent.operationStartedAt;
  await db
    .update(monitoringAgents)
    .set({
      status: succeeded
        ? agent.desiredState === "enabled"
          ? online
            ? "online"
            : "waiting"
          : "disabled"
        : "failed",
      errorMessage: succeeded
        ? null
        : "Monitoring setup failed. Check SSH access, Docker, systemd, and outbound HTTPS, then retry.",
      ...(succeeded ? { encryptedToken: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(monitoringAgents.serverId, serverId),
        eq(monitoringAgents.generation, generation),
        inArray(monitoringAgents.status, [...busyStates]),
      ),
    );
  if (succeeded && agent.desiredState === "disabled")
    await finishPendingServerRemovals();
}

// The database row is an outbox: a crash between committing it and starting Temporal cannot strand setup.
export async function recoverMonitoringOperations(now = new Date()) {
  const database = getTowbarDatabase();
  await finishPendingServerRemovals();
  const queued = await database
    .select({
      serverId: monitoringAgents.serverId,
      generation: monitoringAgents.generation,
    })
    .from(monitoringAgents)
    .innerJoin(servers, eq(servers.id, monitoringAgents.serverId))
    .where(
      and(eq(monitoringAgents.status, "queued"), isNull(servers.archivedAt)),
    )
    .limit(100);
  for (const operation of queued) {
    const result = await enqueueMonitoringAgent(operation).catch(() => null);
    if (result?.closed)
      await finishMonitoringOperation(
        operation.serverId,
        operation.generation,
        false,
      );
  }
  await database
    .update(monitoringAgents)
    .set({
      status: "failed",
      errorMessage:
        "Monitoring setup timed out. Check worker and SSH connectivity, then retry.",
      updatedAt: now,
    })
    .where(
      and(
        inArray(monitoringAgents.status, ["installing", "uninstalling"]),
        lt(
          monitoringAgents.operationStartedAt,
          new Date(now.getTime() - 20 * 60_000),
        ),
      ),
    );
  return queued.length;
}

async function finishPendingServerRemovals() {
  const db = getTowbarDatabase();
  const pending = await db
    .select({
      serverId: servers.id,
      workspaceId: servers.workspaceId,
      requestedBy: monitoringAgents.removalRequestedBy,
      requestedByActor: monitoringAgents.requestedByActor,
    })
    .from(monitoringAgents)
    .innerJoin(servers, eq(servers.id, monitoringAgents.serverId))
    .where(
      and(
        eq(monitoringAgents.status, "disabled"),
        eq(monitoringAgents.removalRequested, true),
        isNull(servers.archivedAt),
      ),
    )
    .limit(100);
  for (const row of pending)
    if (row.requestedBy) {
      try {
        await withActor(
          await authorizeQueuedEffect(row.requestedByActor, row.workspaceId, [
            "admin",
          ]),
          () => removeServer({ ...row, requestedBy: row.requestedBy }),
        );
      } catch {
        await db
          .update(monitoringAgents)
          .set({
            removalRequested: false,
            removalRequestedBy: null,
            errorMessage:
              "The agent was removed, but the server has an active operation. Remove the server again when it finishes.",
          })
          .where(eq(monitoringAgents.serverId, row.serverId));
      }
    }
}
