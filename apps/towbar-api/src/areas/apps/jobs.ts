import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  digestValue,
  digestWithoutNotificationSubscriptions,
  isNormalizedResource,
  latestAppJobOccurrence,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  releases,
  resourceOperations,
  sourceEnvironments,
  sources,
} from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { requireActor, withActor } from "../auth/actor-context.js";
import { requireActiveAutomation } from "../auth/automation-authority.js";
import { admitOperation } from "../resource-operations/admission.js";
import {
  getDeployableTarget,
  publicOperationSelection,
} from "../resource-operations/queries.js";
import type { ResourceOperationRequest } from "@workspace/towbar-core";

async function jobTarget(appId: string, workspaceId: string) {
  const target = await getDeployableTarget(appId, workspaceId);
  if (isNormalizedResource(target.config)) throw notFound("App");
  const [release] = await getTowbarDatabase()
    .select({
      config: deployments.appSnapshot,
      releasedAt: releases.promotedAt,
    })
    .from(releases)
    .innerJoin(deployments, eq(deployments.id, releases.deploymentId))
    .where(
      and(
        eq(releases.appId, appId),
        eq(releases.status, "current"),
        isNull(releases.previewEnvironmentId),
      ),
    )
    .limit(1);
  const [automation] = await getTowbarDatabase()
    .select({
      repositoryStatus: sources.status,
      repositoryPaused: sources.autoDeployPaused,
      environmentPaused: sourceEnvironments.autoDeployPaused,
      disconnectedAt: sourceEnvironments.disconnectedAt,
    })
    .from(apps)
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .where(and(eq(apps.id, appId), eq(apps.workspaceId, workspaceId)))
    .limit(1);
  const automationPaused =
    !automation ||
    automation.repositoryStatus !== "active" ||
    automation.repositoryPaused ||
    automation.environmentPaused ||
    Boolean(automation.disconnectedAt);
  const ready = Boolean(
    release &&
    !target.archivedAt &&
    target.serverPreparedAt &&
    target.serverPreparedConfigDigest === target.serverConfigDigest &&
    digestWithoutNotificationSubscriptions(release.config) ===
      digestWithoutNotificationSubscriptions(target.config),
  );
  return {
    ...target,
    automationPaused,
    ready,
    releasedAt: release?.releasedAt,
    jobs: target.config.jobs ?? [],
  };
}

export async function listAppJobs(appId: string, workspaceId: string) {
  const target = await jobTarget(appId, workspaceId);
  const runs = await getTowbarDatabase()
    .select(publicOperationSelection)
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.resourceId, appId),
        eq(resourceOperations.workspaceId, workspaceId),
        eq(resourceOperations.type, "run_job"),
      ),
    )
    .orderBy(desc(resourceOperations.createdAt))
    .limit(100);
  return {
    jobs: target.jobs,
    ready: target.ready,
    automationPaused: target.automationPaused,
    runs,
  };
}

