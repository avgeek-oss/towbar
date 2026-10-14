import { dispatchServerCleanups } from "./server-cleanup.js";
import { ensureAnalyticsWorkflow } from "../../infrastructure/temporal.js";
import { wakeAppJobsWorkflow } from "../../infrastructure/temporal.js";
import { enqueueDueTransactionalEmails } from "../team/email-delivery.js";
import { withActor } from "../auth/actor-context.js";
import { recoverMonitoringOperations } from "../monitoring/lifecycle.js";
import { maintainMonitoringMetrics } from "../monitoring/retention.js";
import { maintainScoutAlertHistory } from "../monitoring/alert-retention.js";
import { wakeScoutAlertsWorkflow } from "../../infrastructure/temporal.js";
import { and, desc, eq, gte, inArray, isNull, notInArray } from "drizzle-orm";

import {
  getLatestBackupScheduleOccurrence,
  isNormalizedResource,
  restoreOperationResultSchema,
} from "@workspace/towbar-core";
import { terminalDeploymentStates } from "@workspace/towbar-core/temporal";
import type { CheckStatus } from "@workspace/towbar-database/schema";
import {
  apps,
  deployments,
  resourceOperations,
  serverChecks,
  serverPreparations,
  servers,
  sourceEnvironments,
  sources,
} from "@workspace/towbar-database/schema";

import { getTowbarDatabase } from "../../infrastructure/database.js";
import { requestServerCheck } from "../servers/service.js";
import { recoverInterruptedServerChecks } from "../servers/checks.js";
import { recoverPreviewReporting } from "../previews/reporting-retry.js";
import { requestExpiredPreviewCleanups } from "../previews/cleanup.js";
import { enqueueDueNotificationDeliveries } from "../notifications/delivery-service.js";
import { emitBackupStaleNotification } from "../notifications/events.js";
import {
  requestDeployableOperation,
  requestRestoreCleanup,
} from "./service.js";
import { assureConfiguredResourceBackups } from "./backup-assurance.js";
import { admitResumedAutomaticDeployments } from "../apps/automatic-deployments.js";
import { enqueueDueVulnerabilityScans } from "../vulnerability-scans/service.js";

export async function runMaintenanceSweep() {
  // Retry startup after a Temporal outage; the dedicated Scout loop has its own cadence.
  await wakeScoutAlertsWorkflow().catch(() => undefined);
  await ensureAnalyticsWorkflow().catch(() => undefined);
  await wakeAppJobsWorkflow().catch(() => undefined);
  // Scheduled deployable work has priority; health checks are maintenance and
  // should enter a server coordinator only after its queue becomes idle.
  const serverCleanupsQueued = await dispatchServerCleanups();
  const automaticDeploymentsQueued = await admitResumedAutomaticDeployments();
  const backupsQueued = await queueScheduledBackups();
  const backupsAssured = await assureConfiguredResourceBackups();
  const restoreCleanupsQueued = await queueExpiredRestoreCleanups();
  const previewCleanupsQueued = await requestExpiredPreviewCleanups();
  const previewReporting = await recoverPreviewReporting();
  const transactionalEmailsQueued = await enqueueDueTransactionalEmails();
  const notificationDeliveriesQueued = await enqueueDueNotificationDeliveries();
  const vulnerabilityScansQueued = await enqueueDueVulnerabilityScans();
  const checksRecovered = await recoverInterruptedServerChecks();
  const activeServers = await getTowbarDatabase()
    .select({
      id: servers.id,
      workspaceId: servers.workspaceId,
    })
    .from(servers)
    .where(isNull(servers.archivedAt));
  let checksQueued = 0;
  for (const server of activeServers) {
    const [latest] = await getTowbarDatabase()
      .select({
        createdAt: serverChecks.createdAt,
        status: serverChecks.status,
      })
      .from(serverChecks)
      .where(eq(serverChecks.serverId, server.id))
      .orderBy(desc(serverChecks.createdAt))
      .limit(1);
    if (
      shouldQueueMaintenanceServerCheck({
        hasPendingServerWork: await hasPendingServerWork(server.id),
        latestCheck: latest,
        now: new Date(),
      })
    ) {
      const queued = await withActor(
        {
          kind: "system",
          source: "worker",
          workspaceId: server.workspaceId,
          grants: ["server.credentials"],
        },
        () =>
          requestServerCheck({
            requestedBy: null,
            serverId: server.id,
            workspaceId: server.workspaceId,
          }),
      ).catch(() => undefined);
      if (queued) checksQueued += 1;
    }
  }

  const monitoring = await maintainMonitoringMetrics();
  const scoutAlerts = await maintainScoutAlertHistory();
  const monitoringOperations = await recoverMonitoringOperations().catch(
    () => 0,
  );
  return {
    serverCleanupsQueued,
    monitoring,
    scoutAlerts,
    monitoringOperations,
    automaticDeploymentsQueued,
    backupsAssured,
    backupsQueued,
    checksQueued,
    checksRecovered,
    notificationDeliveriesQueued,
    transactionalEmailsQueued,
    previewCleanupsQueued,
    previewReporting,
    restoreCleanupsQueued,
    vulnerabilityScansQueued,
  };
}

