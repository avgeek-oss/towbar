import { withActor } from "../auth/actor-context.js";
import { and, desc, eq, isNull, ne } from "drizzle-orm";

import {
  createPreviewAppSnapshot,
  isNormalizedResource,
  previewHostname,
  resolveRepositoryEnvironment,
  shouldDeployForChangedPaths,
} from "@workspace/towbar-core";
import { previewPullRequestEventSchema } from "@workspace/towbar-core/temporal";
import {
  apps,
  integrationInstallations,
  previewEnvironments,
  servers,
  sourceEnvironments,
  sourceSyncs,
  sources,
} from "@workspace/towbar-database/schema";

import {
  fetchRepositoryEnvironmentSnapshot,
  fetchRepositoryPullRequest,
  fetchRepositoryPullRequestChangedPaths,
  fetchRepositoryTree,
  repositoryProviderClient,
} from "../sources/repository-provider.js";
import { withPreviewLifecycleLock } from "./lifecycle-lock.js";
import {
  missingPreviewSecretsReason,
  samePreviewPullRequestRevision,
} from "./pull-request.js";
import { selectObsoletePreviewApps } from "./cleanup-selection.js";
import { resolvePreviewConfiguration } from "./configuration.js";
import { assertRequiredInstanceSecrets } from "../apps/secrets.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { requireGitLabRuntimeConfiguration } from "../../infrastructure/runtime-integrations.js";
import { enqueueDeployment } from "../../infrastructure/temporal.js";
import {
  propagatePreviewDeploymentState,
  publishPreviewDeploymentStatus,
} from "../deployments/preview-status.js";
import {
  emitDeploymentNotification,
  emitPreviewNotification,
} from "../notifications/events.js";
import { calculateReleaseDeploymentDigest } from "../sources/deployment-digests.js";
import { admitPreviewDeployment } from "./admission.js";
import {
  requestObsoletePreviewCleanups,
  requestPreviewPullRequestCleanup,
} from "./cleanup.js";
import { previewPullRequestDisposition } from "./pull-request.js";
import { publishPreviewPullRequestComment } from "./pr-comment.js";
import {
  type PreviewSkippedApp,
  closePreviewPullRequestReport,
  recordPreviewPullRequestPlan,
} from "./reporting-state.js";

import type { PreviewPullRequestEvent } from "@workspace/towbar-core/temporal";
import type { NormalizedApp } from "@workspace/towbar-core";

export { scheduleSourcePreviewReconciliations } from "./reconciliation-scheduler.js";

export async function listPreviewEnvironments(input: {
  appId?: string;
  sourceId?: string;
  workspaceId: string;
}) {
  const rows = await getTowbarDatabase()
    .select({
      appId: previewEnvironments.appId,
      appName: apps.name,
      branch: previewEnvironments.branch,
      cleanupAttempts: previewEnvironments.cleanupAttempts,
      createdAt: previewEnvironments.createdAt,
      errorMessage: previewEnvironments.errorMessage,
      expiresAt: previewEnvironments.expiresAt,
      gitRef: previewEnvironments.gitRef,
      hostname: previewEnvironments.hostname,
      id: previewEnvironments.id,
      latestCommitSha: previewEnvironments.latestCommitSha,
      latestDeploymentId: previewEnvironments.latestDeploymentId,
      nextCleanupAttemptAt: previewEnvironments.nextCleanupAttemptAt,
      pullRequestNumber: previewEnvironments.pullRequestNumber,
      repositoryName: sources.repositoryName,
      repositoryOwner: sources.repositoryOwner,
      repositoryProvider: sources.provider,
      sourceId: previewEnvironments.sourceId,
      status: previewEnvironments.status,
      updatedAt: previewEnvironments.updatedAt,
    })
    .from(previewEnvironments)
    .innerJoin(apps, eq(apps.id, previewEnvironments.appId))
    .innerJoin(sources, eq(sources.id, previewEnvironments.sourceId))
    .where(
      and(
        eq(previewEnvironments.workspaceId, input.workspaceId),
        input.appId ? eq(previewEnvironments.appId, input.appId) : undefined,
        input.sourceId
          ? eq(previewEnvironments.sourceId, input.sourceId)
          : undefined,
        ne(previewEnvironments.status, "deleted"),
      ),
    )
    .orderBy(desc(previewEnvironments.updatedAt));
  return rows.map(
    ({ repositoryName, repositoryOwner, repositoryProvider, ...preview }) => {
      const repositoryPath = [repositoryOwner, repositoryName]
        .flatMap((part) => part.split("/"))
        .map(encodeURIComponent)
        .join("/");
      const repositoryUrl =
        repositoryProvider === "github"
          ? `https://github.com/${repositoryPath}`
          : new URL(
              repositoryPath,
              `${requireGitLabRuntimeConfiguration().baseUrl.replace(/\/$/u, "")}/`,
            )
              .toString()
              .replace(/\/$/u, "");
      return {
        ...preview,
        pullRequestUrl:
          repositoryProvider === "github"
            ? `${repositoryUrl}/pull/${preview.pullRequestNumber}`
            : `${repositoryUrl}/-/merge_requests/${preview.pullRequestNumber}`,
      };
    },
  );
}

