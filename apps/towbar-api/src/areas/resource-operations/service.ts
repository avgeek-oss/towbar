import { recordAuditEvent } from "../../infrastructure/audit.js";
import { auditAttribution } from "../auth/actor-context.js";
import { and, desc, eq, inArray, isNull, max } from "drizzle-orm";
import {
  backupOperationResultSchema,
  isNormalizedCompose,
  isNormalizedResource,
  managedResourceTypes,
  restoreOperationPhaseSchema,
  restoreOperationResultSchema,
} from "@workspace/towbar-core";
import {
  apps,
  resourceOperationEvents,
  resourceOperations,
} from "@workspace/towbar-database/schema";

import { conflict, notFound, unprocessable } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { cancelResourceOperationWorkflow } from "../../infrastructure/temporal.js";
import { emitResourceOperationNotification } from "../notifications/events.js";
import { requireBackupCredentials } from "./credentials.js";
import { admitOperation } from "./admission.js";
import { assureResourceBackup } from "./backup-assurance.js";
import {
  getDeployableTarget,
  getResourceBackupAssurance,
  listOperationEvents,
  listResourceBackupAssurances,
  publicOperationSelection,
} from "./queries.js";

export { getServerOrphans } from "./queries.js";
export { finishResourceOperation } from "./completion.js";
export {
  getOperationExecutionContext,
  resolveOperationSecrets,
} from "./execution.js";
export {
  getResourceBackupAssurance,
  listOperationEvents,
  listResourceBackupAssurances,
};

export async function listDeployableOperations(
  deployableId: string,
  workspaceId: string,
) {
  await getDeployableTarget(deployableId, workspaceId);
  return await getTowbarDatabase()
    .select(publicOperationSelection)
    .from(resourceOperations)
    .where(eq(resourceOperations.resourceId, deployableId))
    .orderBy(desc(resourceOperations.createdAt));
}

export async function hasActiveOrphanCleanup(
  serverId: string,
  workspaceId: string,
) {
  const [operation] = await getTowbarDatabase()
    .select({ id: resourceOperations.id })
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.serverId, serverId),
        eq(resourceOperations.workspaceId, workspaceId),
        eq(resourceOperations.type, "cleanup_orphans"),
        inArray(resourceOperations.state, ["queued", "running"]),
      ),
    )
    .limit(1);
  return Boolean(operation);
}

export async function listSourceBackups(sourceId: string, workspaceId: string) {
  return await getTowbarDatabase()
    .select({
      ...publicOperationSelection,
      resourceKind: apps.kind,
      resourceManifestId: apps.manifestId,
      resourceName: apps.name,
    })
    .from(resourceOperations)
    .innerJoin(apps, eq(apps.id, resourceOperations.resourceId))
    .where(
      and(
        eq(resourceOperations.sourceId, sourceId),
        eq(resourceOperations.workspaceId, workspaceId),
        eq(resourceOperations.type, "backup"),
        eq(resourceOperations.state, "succeeded"),
        isNull(resourceOperations.deletedAt),
      ),
    )
    .orderBy(desc(resourceOperations.createdAt));
}

