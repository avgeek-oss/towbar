import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  resourceOperationWorkflowId,
  terminalDeploymentStates,
} from "@workspace/towbar-core/temporal";
import {
  apps,
  deployments,
  resourceOperations,
  serverDeployableOwnership,
  servers,
} from "@workspace/towbar-database/schema";
import { badRequest, conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { recordAuditEvent } from "../../infrastructure/audit.js";
import { auditAttribution, captureQueuedActor } from "../auth/actor-context.js";
import {
  lockDomainClaims,
  synchronizeDomainClaims,
} from "../deployments/domain-claims.js";
import {
  assertNoRunningCleanup,
  dispatchServerCleanups,
} from "../resource-operations/server-cleanup.js";
import { loadManifestRegistry } from "./reconcile.js";
import type { SecretDatabase } from "../secrets/store.js";

export async function removeRetiredWorkload(
  input: {
    workspaceId: string;
    workloadId: string;
    expectedRevision: string;
    confirmManifestId: string;
    reason: string;
    idempotencyKey: string;
    requestedBy: string | null;
  },
  dispatch = dispatchServerCleanups,
) {
  if (!input.idempotencyKey.trim())
    throw badRequest("An Idempotency-Key header is required.");
  const key = `retire:${input.workloadId}:${input.idempotencyKey}`;
  const operations = await getTowbarDatabase().transaction(async (database) => {
    await lockDomainClaims(database, input.workspaceId);
    const previous = await database
      .select({
        id: resourceOperations.id,
        request: resourceOperations.request,
      })
      .from(resourceOperations)
      .where(
        and(
          eq(resourceOperations.workspaceId, input.workspaceId),
          eq(resourceOperations.idempotencyKey, key),
        ),
      );
    if (previous.length) {
      const all = await database
        .select({
          id: resourceOperations.id,
          request: resourceOperations.request,
        })
        .from(resourceOperations)
        .where(eq(resourceOperations.workspaceId, input.workspaceId));
      return all.filter(
        (operation) =>
          operation.request.type === "cleanup_orphans" &&
          operation.request.retirementAttemptId === key,
      );
    }
    await assertNoRunningCleanup(database, input.workspaceId);
    const registry = await loadManifestRegistry(database, input.workspaceId);
    const workload = registry.instances.find(
      ({ app }) => app.id === input.workloadId,
    );
    if (!workload) throw notFound("Retired workload");
    const { app, environment } = workload;
    if (
      !["retired", "removing"].includes(app.manifestState) ||
      registry.declarations.some(
        (d) => d.environment === environment && d.config.id === app.manifestId,
      )
    )
      throw conflict(
        "A repository still declares this workload. Correct Git and sync before removing it.",
        "WORKLOAD_STILL_DECLARED",
      );
    if (
      app.updatedAt.toISOString() !== input.expectedRevision ||
      input.confirmManifestId !== app.manifestId
    )
      throw conflict(
        "The retirement changed. Refresh and confirm its manifest ID again.",
        "RETIREMENT_CHANGED",
      );
    const history = await database
      .select()
      .from(deployments)
      .where(eq(deployments.appId, app.id));
    const pending = await database
      .select()
      .from(resourceOperations)
      .where(
        and(
          eq(resourceOperations.workspaceId, input.workspaceId),
          inArray(resourceOperations.state, ["queued", "running"]),
        ),
      );
    if (
      history.some((d) => !terminalDeploymentStates.has(d.state)) ||
      pending.some(
        (o) =>
          o.resourceId === app.id ||
          (o.request.type === "cleanup_orphans" &&
            o.request.retirementId === app.id),
      )
    )
      throw conflict(
        "Wait for active workload operations to finish before removing it.",
        "WORKLOAD_BUSY",
      );
    const ownership = await database
      .select()
      .from(serverDeployableOwnership)
      .where(eq(serverDeployableOwnership.deployableId, app.id));
    const serverIds = [
      ...new Set([
        app.serverId,
        ...history.flatMap((d) => [
          d.serverId,
          ...(d.buildServerId ? [d.buildServerId] : []),
        ]),
        ...ownership.map((o) => o.serverId),
      ]),
    ];
    const hosts = await database
      .select()
      .from(servers)
      .where(
        and(
          eq(servers.workspaceId, input.workspaceId),
          inArray(servers.id, serverIds),
        ),
      );
    if (hosts.length !== serverIds.length || hosts.some((s) => s.archivedAt))
      throw conflict(
        "Register all servers that hold this workload before removing it.",
        "SERVER_UNAVAILABLE",
      );
    await database
      .update(apps)
      .set({
        manifestState: "removing",
        archivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(apps.id, app.id));
    await synchronizeDomainClaims(database, input.workspaceId, {
      sourceEnvironmentId: app.sourceEnvironmentId,
    });
    const ids: {
      id: string;
      request: typeof resourceOperations.$inferSelect.request;
    }[] = [];
    for (const [index, server] of hosts.entries()) {
      const id = randomUUID();
      const [operation] = await database
        .insert(resourceOperations)
        .values({
          id,
          workspaceId: input.workspaceId,
          serverId: server.id,
          serverSnapshot: server.config,
          type: "cleanup_orphans",
          request: {
            type: "cleanup_orphans",
            items: [],
            trigger: "manual",
            retirementId: app.id,
            retirementAttemptId: key,
          },
          idempotencyKey: index === 0 ? key : `${key}:${server.id}`,
          temporalWorkflowId: resourceOperationWorkflowId(id),
          requestedBy: input.requestedBy,
          ...captureQueuedActor(input.workspaceId, ["server.remove"]),
        })
        .returning({
          id: resourceOperations.id,
          request: resourceOperations.request,
        });
      if (operation) ids.push(operation);
    }
    await recordAuditEvent(database, {
      workspaceId: input.workspaceId,
      actorUserId: input.requestedBy,
      action: "workload.retirement.removal_requested",
      targetType: "app",
      targetId: app.id,
      metadata: {
        reason: input.reason,
        manifestId: app.manifestId,
        operationCount: ids.length,
      },
      ...auditAttribution(),
    });
    return ids;
  });
  for (const operation of operations) await dispatch(operation.id);
  return { operations: operations.map(({ id }) => ({ id })) };
}

export async function finalizeRetirement(
  database: SecretDatabase,
  operation: typeof resourceOperations.$inferSelect,
) {
  if (
    operation.request.type !== "cleanup_orphans" ||
    !operation.request.retirementId
  )
    return;
  const { retirementId, retirementAttemptId } = operation.request;
  const attempts = await database
    .select()
    .from(resourceOperations)
    .where(eq(resourceOperations.workspaceId, operation.workspaceId));
  const group = attempts.filter(
    (o) =>
      o.request.type === "cleanup_orphans" &&
      o.request.retirementAttemptId === retirementAttemptId,
  );
  if (
    group.length &&
    group.every(
      (o) =>
        o.state === "succeeded" &&
        o.result &&
        "retiredDeployableIds" in o.result &&
        o.result.retiredDeployableIds?.includes(retirementId),
    )
  ) {
    await database
      .update(apps)
      .set({ manifestState: "removed", updatedAt: new Date() })
      .where(
        and(eq(apps.id, retirementId), eq(apps.manifestState, "removing")),
      );
  }
}