export async function requestAppJob(input: {
  appId: string;
  workspaceId: string;
  jobName: string;
  idempotencyKey: string;
  requestedBy: string | null;
  scheduledAt?: Date;
}) {
  requireActor(input.workspaceId, ["admin"]);
  // The advisory lock serializes admission without locking the app's foreign key.
  // Admission commits before signalling Temporal, so workers can see the row.
  return await getTowbarDatabase().transaction(async (lock) => {
    await lock.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`app-job:${input.appId}:${input.jobName}`}, 0))`,
    );
    const scopedKey = `run_job:${input.appId}:${input.idempotencyKey}`;
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
    const target = await jobTarget(input.appId, input.workspaceId);
    const job = target.jobs.find((item) => item.name === input.jobName);
    if (!job) throw notFound("Scheduled job");
    if (!target.ready || !target.currentRelease)
      throw conflict(
        "Deploy the current app configuration before running jobs",
        "APP_JOB_NOT_READY",
      );
    if (!job.enabled)
      throw conflict(
        "This job is disabled in the app manifest",
        "APP_JOB_DISABLED",
      );
    if (input.scheduledAt) {
      await requireActiveAutomation({
        workspaceId: input.workspaceId,
        deployableId: input.appId,
        config: target.config,
      });
      if (!target.releasedAt || target.releasedAt > input.scheduledAt)
        throw conflict(
          "The schedule predates the current release",
          "APP_JOB_NOT_DUE",
        );
    }
    const [pending] = await getTowbarDatabase()
      .select({ id: resourceOperations.id })
      .from(resourceOperations)
      .where(
        and(
          eq(resourceOperations.resourceId, input.appId),
          eq(resourceOperations.type, "run_job"),
          inArray(resourceOperations.state, ["queued", "running"]),
          sql`${resourceOperations.request}->'job'->>'name' = ${job.name}`,
        ),
      )
      .limit(1);
    if (pending)
      throw conflict(
        "This job already has a queued or running execution",
        "APP_JOB_BUSY",
      );
    return await admitOperation({
      appSnapshot: target.config,
      idempotencyKey: input.idempotencyKey,
      request: {
        type: "run_job",
        release: target.currentRelease,
        job,
        scheduledAt: input.scheduledAt?.toISOString() ?? null,
      },
      requestedBy: input.requestedBy,
      resourceId: input.appId,
      serverId: target.serverId,
      serverIp: target.serverIp,
      serverSnapshot: target.serverConfig,
      sourceId: target.sourceId,
      workspaceId: input.workspaceId,
    });
  });
}

export async function validateQueuedAppJob(input: {
  resourceId: string | null;
  workspaceId: string;
  request: Extract<ResourceOperationRequest, { type: "run_job" }>;
}) {
  if (!input.resourceId) throw notFound("App");
  const target = await jobTarget(input.resourceId, input.workspaceId);
  const current = target.jobs.find(
    (job) => job.name === input.request.job.name,
  );
  if (
    !target.ready ||
    !current?.enabled ||
    digestValue(current) !== digestValue(input.request.job) ||
    target.currentRelease?.releaseId !== input.request.release.releaseId
  )
    throw conflict(
      "The app release or job configuration changed while this run was queued",
      "APP_JOB_STALE",
    );
  if (input.request.scheduledAt)
    await requireActiveAutomation({
      workspaceId: input.workspaceId,
      deployableId: input.resourceId,
      config: target.config,
    });
}

export async function queueScheduledAppJobs(now = new Date()) {
  const targets = await getTowbarDatabase()
    .select({ id: apps.id, workspaceId: apps.workspaceId, config: apps.config })
    .from(apps)
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .where(
      and(
        eq(apps.kind, "app"),
        isNull(apps.archivedAt),
        eq(sources.status, "active"),
        eq(sources.autoDeployPaused, false),
        eq(sourceEnvironments.autoDeployPaused, false),
        isNull(sourceEnvironments.disconnectedAt),
      ),
    );
  let queued = 0;
  let skipped = 0;
  for (const target of targets) {
    if (isNormalizedResource(target.config)) continue;
    for (const job of target.config.jobs ?? []) {
      const occurrence = latestAppJobOccurrence(job, now);
      if (!occurrence) continue;
      try {
        const result = await withActor(
          {
            kind: "system",
            source: "worker",
            workspaceId: target.workspaceId,
            grants: ["admin"],
          },
          () =>
            requestAppJob({
              appId: target.id,
              workspaceId: target.workspaceId,
              jobName: job.name,
              idempotencyKey: `job:${job.name}:${occurrence.toISOString()}`,
              requestedBy: null,
              scheduledAt: occurrence,
            }),
        );
        if (!result.replayed) queued += 1;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "status" in error &&
          [403, 404, 409].includes(Number(error.status))
        )
          skipped += 1;
        else throw error;
      }
    }
  }
  return { queued, skipped };
}