export async function requestDeployableOperation(input: {
  deployableId: string;
  idempotencyKey: string;
  requestedBy: string | null;
  request:
    | { type: "backup" }
    | {
        runtime?: "workload" | "ingress";
        service?: string;
        tail: number;
        type: "capture_logs";
      }
    | { service?: string; type: "restart" | "start" | "stop" };
  workspaceId: string;
}) {
  const target = await getDeployableTarget(
    input.deployableId,
    input.workspaceId,
  );
  if (target.archivedAt) {
    throw conflict("Archived deployables cannot be operated");
  }
  if (
    !target.serverPreparedAt ||
    target.serverPreparedConfigDigest !== target.serverConfigDigest
  ) {
    throw conflict(
      "Prepare this server before operating apps or resources",
      "SERVER_SETUP_PENDING",
    );
  }
  if (!target.currentRelease) {
    throw unprocessable("Deploy this item before using runtime operations");
  }
  if (
    "service" in input.request &&
    input.request.service !== undefined &&
    target.config.kind !== "compose"
  ) {
    throw unprocessable(
      "A service can only be selected for a Compose workload",
      "COMPOSE_SERVICE_UNAVAILABLE",
    );
  }
  if (
    input.request.type === "capture_logs" &&
    input.request.runtime === "ingress"
  ) {
    if (input.request.service !== undefined) {
      throw unprocessable(
        "A Compose service cannot be selected for ingress log capture",
        "INGRESS_LOG_TARGET_INVALID",
      );
    }
    const hasCloudflareTunnel = isNormalizedCompose(target.config)
      ? Object.values(target.config.services).some(
          (service) => service.ingress?.type === "cloudflare-tunnel",
        )
      : target.config.ingress?.type === "cloudflare-tunnel";
    if (!hasCloudflareTunnel) {
      throw unprocessable(
        "Cloudflare Tunnel is not configured for this deployable",
        "INGRESS_LOG_TARGET_UNAVAILABLE",
      );
    }
  }
  const release = target.currentRelease;
  if (input.request.type === "backup") {
    const resource = requireBackupResource(target.config);
    await requireBackupCredentials(input.workspaceId, {
      s3: Boolean(resource.backup!.s3),
      gcs: Boolean(resource.backup!.gcs),
    });
  }
  return await admitOperation({
    appSnapshot: target.config,
    idempotencyKey: input.idempotencyKey,
    request: { ...input.request, release },
    requestedBy: input.requestedBy,
    resourceId: target.id,
    serverId: target.serverId,
    serverIp: target.serverIp,
    serverSnapshot: target.serverConfig,
    sourceId: target.sourceId,
    workspaceId: input.workspaceId,
  });
}

export async function requestResourceRestore(input: {
  backupId: string;
  confirmation: string;
  idempotencyKey: string;
  reason: string;
  requestedBy: string | null;
  resourceId: string;
  workspaceId: string;
}) {
  const target = await getDeployableTarget(input.resourceId, input.workspaceId);
  if (target.archivedAt)
    throw conflict("Archived Resources cannot be restored");
  if (
    !target.serverPreparedAt ||
    target.serverPreparedConfigDigest !== target.serverConfigDigest
  ) {
    throw conflict(
      "Prepare this server before restoring a Resource",
      "SERVER_SETUP_PENDING",
    );
  }
  const resource = requireBackupResource(target.config);
  if (
    resource.container.configFiles?.length ||
    resource.container.entrypoint !== undefined
  )
    throw unprocessable(
      "Managed restore does not yet support configuration files or entrypoint overrides; use engine-native recovery",
    );
  if (!target.currentRelease) {
    throw unprocessable("Deploy this Resource before restoring a backup");
  }
  if (input.confirmation !== resource.name) {
    throw unprocessable(
      `Type ${resource.name} exactly to confirm this destructive restore`,
      "RESTORE_CONFIRMATION_MISMATCH",
    );
  }
  const assurance = await assureResourceBackup(
    target.id,
    new Date(),
    input.backupId,
  );
  if (!assurance.restoreReady || assurance.backupId !== input.backupId) {
    throw conflict(
      "Only a retained restore-ready backup can be restored",
      "BACKUP_NOT_RESTORE_READY",
    );
  }
  const [backup] = await getTowbarDatabase()
    .select({ id: resourceOperations.id, result: resourceOperations.result })
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.id, input.backupId),
        eq(resourceOperations.resourceId, target.id),
        eq(resourceOperations.sourceId, target.sourceId),
        eq(resourceOperations.workspaceId, input.workspaceId),
        eq(resourceOperations.type, "backup"),
        eq(resourceOperations.state, "succeeded"),
        isNull(resourceOperations.deletedAt),
      ),
    )
    .limit(1);
  if (!backup) throw notFound("Retained backup");
  const storedBackup = backupOperationResultSchema.parse(backup.result);
  await requireBackupCredentials(input.workspaceId, {
    [storedBackup.restoreFrom ?? "s3"]: true,
  });
  const admitted = await admitOperation({
    appSnapshot: resource,
    idempotencyKey: input.idempotencyKey,
    request: {
      backupId: backup.id,
      reason: input.reason,
      release: target.currentRelease,
      type: "restore",
    },
    requestedBy: input.requestedBy,
    resourceId: target.id,
    serverId: target.serverId,
    serverIp: target.serverIp,
    serverSnapshot: target.serverConfig,
    sourceId: target.sourceId,
    workspaceId: input.workspaceId,
  });
  if (!admitted.replayed) {
    await recordAuditEvent(getTowbarDatabase(), {
      action: "resource.restore.requested",
      actorUserId: input.requestedBy,
      metadata: {
        backupId: backup.id,
        operationId: admitted.operation.id,
        reason: input.reason,
      },
      targetId: target.id,
      targetType: "resource",
      workspaceId: input.workspaceId,
      ...auditAttribution(),
    });
    await emitResourceOperationNotification(
      admitted.operation.id,
      "restore.started",
    ).catch(() => undefined);
  }
  return admitted;
}

