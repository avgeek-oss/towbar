import {
  authorizeQueuedEffect,
  captureQueuedActor,
} from "../auth/actor-context.js";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { ServerPreparationStep } from "@workspace/towbar-core";
import { createServerPreparationSteps } from "@workspace/towbar-core";
import {
  apps,
  serverChecks,
  serverPreparations,
  servers,
  sshHostKeys,
  workspacePrivateKeys,
} from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import {
  enqueueServerCheck,
  enqueueServerPreparation,
} from "../../infrastructure/temporal.js";
import { resolveServerCredentials } from "../secrets/store.js";
import { pruneServerCheckHistory } from "./check-retention.js";
import { sshLoginSecretSchema } from "./service.js";

const publicServerPreparationSelection = {
  createdAt: serverPreparations.createdAt,
  errorCode: serverPreparations.errorCode,
  errorMessage: serverPreparations.errorMessage,
  finishedAt: serverPreparations.finishedAt,
  id: serverPreparations.id,
  result: serverPreparations.result,
  startedAt: serverPreparations.startedAt,
  status: serverPreparations.status,
  steps: serverPreparations.steps,
} as const;

export async function listServerPreparations(
  serverId: string,
  workspaceId: string,
) {
  const database = getTowbarDatabase();
  const [server] = await database
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.workspaceId, workspaceId)))
    .limit(1);
  if (!server) throw notFound("Server");
  return await database
    .select(publicServerPreparationSelection)
    .from(serverPreparations)
    .where(eq(serverPreparations.serverId, serverId))
    .orderBy(desc(serverPreparations.createdAt));
}

