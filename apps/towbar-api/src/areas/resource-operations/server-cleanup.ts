import { randomUUID } from "node:crypto";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { resourceOperationWorkflowId } from "@workspace/towbar-core/temporal";
import { resourceOperations, servers } from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueueResourceOperation } from "../../infrastructure/temporal.js";
import { captureQueuedActor } from "../auth/actor-context.js";
import type { SecretDatabase } from "../secrets/store.js";
import { getServerOrphans, publicOperationSelection } from "./queries.js";

export async function assertNoRunningCleanup(
  database: SecretDatabase,
  workspaceId: string,
) {
  const [running] = await database
    .select({ id: resourceOperations.id })
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.workspaceId, workspaceId),
        eq(resourceOperations.type, "cleanup_orphans"),
        eq(resourceOperations.state, "running"),
      ),
    )
    .limit(1);
  if (running)
    throw conflict(
      "Server cleanup is running. Retry after it finishes.",
      "SERVER_CLEANUP_RUNNING",
    );
}

export async function requestServerCleanup(input: {
  workspaceId: string;
  serverId: string;
  idempotencyKey: string;
  requestedBy: string | null;
  items?: Array<{ kind: "container" | "image" | "volume"; name: string }>;
}) {
  const database = getTowbarDatabase();
  const key = `cleanup_orphans:${input.serverId}:${input.idempotencyKey}`;
  const [existing] = await database
    .select(publicOperationSelection)
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.workspaceId, input.workspaceId),
        eq(resourceOperations.idempotencyKey, key),
      ),
    );
  if (existing) {
    await dispatchServerCleanups(existing.id);
    return { operation: existing, replayed: true };
  }
  const [server] = await database
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.id, input.serverId),
        eq(servers.workspaceId, input.workspaceId),
        isNull(servers.archivedAt),
      ),
    );
  if (!server) throw notFound("Server");
  const selected = input.items
    ? (await getServerOrphans(server.id, input.workspaceId)).filter((item) =>
        input.items!.some(
          (requested) =>
            requested.kind === item.kind && requested.name === item.name,
        ),
      )
    : [];
  if (
    input.items &&
    (selected.length === 0 || selected.length !== input.items.length)
  )
    throw conflict(
      "Run a fresh server check and select only its current scoped orphans",
      "ORPHAN_SNAPSHOT_STALE",
    );
  const id = randomUUID();
  const [created] = await database
    .insert(resourceOperations)
    .values({
      id,
      workspaceId: input.workspaceId,
      serverId: server.id,
      serverSnapshot: server.config,
      type: "cleanup_orphans",
      request: {
        type: "cleanup_orphans",
        items: selected,
        trigger: "manual",
        ...(input.items ? { scope: "selected" as const } : {}),
      },
      idempotencyKey: key,
      temporalWorkflowId: resourceOperationWorkflowId(id),
      requestedBy: input.requestedBy,
      ...captureQueuedActor(input.workspaceId, ["server.remove"]),
    })
    .onConflictDoNothing()
    .returning(publicOperationSelection);
  const [operation] = created
    ? [created]
    : await database
        .select(publicOperationSelection)
        .from(resourceOperations)
        .where(
          and(
            eq(resourceOperations.workspaceId, input.workspaceId),
            eq(resourceOperations.idempotencyKey, key),
          ),
        );
  if (!operation) throw new Error("Unable to record server cleanup");
  await dispatchServerCleanups(operation.id);
  return { operation, replayed: !created };
}

// The committed operation is the outbox. Maintenance retries delivery after a crash or Temporal outage.
export async function dispatchServerCleanups(operationId?: string) {
  const database = getTowbarDatabase();
  const queued = await database
    .select()
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.type, "cleanup_orphans"),
        eq(resourceOperations.state, "queued"),
        operationId ? eq(resourceOperations.id, operationId) : undefined,
      ),
    );
  for (const operation of queued) {
    try {
      await enqueueResourceOperation({
        appId: null,
        exclusive: true,
        operationId: operation.id,
        serverIp: operation.serverSnapshot.ip,
        buildConcurrency: operation.serverSnapshot.buildConcurrency ?? 1,
      });
      await database
        .update(resourceOperations)
        .set({ errorCode: null, errorMessage: null })
        .where(
          and(
            eq(resourceOperations.id, operation.id),
            eq(resourceOperations.state, "queued"),
          ),
        );
    } catch {
      await database
        .update(resourceOperations)
        .set({
          errorCode: "TEMPORAL_UNAVAILABLE",
          errorMessage:
            "Cleanup is queued; delivery will retry when the worker queue is available.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(resourceOperations.id, operation.id),
            eq(resourceOperations.state, "queued"),
          ),
        );
    }
  }
  return queued.length;
}

export async function listServerCleanups(input: {
  serverId: string;
  workspaceId: string;
  page: number;
  limit: number;
}) {
  const where = and(
    eq(resourceOperations.serverId, input.serverId),
    eq(resourceOperations.workspaceId, input.workspaceId),
    eq(resourceOperations.type, "cleanup_orphans"),
  );
  const database = getTowbarDatabase();
  const [total] = await database
    .select({ value: count() })
    .from(resourceOperations)
    .where(where);
  const operations = await database
    .select(publicOperationSelection)
    .from(resourceOperations)
    .where(where)
    .orderBy(desc(resourceOperations.createdAt), desc(resourceOperations.id))
    .limit(input.limit)
    .offset((input.page - 1) * input.limit);
  return {
    operations,
    pagination: {
      total: total?.value ?? 0,
      page: input.page,
      limit: input.limit,
      totalPages: Math.ceil((total?.value ?? 0) / input.limit),
    },
  };
}