export async function requestRestoreCleanup(input: {
  idempotencyKey: string;
  requestedBy: string | null;
  resourceId: string;
  restoreId: string;
  workspaceId: string;
}) {
  const target = await getDeployableTarget(input.resourceId, input.workspaceId);
  if (!target.currentRelease) throw unprocessable("Resource is not deployed");
  const [restore] = await getTowbarDatabase()
    .select({
      appSnapshot: resourceOperations.appSnapshot,
      result: resourceOperations.result,
      serverId: resourceOperations.serverId,
      serverSnapshot: resourceOperations.serverSnapshot,
      sourceId: resourceOperations.sourceId,
    })
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.id, input.restoreId),
        eq(resourceOperations.resourceId, target.id),
        eq(resourceOperations.workspaceId, input.workspaceId),
        eq(resourceOperations.type, "restore"),
        inArray(resourceOperations.state, ["failed", "succeeded"]),
      ),
    )
    .limit(1);
  if (!restore) throw notFound("Restore operation");
  const managedResult = restoreOperationResultSchema.safeParse(restore?.result);
  const retainedVolumes =
    managedResult.success &&
    ["promoted", "rolled_back"].includes(managedResult.data.outcome)
      ? managedResult.data.previousVolumes
      : [];
  const volumes = [
    ...new Map(
      retainedVolumes.map((volume) => [volume.volumeName, volume]),
    ).values(),
  ];
  if (volumes.length === 0) {
    throw conflict("This restore has no retained volumes to clean up");
  }
  const scopedKey = `restore_cleanup:${target.id}:${input.idempotencyKey}`;
  const existingCleanups = await getTowbarDatabase()
    .select({
      idempotencyKey: resourceOperations.idempotencyKey,
      request: resourceOperations.request,
      state: resourceOperations.state,
    })
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.resourceId, target.id),
        eq(resourceOperations.workspaceId, input.workspaceId),
        eq(resourceOperations.type, "restore_cleanup"),
      ),
    );
  if (
    existingCleanups.some(
      (cleanup) =>
        cleanup.idempotencyKey !== scopedKey &&
        cleanup.request.type === "restore_cleanup" &&
        cleanup.request.restoreId === input.restoreId &&
        ["queued", "running", "succeeded"].includes(cleanup.state),
    )
  ) {
    throw conflict(
      "This restore's rollback volumes are already being cleaned up",
    );
  }
  const admitted = await admitOperation({
    appSnapshot: restore.appSnapshot,
    idempotencyKey: input.idempotencyKey,
    request: {
      release: target.currentRelease,
      restoreId: input.restoreId,
      type: "restore_cleanup",
      volumes: volumes.map((volume) => volume.volumeName),
    },
    requestedBy: input.requestedBy,
    resourceId: target.id,
    serverId: restore.serverId,
    serverIp: restore.serverSnapshot.ip,
    serverSnapshot: restore.serverSnapshot,
    sourceId: restore.sourceId,
    workspaceId: input.workspaceId,
  });
  if (!admitted.replayed) {
    await recordAuditEvent(getTowbarDatabase(), {
      action: "resource.restore_cleanup.requested",
      actorUserId: input.requestedBy,
      metadata: {
        operationId: admitted.operation.id,
        restoreId: input.restoreId,
      },
      targetId: target.id,
      targetType: "resource",
      workspaceId: input.workspaceId,
      ...auditAttribution(),
    });
  }
  return admitted;
}

