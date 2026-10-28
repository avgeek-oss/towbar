import { captureQueuedActor } from "../auth/actor-context.js";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { resourceOperationWorkflowId } from "@workspace/towbar-core/temporal";
import type { apps, servers } from "@workspace/towbar-database/schema";
import { resourceOperations } from "@workspace/towbar-database/schema";

import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueueResourceOperation } from "../../infrastructure/temporal.js";
import { emitResourceOperationNotification } from "../notifications/events.js";
import { publicOperationSelection } from "./queries.js";

import type { ResourceOperationRequest } from "@workspace/towbar-core";

export async function admitOperation(input: {
  appSnapshot: (typeof apps.$inferSelect)["config"] | null;
  exclusive?: boolean;
  idempotencyKey: string;
  request: ResourceOperationRequest;
  requestedBy: string | null;
  resourceId: string | null;
  serverId: string;
  serverIp: string;
  serverSnapshot: (typeof servers.$inferSelect)["config"];
  sourceId: string | null;
  workspaceId: string;
}) {
  const scopedKey = `${input.request.type}:${input.resourceId ?? input.serverId}:${input.idempotencyKey}`;
  const [existing] = await getTowbarDatabase()
    .select(publicOperationSelection)
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.workspaceId, input.workspaceId),
        eq(resourceOperations.idempotencyKey, scopedKey),
      ),
    )
    .limit(1);
  if (existing) return { operation: existing, replayed: true };
  const id = randomUUID();
  let created;
  try {
    [created] = await getTowbarDatabase()
      .insert(resourceOperations)
      .values({
        appSnapshot: input.appSnapshot,
        id,
        idempotencyKey: scopedKey,
        phase: input.request.type === "restore" ? "queued" : null,
        request: input.request,
        requestedBy: input.requestedBy,
        ...captureQueuedActor(input.workspaceId, ["admin"]),
        resourceId: input.resourceId,
        serverId: input.serverId,
        serverSnapshot: input.serverSnapshot,
        sourceId: input.sourceId,
        temporalWorkflowId: resourceOperationWorkflowId(id),
        type: input.request.type,
        workspaceId: input.workspaceId,
      })
      .returning(publicOperationSelection);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const [replay] = await getTowbarDatabase()
        .select(publicOperationSelection)
        .from(resourceOperations)
        .where(
          and(
            eq(resourceOperations.workspaceId, input.workspaceId),
            eq(resourceOperations.idempotencyKey, scopedKey),
          ),
        )
        .limit(1);
      if (replay) return { operation: replay, replayed: true };
    }
    throw error;
  }
  if (!created) throw new Error("Unable to create Resource operation");
  try {
    await enqueueResourceOperation({
      appId: input.resourceId,
      buildConcurrency: input.serverSnapshot.buildConcurrency ?? 1,
      exclusive: input.exclusive ?? false,
      operationId: id,
      serverIp: input.serverIp,
    });
  } catch (error) {
    await getTowbarDatabase()
      .update(resourceOperations)
      .set({
        errorCode: "TEMPORAL_UNAVAILABLE",
        errorMessage: "Resource operation queue is unavailable",
        finishedAt: new Date(),
        phase: input.request.type === "restore" ? "failed" : null,
        state: "failed",
        updatedAt: new Date(),
      })
      .where(eq(resourceOperations.id, id));
    if (input.request.type === "backup") {
      await emitResourceOperationNotification(id, "backup.failed").catch(
        () => undefined,
      );
    }
    throw error;
  }
  return { operation: created, replayed: false };
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
