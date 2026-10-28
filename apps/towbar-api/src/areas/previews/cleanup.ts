import {
  type QueuedActor,
  authorizeQueuedEffect,
  captureQueuedActor,
} from "../auth/actor-context.js";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { isNormalizedResource } from "@workspace/towbar-core";
import {
  apps,
  deployments,
  previewEnvironments,
  releases,
  servers,
  sourceEnvironments,
  sources,
  sshHostKeys,
} from "@workspace/towbar-database/schema";

import { conflict } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueuePreviewCleanup } from "../../infrastructure/temporal.js";
import {
  resolveDeploymentCloudflareSecret,
  resolveDeploymentCloudflareTunnelSecret,
  resolveDeploymentLogin,
} from "../deployments/service.js";
import {
  propagatePreviewDeploymentState,
  publishPreviewDeploymentStatus,
} from "../deployments/preview-status.js";
import { emitPreviewNotification } from "../notifications/events.js";
import {
  enqueueClaimedPreviewCleanups,
  previewCleanupAdmissionFailureMessage,
} from "./cleanup-admission.js";
import { nextPreviewCleanupAttemptAt } from "./cleanup-retry.js";
import {
  publishPreviewPullRequestComment,
  publishPreviewPullRequestCommentForEnvironment,
} from "./pr-comment.js";

function automaticCleanupAuthority(source: "github" | "worker") {
  return sql<QueuedActor>`jsonb_build_object('kind', 'system', 'source', ${source}::text, 'workspaceId', ${previewEnvironments.workspaceId}, 'grants', jsonb_build_array('workload.operate'))`;
}

function repositoryCleanupAuthority() {
  return sql<QueuedActor>`jsonb_build_object(
    'kind', 'system',
    'source', (select ${sources.provider} from ${sources} where ${sources.id} = ${previewEnvironments.sourceId}),
    'workspaceId', ${previewEnvironments.workspaceId},
    'grants', jsonb_build_array('workload.operate')
  )`;
}

const cleanablePreviewStatuses = [
  "building",
  "healthy",
  "failed",
  "cleanup_failed",
] satisfies Array<(typeof previewEnvironments.$inferSelect)["status"]>;

export async function requestPreviewPullRequestCleanup(input: {
  pullRequestNumber: number;
  reason: string;
  sourceId: string;
}) {
  const now = new Date();
  const environments = await getTowbarDatabase()
    .update(previewEnvironments)
    .set({
      cleanupRequestedByActor: repositoryCleanupAuthority(),
      cleanupStartedAt: null,
      cleanupAttempts: sql`${previewEnvironments.cleanupAttempts} + 1`,
      errorMessage: input.reason,
      lastCleanupAttemptAt: now,
      nextCleanupAttemptAt: null,
      status: "deleting",
      updatedAt: now,
    })
    .where(
      and(
        eq(previewEnvironments.sourceId, input.sourceId),
        eq(previewEnvironments.pullRequestNumber, input.pullRequestNumber),
        inArray(previewEnvironments.status, cleanablePreviewStatuses),
      ),
    )
    .returning({
      appId: previewEnvironments.appId,
      id: previewEnvironments.id,
      serverId: previewEnvironments.serverId,
    });
  await queuePreviewCleanup(environments, input.reason);
  await publishPreviewPullRequestComment({
    pullRequestNumber: input.pullRequestNumber,
    sourceId: input.sourceId,
  }).catch(() => undefined);
  return {
    cleanupIds: environments.map((environment) => environment.id),
    deploymentIds: [],
  };
}

export async function requestObsoletePreviewCleanups(input: {
  appIds: string[];
  pullRequestNumber: number;
  sourceId: string;
}) {
  if (input.appIds.length === 0) return { cleanupIds: [] as string[] };
  const now = new Date();
  const reason =
    "This app is no longer eligible for the pull request target or configuration";
  const environments = await getTowbarDatabase()
    .update(previewEnvironments)
    .set({
      cleanupRequestedByActor: repositoryCleanupAuthority(),
      cleanupStartedAt: null,
      cleanupAttempts: sql`${previewEnvironments.cleanupAttempts} + 1`,
      errorMessage: reason,
      lastCleanupAttemptAt: now,
      nextCleanupAttemptAt: null,
      status: "deleting",
      updatedAt: now,
    })
    .where(
      and(
        eq(previewEnvironments.sourceId, input.sourceId),
        eq(previewEnvironments.pullRequestNumber, input.pullRequestNumber),
        inArray(previewEnvironments.appId, input.appIds),
        inArray(previewEnvironments.status, cleanablePreviewStatuses),
      ),
    )
    .returning({
      appId: previewEnvironments.appId,
      id: previewEnvironments.id,
      serverId: previewEnvironments.serverId,
    });
  await queuePreviewCleanup(environments, reason);
  await publishPreviewPullRequestComment({
    pullRequestNumber: input.pullRequestNumber,
    sourceId: input.sourceId,
  }).catch(() => undefined);
  return {
    cleanupIds: environments.map((environment) => environment.id),
  };
}