export async function cancelResourceRestore(input: {
  operationId: string;
  requestedBy: string | null;
  resourceId: string;
  workspaceId: string;
}) {
  const [operation] = await getTowbarDatabase()
    .select(publicOperationSelection)
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.id, input.operationId),
        eq(resourceOperations.resourceId, input.resourceId),
        eq(resourceOperations.workspaceId, input.workspaceId),
        eq(resourceOperations.type, "restore"),
      ),
    )
    .limit(1);
  if (!operation) throw notFound("Backup or restore operation");
  if (!["queued", "running"].includes(operation.state)) {
    throw conflict("This backup or restore can no longer be cancelled");
  }
  if (
    operation.type === "restore" &&
    operation.phase &&
    [
      "promoting",
      "verifying_promotion",
      "rolling_back",
      "retaining_previous",
      "succeeded",
      "failed",
      "cancelled",
    ].includes(operation.phase)
  ) {
    throw conflict(
      "Promotion has started; Towbar must finish promotion or rollback",
      "RESTORE_PROMOTION_IN_PROGRESS",
    );
  }
  if (operation.cancelRequestedAt) {
    await cancelResourceOperationWorkflow(operation.id);
    return operation;
  }
  const now = new Date();
  const [updated] = await getTowbarDatabase()
    .update(resourceOperations)
    .set({ cancelRequestedAt: now, updatedAt: now })
    .where(
      and(
        eq(resourceOperations.id, operation.id),
        isNull(resourceOperations.cancelRequestedAt),
      ),
    )
    .returning(publicOperationSelection);
  if (!updated) {
    await cancelResourceOperationWorkflow(operation.id);
    return operation;
  }
  await recordAuditEvent(getTowbarDatabase(), {
    action: "resource.restore.cancel_requested",
    actorUserId: input.requestedBy,
    metadata: { operationId: operation.id },
    targetId: input.resourceId,
    targetType: "resource",
    workspaceId: input.workspaceId,
    ...auditAttribution(),
  });
  await cancelResourceOperationWorkflow(operation.id);
  return updated;
}

export async function appendResourceOperationProgress(
  operationId: string,
  input: {
    command?: string;
    level: "error" | "info" | "success";
    message: string;
    metadata: Record<string, boolean | number | string | null>;
    phase: string;
  },
) {
  const phase = restoreOperationPhaseSchema.parse(input.phase);
  return await getTowbarDatabase().transaction(async (transaction) => {
    const [operation] = await transaction
      .select({ id: resourceOperations.id, type: resourceOperations.type })
      .from(resourceOperations)
      .where(eq(resourceOperations.id, operationId))
      .for("update")
      .limit(1);
    if (!operation || !["backup", "restore"].includes(operation.type)) {
      throw notFound("Backup or restore operation");
    }
    const [latest] = await transaction
      .select({ sequence: max(resourceOperationEvents.sequence) })
      .from(resourceOperationEvents)
      .where(eq(resourceOperationEvents.operationId, operationId));
    const sequence = (latest?.sequence ?? 0) + 1;
    const [event] = await transaction
      .insert(resourceOperationEvents)
      .values({
        command: input.command,
        level: input.level,
        message: input.message,
        metadata: input.metadata,
        operationId,
        phase,
        sequence,
      })
      .returning();
    await transaction
      .update(resourceOperations)
      .set({ phase, updatedAt: new Date() })
      .where(eq(resourceOperations.id, operationId));
    return event;
  });
}

export { requestServerCleanup as requestOrphanCleanup } from "./server-cleanup.js";

function requireDatabaseResource(config: (typeof apps.$inferSelect)["config"]) {
  if (
    !isNormalizedResource(config) ||
    !managedResourceTypes.includes(config.kind as never)
  ) {
    throw unprocessable(
      "Backups are supported only for managed database Resources",
    );
  }
  return config;
}

function requireBackupResource(config: (typeof apps.$inferSelect)["config"]) {
  const resource = requireDatabaseResource(config);
  if (!resource.backup) {
    throw unprocessable(
      "Declare a backup destination for this Resource before using backups",
    );
  }
  return resource;
}