async function queueExpiredRestoreCleanups() {
  const completedRestores = await getTowbarDatabase()
    .select({
      id: resourceOperations.id,
      resourceId: resourceOperations.resourceId,
      result: resourceOperations.result,
      workspaceId: resourceOperations.workspaceId,
    })
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.type, "restore"),
        eq(resourceOperations.state, "succeeded"),
        isNull(resourceOperations.deletedAt),
      ),
    );
  const now = Date.now();
  let queued = 0;
  for (const restore of completedRestores) {
    if (!restore.resourceId) continue;
    const result = restoreOperationResultSchema.safeParse(restore.result);
    if (
      !result.success ||
      result.data.previousVolumes.length === 0 ||
      !result.data.rollbackAvailableUntil ||
      new Date(result.data.rollbackAvailableUntil).getTime() > now
    ) {
      continue;
    }
    await withActor(
      {
        kind: "system",
        source: "worker",
        workspaceId: restore.workspaceId,
        grants: ["resource.restore"],
      },
      () =>
        requestRestoreCleanup({
          idempotencyKey: `expired-restore-cleanup:${restore.id}`,
          requestedBy: null,
          resourceId: restore.resourceId!,
          restoreId: restore.id,
          workspaceId: restore.workspaceId,
        }),
    )
      .then((admission) => {
        if (!admission.replayed) queued += 1;
      })
      .catch(() => undefined);
  }
  return queued;
}

async function queueScheduledBackups() {
  const resources = await getTowbarDatabase()
    .select({ id: apps.id, config: apps.config, workspaceId: apps.workspaceId })
    .from(apps)
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .where(
      and(
        isNull(apps.archivedAt),
        eq(sources.status, "active"),
        eq(sources.autoDeployPaused, false),
        eq(sourceEnvironments.autoDeployPaused, false),
        isNull(sourceEnvironments.disconnectedAt),
      ),
    );
  let backupsQueued = 0;
  const now = new Date();
  for (const resource of resources) {
    if (!isNormalizedResource(resource.config)) continue;
    const schedule = resource.config.backup?.schedule;
    if (!schedule) continue;
    const occurrence = getLatestBackupScheduleOccurrence(schedule.cron, now);
    if (!occurrence) continue;
    await withActor(
      {
        kind: "system",
        source: "worker",
        workspaceId: resource.workspaceId,
        grants: ["resource.backup"],
      },
      () =>
        requestDeployableOperation({
          deployableId: resource.id,
          idempotencyKey: `scheduled-backup:${resource.id}:${occurrence.toISOString()}`,
          requestedBy: null,
          request: { type: "backup" },
          workspaceId: resource.workspaceId,
        }),
    )
      .then((result) => {
        if (!result.replayed) backupsQueued += 1;
      })
      .catch(() => undefined);
    if (now.getTime() - occurrence.getTime() >= 2 * 60 * 60_000) {
      const [successfulBackup] = await getTowbarDatabase()
        .select({ id: resourceOperations.id })
        .from(resourceOperations)
        .where(
          and(
            eq(resourceOperations.resourceId, resource.id),
            eq(resourceOperations.type, "backup"),
            eq(resourceOperations.state, "succeeded"),
            gte(resourceOperations.createdAt, occurrence),
          ),
        )
        .limit(1);
      if (!successfulBackup) {
        await emitBackupStaleNotification({
          occurrence,
          resourceId: resource.id,
        }).catch(() => undefined);
      }
    }
  }
  return backupsQueued;
}

async function hasPendingServerWork(serverId: string) {
  const database = getTowbarDatabase();
  const [activeDeployments, activeOperations, activePreparations] =
    await Promise.all([
      database
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.serverId, serverId),
            notInArray(deployments.state, [...terminalDeploymentStates]),
          ),
        )
        .limit(1),
      database
        .select({ id: resourceOperations.id })
        .from(resourceOperations)
        .where(
          and(
            eq(resourceOperations.serverId, serverId),
            inArray(resourceOperations.state, ["queued", "running"]),
          ),
        )
        .limit(1),
      database
        .select({ id: serverPreparations.id })
        .from(serverPreparations)
        .where(
          and(
            eq(serverPreparations.serverId, serverId),
            inArray(serverPreparations.status, ["queued", "running"]),
          ),
        )
        .limit(1),
    ]);
  return Boolean(
    activeDeployments[0] || activeOperations[0] || activePreparations[0],
  );
}

export function shouldQueueMaintenanceServerCheck(input: {
  hasPendingServerWork: boolean;
  latestCheck: { createdAt: Date; status: CheckStatus } | undefined;
  now: Date;
}) {
  if (input.hasPendingServerWork) return false;
  if (!input.latestCheck) return true;
  if (["queued", "running"].includes(input.latestCheck.status)) return false;
  return (
    input.now.getTime() - input.latestCheck.createdAt.getTime() >= 5 * 60_000
  );
}