export async function requestPreviewEnvironmentCleanup(input: {
  previewEnvironmentId: string;
  reason?: string;
  workspaceId: string;
}) {
  const now = new Date();
  const environments = await getTowbarDatabase()
    .update(previewEnvironments)
    .set({
      cleanupRequestedByActor: captureQueuedActor(input.workspaceId, [
        "workload.operate",
      ]).requestedByActor,
      cleanupStartedAt: null,
      cleanupAttempts: sql`${previewEnvironments.cleanupAttempts} + 1`,
      lastCleanupAttemptAt: now,
      nextCleanupAttemptAt: null,
      status: "deleting",
      updatedAt: now,
    })
    .where(
      and(
        eq(previewEnvironments.id, input.previewEnvironmentId),
        eq(previewEnvironments.workspaceId, input.workspaceId),
        inArray(previewEnvironments.status, cleanablePreviewStatuses),
      ),
    )
    .returning({
      appId: previewEnvironments.appId,
      id: previewEnvironments.id,
      pullRequestNumber: previewEnvironments.pullRequestNumber,
      serverId: previewEnvironments.serverId,
      sourceId: previewEnvironments.sourceId,
    });
  await queuePreviewCleanup(
    environments,
    input.reason ?? "Preview cleanup was requested",
  );
  await publishPreviewCommentGroups(environments);
  return { accepted: environments.length > 0 };
}

export async function requestExpiredPreviewCleanups(now = new Date()) {
  const environments = await getTowbarDatabase()
    .update(previewEnvironments)
    .set({
      cleanupRequestedByActor: sql`case when ${previewEnvironments.status} = 'cleanup_failed' then ${previewEnvironments.cleanupRequestedByActor} else ${automaticCleanupAuthority("worker")} end`,
      cleanupStartedAt: null,
      cleanupAttempts: sql`${previewEnvironments.cleanupAttempts} + 1`,
      lastCleanupAttemptAt: now,
      nextCleanupAttemptAt: null,
      status: "deleting",
      updatedAt: now,
    })
    .where(
      or(
        and(
          lt(previewEnvironments.expiresAt, now),
          inArray(previewEnvironments.status, [
            "building",
            "healthy",
            "failed",
          ]),
        ),
        and(
          eq(previewEnvironments.status, "cleanup_failed"),
          or(
            isNull(previewEnvironments.nextCleanupAttemptAt),
            lte(previewEnvironments.nextCleanupAttemptAt, now),
          ),
        ),
      ),
    )
    .returning({
      appId: previewEnvironments.appId,
      id: previewEnvironments.id,
      pullRequestNumber: previewEnvironments.pullRequestNumber,
      serverId: previewEnvironments.serverId,
      sourceId: previewEnvironments.sourceId,
    });
  await queuePreviewCleanup(environments, "The Preview deployment expired");
  await publishPreviewCommentGroups(environments);
  return environments.length;
}

export async function requestDisabledPreviewCleanups(
  sourceId: string,
  environmentId: string,
) {
  const now = new Date();
  const activeEnvironments = await getTowbarDatabase()
    .select({
      appId: previewEnvironments.appId,
      archivedAt: apps.archivedAt,
      config: apps.config,
      id: previewEnvironments.id,
      serverId: previewEnvironments.serverId,
    })
    .from(previewEnvironments)
    .innerJoin(apps, eq(apps.id, previewEnvironments.appId))
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .where(
      and(
        eq(previewEnvironments.sourceId, sourceId),
        eq(sourceEnvironments.id, environmentId),
        eq(sourceEnvironments.autoDeployPaused, false),
        isNull(sourceEnvironments.disconnectedAt),
        eq(sources.autoDeployPaused, false),
        inArray(previewEnvironments.status, cleanablePreviewStatuses),
      ),
    );
  const cleanups = [];
  for (const environment of activeEnvironments) {
    if (
      !isNormalizedResource(environment.config) &&
      !environment.archivedAt &&
      environment.config.preview?.enabled === true
    ) {
      continue;
    }
    const [claimed] = await getTowbarDatabase()
      .update(previewEnvironments)
      .set({
        cleanupRequestedByActor: automaticCleanupAuthority("github"),
        cleanupStartedAt: null,
        cleanupAttempts: sql`${previewEnvironments.cleanupAttempts} + 1`,
        lastCleanupAttemptAt: now,
        nextCleanupAttemptAt: null,
        status: "deleting",
        updatedAt: now,
      })
      .where(
        and(
          eq(previewEnvironments.id, environment.id),
          inArray(previewEnvironments.status, cleanablePreviewStatuses),
        ),
      )
      .returning({
        appId: previewEnvironments.appId,
        id: previewEnvironments.id,
        pullRequestNumber: previewEnvironments.pullRequestNumber,
        serverId: previewEnvironments.serverId,
        sourceId: previewEnvironments.sourceId,
      });
    if (claimed) cleanups.push(claimed);
  }
  await queuePreviewCleanup(cleanups, "Preview deployments were disabled");
  await publishPreviewCommentGroups(cleanups);
  return cleanups.length;
}