export async function processPreviewPullRequestEvent(
  raw: PreviewPullRequestEvent,
) {
  const event = previewPullRequestEventSchema.parse(raw);
  return withPreviewLifecycleLock(event, () =>
    reconcilePreviewPullRequest(event),
  );
}

async function reconcilePreviewPullRequest(event: PreviewPullRequestEvent) {
  const database = getTowbarDatabase();
  const [source] = await database
    .select({
      installationId: integrationInstallations.externalId,
      connectionId: sources.integrationAuthorizationId,
      projectId: sources.providerRepositoryId,
      provider: sources.provider,
      repositoryName: sources.repositoryName,
      repositoryOwner: sources.repositoryOwner,
      status: sources.status,
      autoDeployPaused: sources.autoDeployPaused,
      workspaceId: sources.workspaceId,
    })
    .from(sources)
    .leftJoin(
      integrationInstallations,
      eq(integrationInstallations.id, sources.integrationInstallationId),
    )
    .where(eq(sources.id, event.sourceId))
    .limit(1);
  if (!source || source.status !== "active") {
    return { cleanupIds: [], deploymentIds: [], retry: false };
  }
  const providerConnection = await repositoryProviderClient(
    source.provider === "github"
      ? source.installationId
        ? {
            installationId: source.installationId,
            provider: "github",
            repositoryName: source.repositoryName,
            repositoryOwner: source.repositoryOwner,
          }
        : (() => {
            throw new Error("GitHub source is missing its installation");
          })()
      : source.connectionId && source.projectId
        ? {
            connectionId: source.connectionId,
            projectId: source.projectId,
            provider: "gitlab",
            repositoryName: source.repositoryName,
            repositoryOwner: source.repositoryOwner,
            workspaceId: source.workspaceId,
          }
        : (() => {
            throw new Error("GitLab source is missing its integration");
          })(),
  );
  const pullRequest = await fetchRepositoryPullRequest(
    providerConnection,
    event.pullRequestNumber,
  );
  const environments = await database
    .select()
    .from(sourceEnvironments)
    .where(
      and(
        eq(sourceEnvironments.sourceId, event.sourceId),
        eq(sourceEnvironments.branch, pullRequest.baseBranch),
        eq(sourceEnvironments.previewsEnabled, true),
        isNull(sourceEnvironments.disconnectedAt),
      ),
    );
  // Closing a pull request retires an already admitted preview. Other events
  // cannot change runtime state while its repository mapping is paused.
  if (
    pullRequest.state !== "closed" &&
    (source.autoDeployPaused ||
      environments.length === 0 ||
      environments.some((environment) => environment.autoDeployPaused))
  ) {
    return { cleanupIds: [], deploymentIds: [], retry: false };
  }
  const disposition = previewPullRequestDisposition({
    pullRequest,
    repositoryName: source.repositoryName,
    repositoryOwner: source.repositoryOwner,
    sourceBranches: environments.map((environment) => environment.branch),
  });
  if (disposition.action === "cleanup") {
    await closePreviewPullRequestReport({
      pullRequestNumber: event.pullRequestNumber,
      sourceId: event.sourceId,
    });
    return {
      ...(await requestPreviewPullRequestCleanup({
        pullRequestNumber: event.pullRequestNumber,
        reason: disposition.reason,
        sourceId: event.sourceId,
      })),
      retry: false,
    };
  }
  const changedPaths = await fetchRepositoryPullRequestChangedPaths(
    providerConnection,
    {
      changedFileCount: pullRequest.changedFileCount,
      pullRequestNumber: pullRequest.number,
    },
  );

  const candidates = await database
    .select({
      appId: apps.id,
      environmentId: sourceEnvironments.id,
      targetConfigDigest: apps.configDigest,
      targetEnvironment: sourceEnvironments,
      manifestDigest: sourceEnvironments.latestManifestDigest,
      appName: apps.name,
      config: apps.config,
      manifestId: apps.manifestId,
      server: servers.config,
      serverConfigDigest: servers.configDigest,
      serverId: servers.id,
      serverPreparedAt: servers.preparedAt,
      serverPreparedConfigDigest: servers.preparedConfigDigest,
    })
    .from(apps)
    .innerJoin(servers, eq(servers.id, apps.serverId))
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .innerJoin(
      sourceSyncs,
      eq(sourceSyncs.id, sourceEnvironments.latestSuccessfulSyncId),
    )
    .where(
      and(
        eq(apps.sourceId, event.sourceId),
        eq(apps.workspaceId, source.workspaceId),
        eq(apps.kind, "app"),
        eq(sourceEnvironments.branch, pullRequest.baseBranch),
        eq(sourceEnvironments.previewsEnabled, true),
        isNull(sourceEnvironments.disconnectedAt),
        eq(sourceEnvironments.mappingRevision, sourceSyncs.mappingRevision),
        isNull(apps.archivedAt),
      ),
    );
  const targets = candidates.filter(
    (candidate): candidate is typeof candidate & { config: NormalizedApp } =>
      Boolean(candidate.manifestDigest) &&
      !isNormalizedResource(candidate.config) &&
      candidate.config.preview?.enabled === true &&
      Boolean(candidate.serverPreparedAt) &&
      candidate.serverPreparedConfigDigest === candidate.serverConfigDigest,
  );
  const repositorySnapshot = await fetchRepositoryEnvironmentSnapshot({
    ...providerConnection,
    commitSha: pullRequest.headSha,
  });
  const resolved = new Map(
    environments.map((environment) => [
      environment.id,
      resolveRepositoryEnvironment({
        ...repositorySnapshot,
        environment: environment.name,
        branch: environment.branch,
      }),
    ]),
  );
  const eligible = targets.flatMap((target) => {
    const configuration = resolvePreviewConfiguration({
      resolved: resolved.get(target.environmentId)!,
      target: target.config,
    });
    return configuration ? [{ ...target, ...configuration }] : [];
  });
  const relevant = eligible.filter((candidate) =>
    shouldDeployForChangedPaths({
      changedPaths,
      deploymentInputs: candidate.config.deploymentInputs,
    }),
  );
  const relevantAppIds = new Set(relevant.map((candidate) => candidate.appId));
  const latestPullRequest = await fetchRepositoryPullRequest(
    providerConnection,
    event.pullRequestNumber,
  );
  if (!samePreviewPullRequestRevision(pullRequest, latestPullRequest)) {
    return { cleanupIds: [], deploymentIds: [], retry: true };
  }
  // Missing Preview secrets need operator action, so report them on the pull
  // request instead of retrying until the workflow gives up.
  const admissible: typeof relevant = [];
  const blocked: PreviewSkippedApp[] = [];
  for (const candidate of relevant) {
    const reason = await assertRequiredInstanceSecrets({
      appId: candidate.appId,
      config: candidate.config,
      sourceId: event.sourceId,
      workspaceId: source.workspaceId,
      preview: true,
      declarations: candidate.requiredSecrets,
    }).then(() => null, missingPreviewSecretsReason);
    if (reason) {
      blocked.push({
        appId: candidate.appId,
        appName: candidate.appName,
        reason,
        blocked: true,
      });
    } else {
      admissible.push(candidate);
    }
  }
  await recordPreviewPullRequestPlan({
    branch: pullRequest.headBranch,
    hasDeployments: admissible.length > 0,
    latestCommitSha: pullRequest.headSha,
    pullRequestNumber: pullRequest.number,
    skippedApps: [
      ...eligible
        .filter((candidate) => !relevantAppIds.has(candidate.appId))
        .map((candidate) => ({
          appId: candidate.appId,
          appName: candidate.appName,
          reason: "no matching changes",
        })),
      ...blocked,
    ],
    sourceId: event.sourceId,
    workspaceId: source.workspaceId,
  });
  const existing = await database
    .select({
      appId: apps.id,
      environmentId: apps.sourceEnvironmentId,
      archivedAt: apps.archivedAt,
      config: apps.config,
    })
    .from(previewEnvironments)
    .innerJoin(apps, eq(apps.id, previewEnvironments.appId))
    .where(
      and(
        eq(previewEnvironments.sourceId, event.sourceId),
        eq(previewEnvironments.pullRequestNumber, pullRequest.number),
        ne(previewEnvironments.status, "deleted"),
      ),
    );
  const cleanup = await requestObsoletePreviewCleanups({
    appIds: selectObsoletePreviewApps({
      existing: existing.map((app) => ({
        appId: app.appId,
        environmentId: app.environmentId,
        archived: Boolean(app.archivedAt),
        enabled:
          !isNormalizedResource(app.config) &&
          Boolean(app.config.preview?.enabled),
      })),
      targetEnvironmentIds: environments.map((environment) => environment.id),
      evaluatedAppIds: targets.map((target) => target.appId),
      relevantAppIds: [...relevantAppIds],
    }),
    pullRequestNumber: pullRequest.number,
    sourceId: event.sourceId,
  });
  if (admissible.length === 0) {
    await publishPreviewPullRequestComment({
      pullRequestNumber: pullRequest.number,
      sourceId: event.sourceId,
    }).catch(() => undefined);
    return { ...cleanup, deploymentIds: [], retry: false };
  }
  const repositoryTree = admissible.some(
    (candidate) => candidate.config.deploymentInputs.length > 0,
  )
    ? await fetchRepositoryTree(providerConnection, pullRequest.headSha)
    : undefined;

  const admissions = [];
  for (const candidate of admissible) {
    const hostname = previewHostname({
      appId: candidate.appId,
      domain: candidate.config.preview!.domain,
      pullRequestNumber: pullRequest.number,
      sourceId: event.sourceId,
    });
    const snapshot = createPreviewAppSnapshot(candidate.config, {
      branch: pullRequest.headBranch,
      hostname,
    });
    const digests = calculateReleaseDeploymentDigest({
      commitSha: pullRequest.headSha,
      deployable: snapshot,
      deploymentInputs: candidate.config.deploymentInputs,
      repositoryTree,
      server: candidate.server,
    });
    const admission = await withActor(
      {
        kind: "system",
        source: source.provider,
        workspaceId: source.workspaceId,
        grants: ["deployment.create"],
      },
      () =>
        admitPreviewDeployment({
          requiredSecrets: candidate.requiredSecrets,
          targetEnvironment: candidate.targetEnvironment,
          targetConfigDigest: candidate.targetConfigDigest,
          appId: candidate.appId,
          branch: pullRequest.headBranch,
          commitSha: pullRequest.headSha,
          config: snapshot,
          deploymentDigest: digests.deploymentDigest,
          hostname,
          manifestDigest: candidate.manifestDigest!,
          pullRequestNumber: pullRequest.number,
          server: candidate.server,
          serverId: candidate.serverId,
          sourceId: event.sourceId,
          sourceInputDigest: digests.sourceInputDigest,
          ttlHours: candidate.config.preview!.ttlHours,
          workspaceId: source.workspaceId,
        }),
    );
    admissions.push(admission);
    await Promise.all(
      admission.supersededDeploymentIds.map((deploymentId) =>
        propagatePreviewDeploymentState(deploymentId, "skipped"),
      ),
    );
    if (admission.supersededDeploymentIds.length > 0) {
      await emitPreviewNotification(
        admission.environmentId,
        "preview.superseded",
      ).catch(() => undefined);
    }
    if (admission.deploymentId && admission.created) {
      await emitDeploymentNotification(
        admission.deploymentId,
        "deployment.queued",
      ).catch(() => undefined);
      await publishPreviewDeploymentStatus(
        admission.deploymentId,
        "queued",
      ).catch(() => undefined);
    }
    if (admission.deploymentId && admission.shouldEnqueue) {
      // Signal delivery is uncertain when Temporal is unavailable. Keep the
      // accepted deployment queued so this Activity retry can safely signal
      // the same deployment ID again.
      await enqueueDeployment({
        appId: candidate.appId,
        buildConcurrency: candidate.server.buildConcurrency ?? 1,
        deploymentId: admission.deploymentId,
        previewBuildConcurrency: candidate.server.previewBuildConcurrency ?? 1,
        priority: "preview",
        serverIp: candidate.server.ip,
      });
    }
  }
  await publishPreviewPullRequestComment({
    pullRequestNumber: pullRequest.number,
    sourceId: event.sourceId,
  }).catch(() => undefined);
  return {
    cleanupIds: cleanup.cleanupIds,
    deploymentIds: admissions
      .map((admission) => admission.deploymentId)
      .filter((id): id is string => Boolean(id)),
    retry: admissions.some((admission) => admission.deferred),
  };
}