export async function requestServerPreparation(input: {
  requestedBy: string | null;
  serverId: string;
  workspaceId: string;
}) {
  const database = getTowbarDatabase();
  const [server] = await database
    .select({
      archivedAt: servers.archivedAt,
      canonicalIp: servers.canonicalIp,
      config: servers.config,
      configDigest: servers.configDigest,
      id: servers.id,
      preparedAt: servers.preparedAt,
      lastRemovedAt: servers.lastRemovedAt,
      preparedConfigDigest: servers.preparedConfigDigest,
    })
    .from(servers)
    .where(
      and(
        eq(servers.id, input.serverId),
        eq(servers.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!server) throw notFound("Server");
  if (server.archivedAt) throw conflict("Archived servers cannot be prepared");
  if (
    server.preparedAt &&
    server.preparedConfigDigest === server.configDigest
  ) {
    throw conflict("This server is already ready", "SERVER_ALREADY_READY");
  }
  const [active] = await database
    .select({ id: serverPreparations.id })
    .from(serverPreparations)
    .where(
      and(
        eq(serverPreparations.serverId, server.id),
        inArray(serverPreparations.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (active) {
    throw conflict(
      "Server preparation is already in progress",
      "SERVER_PREPARATION_ACTIVE",
    );
  }
  const [trustedKey] = await database
    .select({ id: sshHostKeys.id })
    .from(sshHostKeys)
    .where(
      and(eq(sshHostKeys.serverId, server.id), isNull(sshHostKeys.revokedAt)),
    )
    .limit(1);
  if (!trustedKey) {
    throw conflict(
      "Trust an SSH host key before preparing this server",
      "SERVER_HOST_KEY_REQUIRED",
    );
  }
  let preparation;
  try {
    [preparation] = await database
      .insert(serverPreparations)
      .values({
        configDigest: server.configDigest,
        requestedBy: input.requestedBy,
        ...captureQueuedActor(input.workspaceId, ["server.prepare"]),
        serverId: server.id,
        steps: createServerPreparationSteps(),
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(
        "Server preparation is already in progress",
        "SERVER_PREPARATION_ACTIVE",
      );
    }
    throw error;
  }
  if (!preparation) throw new Error("Unable to create server preparation");
  try {
    await enqueueServerPreparation({
      buildConcurrency: server.config.buildConcurrency ?? 1,
      preparationId: preparation.id,
      serverIp: server.canonicalIp,
    });
  } catch (error) {
    await database
      .update(serverPreparations)
      .set({
        errorCode: "TEMPORAL_UNAVAILABLE",
        errorMessage: "Server preparation queue is unavailable",
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(serverPreparations.id, preparation.id));
    throw error;
  }
  return toPublicServerPreparation(preparation);
}

export async function getServerPreparationExecutionContext(
  preparationId: string,
) {
  const database = getTowbarDatabase();
  const [context] = await database
    .select({
      config: servers.config,
      currentConfigDigest: servers.configDigest,
      preparationConfigDigest: serverPreparations.configDigest,
      preparationId: serverPreparations.id,
      requestedByActor: serverPreparations.requestedByActor,
      status: serverPreparations.status,
      preparedAt: servers.preparedAt,
      lastRemovedAt: servers.lastRemovedAt,
      serverId: servers.id,
      workspaceId: servers.workspaceId,
      privateKeyName: workspacePrivateKeys.name,
    })
    .from(serverPreparations)
    .innerJoin(servers, eq(servers.id, serverPreparations.serverId))
    .leftJoin(
      workspacePrivateKeys,
      and(
        eq(workspacePrivateKeys.id, servers.privateKeyId),
        eq(workspacePrivateKeys.workspaceId, servers.workspaceId),
      ),
    )
    .where(eq(serverPreparations.id, preparationId))
    .limit(1);
  if (!context) throw notFound("Server preparation");
  if (context.status === "queued")
    await authorizeQueuedEffect(context.requestedByActor, context.workspaceId, [
      "server.prepare",
    ]);
  if (context.currentConfigDigest !== context.preparationConfigDigest) {
    throw conflict(
      "Server configuration changed after preparation was queued",
      "SERVER_CONFIG_CHANGED",
    );
  }
  const credentials = await resolveServerCredentials(context);
  const login = sshLoginSecretSchema.parse({
    privateKey: credentials.values.privateKey,
  });
  const trustedHostKeys = await database
    .select({
      algorithm: sshHostKeys.algorithm,
      fingerprint: sshHostKeys.fingerprint,
      publicKey: sshHostKeys.publicKey,
    })
    .from(sshHostKeys)
    .where(
      and(
        eq(sshHostKeys.serverId, context.serverId),
        isNull(sshHostKeys.revokedAt),
      ),
    );
  const cleanupDeployableIds =
    !context.preparedAt && context.lastRemovedAt
      ? (
          await database
            .select({ id: apps.id })
            .from(apps)
            .where(
              and(
                eq(apps.serverId, context.serverId),
                eq(apps.kind, "app"),
                isNull(apps.archivedAt),
              ),
            )
        ).map((app) => app.id)
      : [];
  await database
    .update(serverPreparations)
    .set({ startedAt: new Date(), status: "running" })
    .where(
      and(
        eq(serverPreparations.id, preparationId),
        eq(serverPreparations.status, "queued"),
      ),
    );
  return {
    cleanupDeployableIds,
    config: context.config,
    login,
    preparationId: context.preparationId,
    privateKeyName: context.privateKeyName ?? undefined,
    trustedHostKeys,
  };
}

export async function updateServerPreparation(
  preparationId: string,
  input:
    | { status: "running"; steps: ServerPreparationStep[] }
    | {
        result: Record<string, unknown>;
        status: "succeeded";
        steps: ServerPreparationStep[];
      }
    | {
        errorCode: string;
        errorMessage: string;
        status: "failed";
        steps: ServerPreparationStep[];
      },
) {
  if (input.status === "running") {
    const [preparation] = await getTowbarDatabase()
      .update(serverPreparations)
      .set({ steps: input.steps })
      .where(
        and(
          eq(serverPreparations.id, preparationId),
          eq(serverPreparations.status, "running"),
        ),
      )
      .returning();
    if (!preparation) throw notFound("Active server preparation");
    return toPublicServerPreparation(preparation);
  }

  const outcome = await getTowbarDatabase().transaction(async (transaction) => {
    const [current] = await transaction
      .select({
        serverConfig: servers.config,
        canonicalIp: servers.canonicalIp,
        configDigest: serverPreparations.configDigest,
        requestedBy: serverPreparations.requestedBy,
        serverConfigDigest: servers.configDigest,
        serverId: serverPreparations.serverId,
        status: serverPreparations.status,
        workspaceId: servers.workspaceId,
      })
      .from(serverPreparations)
      .innerJoin(servers, eq(servers.id, serverPreparations.serverId))
      .where(eq(serverPreparations.id, preparationId))
      .for("update")
      .limit(1);
    if (!current) throw notFound("Server preparation");
    if (current.status === "succeeded" || current.status === "failed") {
      const [existing] = await transaction
        .select(publicServerPreparationSelection)
        .from(serverPreparations)
        .where(eq(serverPreparations.id, preparationId))
        .limit(1);
      if (!existing) throw notFound("Server preparation");
      return { check: null, result: existing };
    }

    const finishedAt = new Date();
    const configChanged =
      input.status === "succeeded" &&
      current.configDigest !== current.serverConfigDigest;
    const status = configChanged ? ("failed" as const) : input.status;
    const [preparation] = await transaction
      .update(serverPreparations)
      .set({
        errorCode:
          status === "failed"
            ? configChanged
              ? "SERVER_CONFIG_CHANGED"
              : input.status === "failed"
                ? input.errorCode
                : "SERVER_PREPARATION_FAILED"
            : null,
        errorMessage:
          status === "failed"
            ? configChanged
              ? "Server configuration changed during preparation"
              : input.status === "failed"
                ? input.errorMessage
                : "Server preparation failed"
            : null,
        finishedAt,
        result: input.status === "succeeded" ? input.result : null,
        status,
        steps: input.steps,
      })
      .where(eq(serverPreparations.id, preparationId))
      .returning();
    if (!preparation) throw notFound("Server preparation");
    if (status === "succeeded") {
      await transaction
        .update(servers)
        .set({
          preparedAt: finishedAt,
          preparedConfigDigest: current.configDigest,
          updatedAt: finishedAt,
        })
        .where(eq(servers.id, current.serverId));
    }
    const [check] =
      status === "succeeded"
        ? await transaction
            .insert(serverChecks)
            .values({
              requestedBy: current.requestedBy,
              requestedByActor: {
                grants: ["server.credentials"],
                kind: "system",
                source: "worker",
                workspaceId: current.workspaceId,
              },
              serverId: current.serverId,
            })
            .returning()
        : [];
    return {
      check: check
        ? {
            buildConcurrency: current.serverConfig.buildConcurrency ?? 1,
            checkId: check.id,
            serverId: current.serverId,
            serverIp: current.canonicalIp,
          }
        : null,
      result: toPublicServerPreparation(preparation),
    };
  });
  if (outcome.check) {
    try {
      await enqueueServerCheck(outcome.check);
    } catch {
      const database = getTowbarDatabase();
      await database
        .update(serverChecks)
        .set({
          errorCode: "TEMPORAL_UNAVAILABLE",
          errorMessage: "Server check queue is unavailable",
          finishedAt: new Date(),
          status: "failed",
        })
        .where(eq(serverChecks.id, outcome.check.checkId));
      await pruneServerCheckHistory(database, outcome.check.serverId);
    }
  }
  return outcome.result;
}

function toPublicServerPreparation(
  preparation: typeof serverPreparations.$inferSelect,
) {
  return {
    createdAt: preparation.createdAt,
    errorCode: preparation.errorCode,
    errorMessage: preparation.errorMessage,
    finishedAt: preparation.finishedAt,
    id: preparation.id,
    result: preparation.result,
    startedAt: preparation.startedAt,
    status: preparation.status,
    steps: preparation.steps,
  };
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