async function queuePreviewCleanup(
  environments: Array<{ appId: string; id: string; serverId: string }>,
  reason: string,
) {
  if (environments.length > 0) {
    const ids = environments.map((environment) => environment.id);
    const now = new Date();
    const skippedDeployments = await getTowbarDatabase()
      .update(deployments)
      .set({
        errorCode: "PREVIEW_DELETED",
        errorMessage: reason,
        finishedAt: now,
        state: "skipped",
        updatedAt: now,
      })
      .where(
        and(
          inArray(deployments.previewEnvironmentId, ids),
          eq(deployments.state, "queued"),
        ),
      )
      .returning({ id: deployments.id });
    await Promise.all(
      skippedDeployments.map((deployment) =>
        propagatePreviewDeploymentState(deployment.id, "skipped"),
      ),
    );
  }
  const serverRows = environments.length
    ? await getTowbarDatabase()
        .select({
          config: servers.config,
          id: servers.id,
          ip: servers.canonicalIp,
        })
        .from(servers)
        .where(
          inArray(
            servers.id,
            environments.map((environment) => environment.serverId),
          ),
        )
    : [];
  const serverById = new Map(
    serverRows.map((server) => [
      server.id,
      {
        buildConcurrency: server.config.buildConcurrency ?? 1,
        ip: server.ip,
        previewBuildConcurrency: server.config.previewBuildConcurrency ?? 1,
      },
    ]),
  );
  await enqueueClaimedPreviewCleanups({
    enqueue: async (environment, server) => {
      await enqueuePreviewCleanup({
        appId: environment.appId,
        buildConcurrency: server.buildConcurrency,
        previewBuildConcurrency: server.previewBuildConcurrency,
        previewEnvironmentId: environment.id,
        serverIp: server.ip,
      });
    },
    environments,
    markFailed: markPreviewCleanupAdmissionFailed,
    serverById,
  });
}

async function markPreviewCleanupAdmissionFailed(
  environment: { id: string },
  error: unknown,
) {
  const [preview] = await getTowbarDatabase()
    .select({ cleanupAttempts: previewEnvironments.cleanupAttempts })
    .from(previewEnvironments)
    .where(eq(previewEnvironments.id, environment.id))
    .limit(1);
  const now = new Date();
  await getTowbarDatabase()
    .update(previewEnvironments)
    .set({
      errorMessage: previewCleanupAdmissionFailureMessage(error),
      nextCleanupAttemptAt: nextPreviewCleanupAttemptAt(
        preview?.cleanupAttempts ?? 1,
        now,
      ),
      status: "cleanup_failed",
      updatedAt: now,
    })
    .where(
      and(
        eq(previewEnvironments.id, environment.id),
        eq(previewEnvironments.status, "deleting"),
      ),
    );
  await publishPreviewPullRequestCommentForEnvironment(environment.id).catch(
    () => undefined,
  );
}

export async function getPreviewCleanupContext(previewEnvironmentId: string) {
  const [environment] = await getTowbarDatabase()
    .select({
      status: previewEnvironments.status,
      workspaceId: previewEnvironments.workspaceId,
      cleanupRequestedByActor: previewEnvironments.cleanupRequestedByActor,
      cleanupStartedAt: previewEnvironments.cleanupStartedAt,
      cleanupAttempt: previewEnvironments.cleanupAttempts,
      hostname: previewEnvironments.hostname,
      id: previewEnvironments.id,
      latestDeploymentId: previewEnvironments.latestDeploymentId,
      runtimeId: previewEnvironments.runtimeId,
      server: servers.config,
      serverId: servers.id,
    })
    .from(previewEnvironments)
    .innerJoin(servers, eq(servers.id, previewEnvironments.serverId))
    .where(eq(previewEnvironments.id, previewEnvironmentId))
    .limit(1);
  if (!environment) throw new Error("Preview environment was not found");
  if (environment.status !== "deleting")
    throw conflict("Preview is not awaiting cleanup", "PREVIEW_CLEANUP_STALE");
  if (!environment.cleanupStartedAt) {
    await authorizeQueuedEffect(
      environment.cleanupRequestedByActor,
      environment.workspaceId,
      ["workload.operate"],
    );
    await getTowbarDatabase()
      .update(previewEnvironments)
      .set({ cleanupStartedAt: new Date() })
      .where(
        and(
          eq(previewEnvironments.id, environment.id),
          eq(previewEnvironments.cleanupAttempts, environment.cleanupAttempt),
          eq(previewEnvironments.status, "deleting"),
        ),
      );
  }
  const [releaseRows, trustedHostKeys] = await Promise.all([
    getTowbarDatabase()
      .select({
        containerName: releases.containerName,
        imageTag: releases.imageTag,
      })
      .from(releases)
      .where(
        and(
          eq(releases.previewEnvironmentId, previewEnvironmentId),
          inArray(releases.status, ["current", "previous"]),
        ),
      ),
    getTowbarDatabase()
      .select({
        algorithm: sshHostKeys.algorithm,
        fingerprint: sshHostKeys.fingerprint,
        publicKey: sshHostKeys.publicKey,
      })
      .from(sshHostKeys)
      .where(
        and(
          eq(sshHostKeys.serverId, environment.serverId),
          isNull(sshHostKeys.revokedAt),
        ),
      ),
  ]);
  return {
    cleanupAttempt: environment.cleanupAttempt,
    context: {
      containerNames: releaseRows.map((release) => release.containerName),
      hostname: environment.hostname,
      imageTags: releaseRows.map((release) => release.imageTag),
      previewEnvironmentId: environment.id,
      runtimeId: environment.runtimeId,
      server: environment.server,
      trustedHostKeys,
    },
    latestDeploymentId: environment.latestDeploymentId,
  };
}

export async function resolvePreviewCleanupSecrets(
  previewEnvironmentId: string,
) {
  const cleanup = await getPreviewCleanupContext(previewEnvironmentId);
  if (!cleanup.latestDeploymentId) {
    throw new Error("Preview environment has no deployment snapshot");
  }
  const [login, cloudflare, cloudflareTunnel] = await Promise.all([
    resolveDeploymentLogin(cleanup.latestDeploymentId),
    resolveDeploymentCloudflareSecret(cleanup.latestDeploymentId),
    resolveDeploymentCloudflareTunnelSecret(cleanup.latestDeploymentId),
  ]);
  return { cloudflare, cloudflareTunnel, login };
}

export async function recordPreviewCleanupResult(
  previewEnvironmentId: string,
  input: { cleanupAttempt: number; errorMessage?: string; succeeded: boolean },
) {
  const now = new Date();
  const environment = await getTowbarDatabase().transaction(
    async (transaction) => {
      const [updated] = await transaction
        .update(previewEnvironments)
        .set({
          deletedAt: input.succeeded ? now : null,
          errorMessage: input.errorMessage?.slice(0, 1_000) ?? null,
          nextCleanupAttemptAt: input.succeeded
            ? null
            : nextPreviewCleanupAttemptAt(input.cleanupAttempt, now),
          status: input.succeeded ? "deleted" : "cleanup_failed",
          updatedAt: now,
        })
        .where(
          and(
            eq(previewEnvironments.id, previewEnvironmentId),
            eq(previewEnvironments.status, "deleting"),
            eq(previewEnvironments.cleanupAttempts, input.cleanupAttempt),
          ),
        )
        .returning({
          latestDeploymentId: previewEnvironments.latestDeploymentId,
          pullRequestNumber: previewEnvironments.pullRequestNumber,
          sourceId: previewEnvironments.sourceId,
        });
      if (!updated) return null;
      if (input.succeeded) {
        await transaction
          .update(releases)
          .set({ status: "superseded", supersededAt: now })
          .where(eq(releases.previewEnvironmentId, previewEnvironmentId));
      }
      return updated;
    },
  );
  if (!environment) return { accepted: false };
  if (input.succeeded && environment.latestDeploymentId) {
    await publishPreviewDeploymentStatus(
      environment.latestDeploymentId,
      "inactive",
    ).catch(() => undefined);
  }
  if (input.succeeded) {
    await emitPreviewNotification(
      previewEnvironmentId,
      "preview.cleaned_up",
    ).catch(() => undefined);
  }
  await publishPreviewPullRequestComment(environment).catch(() => undefined);
  return { accepted: true };
}

async function publishPreviewCommentGroups(
  environments: Array<{ pullRequestNumber: number; sourceId: string }>,
) {
  const groups = new Map<string, (typeof environments)[number]>();
  for (const environment of environments) {
    groups.set(
      `${environment.sourceId}:${environment.pullRequestNumber}`,
      environment,
    );
  }
  await Promise.all(
    [...groups.values()].map((environment) =>
      publishPreviewPullRequestComment(environment).catch(() => undefined),
    ),
  );
}
