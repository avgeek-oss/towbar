import {
  authorizeQueuedEffect,
  captureQueuedActor,
  currentActor,
  withActor,
} from "../auth/actor-context.js";
import { and, eq, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm";
import {
  collectsHostDockerLogs,
  evaluateAutoDeployPause,
  isNormalizedResource,
} from "@workspace/towbar-core";

import {
  apps,
  deployments,
  domainClaims,
  releases,
  servers,
  sourceEnvironments,
  sourceSyncs,
  sources,
} from "@workspace/towbar-database/schema";

import { getTowbarDatabase } from "../../infrastructure/database.js";
import { selectAutomaticDeploymentCandidates } from "./automatic-deployment-selection.js";
import { assertRequiredInstanceSecrets } from "./secrets.js";
import { HttpError } from "../../http/errors.js";
import { requestAppDeployment } from "./service.js";
import { createDeferredAutomaticDeployment } from "../auto-deploy-controls/service.js";
import { scheduleSourcePreviewReconciliations } from "../previews/reconciliation-scheduler.js";
import { requestDisabledPreviewCleanups } from "../previews/cleanup.js";
import { requireHostLogCollection } from "./host-log-collection.js";

const automaticDeploymentDependencies = {
  requestDeployment: requestAppDeployment,
  cleanupPreviews: requestDisabledPreviewCleanups,
  reconcilePreviews: scheduleSourcePreviewReconciliations,
};

type SourceSyncAdmission = {
  commitSha: string | null;
  requestedBy: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
};

export function isSourceSyncEligibleForAutomaticDeployments(
  sync: SourceSyncAdmission,
): sync is SourceSyncAdmission & { commitSha: string } {
  return sync.status === "succeeded" && sync.commitSha !== null;
}

export function sourceSyncDeploymentIdempotencyKey(input: {
  commitSha: string;
  deploymentDigest: string;
  manifestId: string;
  sourceId: string;
  syncId?: string;
}) {
  return `${input.syncId ? `sync:${input.syncId}` : "push"}:${input.sourceId}:${input.commitSha}:${input.deploymentDigest}:${input.manifestId}`;
}

export async function scheduleSourceAutomaticDeployments(
  syncId: string,
  dependencies = automaticDeploymentDependencies,
) {
  const [sync] = await getTowbarDatabase()
    .select({
      sourceEnvironmentId: sourceSyncs.sourceEnvironmentId,
      deployAfterSync: sourceSyncs.deployAfterSync,
      commitSha: sourceSyncs.commitSha,
      requestedBy: sourceSyncs.requestedBy,
      requestedByActor: sourceSyncs.requestedByActor,
      sourceId: sourceSyncs.sourceId,
      status: sourceSyncs.status,
      workspaceId: sources.workspaceId,
    })
    .from(sourceSyncs)
    .innerJoin(sources, eq(sources.id, sourceSyncs.sourceId))
    .where(eq(sourceSyncs.id, syncId))
    .limit(1);
  if (
    !sync ||
    !sync.sourceEnvironmentId ||
    !isSourceSyncEligibleForAutomaticDeployments(sync)
  ) {
    return { deploymentIds: [] };
  }
  // Syncs that only import configuration, such as Sync now, deploy nothing but
  // still apply Preview changes to open pull requests.
  const result = sync.deployAfterSync
    ? await withActor(
        await authorizeQueuedEffect(sync.requestedByActor, sync.workspaceId, [
          "admin",
        ]),
        () =>
          scheduleEligibleAutomaticDeployments({
            commitSha: sync.commitSha!,
            sourceId: sync.sourceId,
            sourceEnvironmentId: sync.sourceEnvironmentId!,
            syncId,
            workspaceId: sync.workspaceId,
            requestDeployment: dependencies.requestDeployment,
          }),
      )
    : { deploymentIds: [] };
  await dependencies.cleanupPreviews(sync.sourceId, sync.sourceEnvironmentId);
  await dependencies.reconcilePreviews(sync.sourceId);
  return result;
}

export function completedDomainHandoff(
  deployment:
    | {
        state: string;
        domainHandoffSnapshot: unknown[];
      }
    | undefined,
) {
  return Boolean(
    deployment?.domainHandoffSnapshot.length &&
    ["succeeded", "succeeded_with_warnings"].includes(deployment.state),
  );
}

export async function continueAutomaticDeployments(deploymentId: string) {
  const [deployment] = await getTowbarDatabase()
    .select({
      state: deployments.state,
      appId: deployments.appId,
      deploymentDigest: deployments.deploymentDigest,
      domainHandoffSnapshot: deployments.domainHandoffSnapshot,
      sourceId: deployments.sourceId,
      workspaceId: deployments.workspaceId,
      targetEnvironment: deployments.targetEnvironment,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (
    !deployment ||
    !["succeeded", "succeeded_with_warnings"].includes(deployment.state)
  )
    return { deploymentIds: [] };
  if (!completedDomainHandoff(deployment)) {
    const [waiting] = await getTowbarDatabase()
      .select({ hostname: domainClaims.hostname })
      .from(domainClaims)
      .leftJoin(apps, eq(apps.id, deployment.appId))
      .where(
        and(
          or(
            eq(domainClaims.pendingDeploymentId, deploymentId),
            eq(domainClaims.activeDeploymentId, deploymentId),
          ),
          or(
            isNull(domainClaims.desiredAppId),
            ne(domainClaims.desiredAppId, deployment.appId),
            ne(apps.deploymentDigest, deployment.deploymentDigest ?? ""),
          ),
        ),
      )
      .limit(1);
    if (!waiting) return { deploymentIds: [] };
  }
  const [environment] = await getTowbarDatabase()
    .select({ syncId: sourceEnvironments.latestSuccessfulSyncId })
    .from(sourceEnvironments)
    .where(
      and(
        eq(sourceEnvironments.id, deployment.targetEnvironment.id),
        eq(sourceEnvironments.sourceId, deployment.sourceId),
        isNull(sourceEnvironments.disconnectedAt),
      ),
    );
  return environment?.syncId
    ? await scheduleSourceAutomaticDeployments(environment.syncId)
    : { deploymentIds: [] };
}

export async function scheduleLatestAutomaticDeploymentsForSource(input: {
  sourceEnvironmentId?: string;
  sourceId: string;
  workspaceId: string;
}) {
  const environments = await getTowbarDatabase()
    .select({
      id: sourceEnvironments.id,
      commitSha: sourceEnvironments.latestCommitSha,
    })
    .from(sourceEnvironments)
    .innerJoin(sources, eq(sources.id, sourceEnvironments.sourceId))
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.workspaceId, input.workspaceId),
        eq(sources.status, "active"),
        isNull(sourceEnvironments.disconnectedAt),
        ...(input.sourceEnvironmentId
          ? [eq(sourceEnvironments.id, input.sourceEnvironmentId)]
          : []),
      ),
    );
  const deploymentIds: string[] = [];
  const skippedDeployments = [];
  for (const environment of environments) {
    if (!environment.commitSha) continue;
    const result = await scheduleEligibleAutomaticDeployments({
      ...input,
      sourceEnvironmentId: environment.id,
      commitSha: environment.commitSha,
    });
    deploymentIds.push(...result.deploymentIds);
    if (result.skippedDeployments)
      skippedDeployments.push(...result.skippedDeployments);
  }
  return {
    deploymentIds,
    ...(skippedDeployments.length ? { skippedDeployments } : {}),
  };
}

export async function admitResumedAutomaticDeployments() {
  const sourceRows = await getTowbarDatabase()
    .selectDistinct({
      sourceId: apps.sourceId,
      workspaceId: apps.workspaceId,
      sourceEnvironmentId: sourceEnvironments.id,
    })
    .from(apps)
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .where(
      and(
        isNotNull(apps.deferredAutomaticDeployment),
        isNull(sourceEnvironments.disconnectedAt),
        eq(sourceEnvironments.autoDeployPaused, false),
        eq(apps.autoDeployPaused, false),
        eq(sources.autoDeployPaused, false),
        eq(sources.status, "active"),
      ),
    );
  let deploymentsQueued = 0;
  for (const source of sourceRows) {
    const result = await scheduleLatestAutomaticDeploymentsForSource(source);
    deploymentsQueued += result.deploymentIds.length;
  }
  return deploymentsQueued;
}

async function scheduleEligibleAutomaticDeployments(input: {
  commitSha: string;
  sourceId: string;
  sourceEnvironmentId: string;
  syncId?: string;
  workspaceId: string;
  requestDeployment?: typeof requestAppDeployment;
}) {
  const database = getTowbarDatabase();
  const [source] = await database
    .select({
      autoDeployPaused: sources.autoDeployPaused,
    })
    .from(sources)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.workspaceId, input.workspaceId),
        eq(sources.status, "active"),
      ),
    )
    .limit(1);
  const [environment] = await database
    .select({
      latestCommitSha: sourceEnvironments.latestCommitSha,
      autoDeployPaused: sourceEnvironments.autoDeployPaused,
      mappingRevision: sourceEnvironments.mappingRevision,
      syncId: sourceEnvironments.latestSuccessfulSyncId,
      syncedMappingRevision: sourceSyncs.mappingRevision,
      requestedByActor: sourceSyncs.requestedByActor,
    })
    .from(sourceEnvironments)
    .innerJoin(
      sourceSyncs,
      eq(sourceSyncs.id, sourceEnvironments.latestSuccessfulSyncId),
    )
    .where(
      and(
        eq(sourceEnvironments.id, input.sourceEnvironmentId),
        eq(sourceEnvironments.sourceId, input.sourceId),
        isNull(sourceEnvironments.disconnectedAt),
      ),
    )
    .limit(1);
  if (
    !source ||
    !environment ||
    environment.latestCommitSha !== input.commitSha ||
    environment.mappingRevision !== environment.syncedMappingRevision ||
    (input.syncId !== undefined && environment.syncId !== input.syncId)
  ) {
    return { deploymentIds: [] };
  }

  const candidates = await database
    .select({
      appId: apps.id,
      manifestState: apps.manifestState,
      archivedAt: apps.archivedAt,
      autoDeployPaused: apps.autoDeployPaused,
      config: apps.config,
      deploymentDigest: apps.deploymentDigest,
      manifestId: apps.id,
      kind: apps.kind,
      sourceRevision: apps.sourceRevision,
      serverConfigDigest: servers.configDigest,
      serverConfig: servers.config,
      serverPreparedAt: servers.preparedAt,
      serverPreparedConfigDigest: servers.preparedConfigDigest,
    })
    .from(apps)
    .innerJoin(servers, eq(servers.id, apps.serverId))
    .where(
      and(
        eq(apps.sourceId, input.sourceId),
        eq(apps.sourceEnvironmentId, input.sourceEnvironmentId),
        eq(apps.workspaceId, input.workspaceId),
      ),
    );
  const releaseStates = await database
    .select({
      currentDeploymentDigest: releases.deploymentDigest,
      manifestId: apps.id,
    })
    .from(apps)
    .leftJoin(
      releases,
      and(
        eq(releases.appId, apps.id),
        eq(releases.status, "current"),
        eq(releases.environment, "production"),
      ),
    )
    .where(
      and(
        eq(apps.sourceId, input.sourceId),
        eq(apps.sourceEnvironmentId, input.sourceEnvironmentId),
        eq(apps.workspaceId, input.workspaceId),
      ),
    );
  const eligible = selectAutomaticDeploymentCandidates({
    candidates: candidates.map((candidate) => ({
      ...candidate,
      serverReady:
        Boolean(candidate.serverPreparedAt) &&
        candidate.serverPreparedConfigDigest === candidate.serverConfigDigest,
    })),
    commitSha: input.commitSha,
    releases: releaseStates,
  });

  const eligibleIds = eligible.map((candidate) => candidate.appId);
  await database
    .update(apps)
    .set({ deferredAutomaticDeployment: null })
    .where(
      and(
        eq(apps.sourceId, input.sourceId),
        eq(apps.sourceEnvironmentId, input.sourceEnvironmentId),
        isNotNull(apps.deferredAutomaticDeployment),
        ...(eligibleIds.length ? [notInArray(apps.id, eligibleIds)] : []),
      ),
    );

  const skippedDeployments: Array<{
    appId: string;
    code: string;
    message: string;
  }> = [];
  const results = await Promise.all(
    eligible.map(async (candidate) => {
      if (!candidate.deploymentDigest) {
        throw new Error("Automatic deployment candidate is not materialized");
      }
      let actor = currentActor();
      if (collectsHostDockerLogs(candidate.config)) {
        try {
          requireHostLogCollection(candidate.serverConfig, candidate.config);
          actor ??= await authorizeQueuedEffect(
            environment.requestedByActor,
            input.workspaceId,
            ["admin"],
          );
          withActor(actor, () =>
            captureQueuedActor(input.workspaceId, ["admin"]),
          );
        } catch (error) {
          if (
            error instanceof HttpError &&
            ["HOST_LOG_COLLECTION_DISABLED", "FORBIDDEN"].includes(error.code)
          ) {
            skippedDeployments.push({
              appId: candidate.appId,
              code: error.code,
              message: error.publicMessage,
            });
            return null;
          }
          throw error;
        }
      }
      try {
        await assertRequiredInstanceSecrets({
          appId: candidate.appId,
          config: candidate.config,
          sourceId: input.sourceId,
          workspaceId: input.workspaceId,
        });
      } catch (error) {
        if (
          error instanceof HttpError &&
          ["REQUIRED_SECRETS_MISSING", "SECRET_REFERENCE_INVALID"].includes(
            error.code,
          )
        )
          return null;
        throw error;
      }
      const gate = evaluateAutoDeployPause({
        deployablePaused: candidate.autoDeployPaused,
        sourcePaused: source.autoDeployPaused,
        environmentPaused: Boolean(environment?.autoDeployPaused),
      });
      if (gate.paused) {
        await database
          .update(apps)
          .set({
            deferredAutomaticDeployment: createDeferredAutomaticDeployment({
              commitSha: input.commitSha,
              deploymentDigest: candidate.deploymentDigest!,
              gate,
              manifestId: candidate.manifestId,
            }),
          })
          .where(eq(apps.id, candidate.appId));
        return null;
      }
      let result;
      try {
        result = await withActor(
          actor ?? {
            kind: "system",
            source: "worker",
            workspaceId: input.workspaceId,
            grants: ["admin"],
          },
          () =>
            (input.requestDeployment ?? requestAppDeployment)({
              appId: candidate.appId,
              expectedType: isNormalizedResource(candidate.config)
                ? "resource"
                : "app",
              expectedCommitSha: input.commitSha,
              idempotencyKey: sourceSyncDeploymentIdempotencyKey({
                commitSha: input.commitSha,
                deploymentDigest: candidate.deploymentDigest!,
                manifestId: candidate.manifestId,
                sourceId: input.sourceId,
                syncId: input.syncId,
              }),
              requestedBy: null,
              workspaceId: input.workspaceId,
            }),
        );
      } catch (error) {
        if (
          error instanceof HttpError &&
          ["DOMAIN_HANDOFF_PENDING", "DOMAIN_DEPLOYMENT_IN_PROGRESS"].includes(
            error.code,
          )
        ) {
          skippedDeployments.push({
            appId: candidate.appId,
            code: error.code,
            message: error.publicMessage,
          });
          return null;
        }
        if (
          collectsHostDockerLogs(candidate.config) &&
          error instanceof HttpError &&
          ["HOST_LOG_COLLECTION_DISABLED", "FORBIDDEN"].includes(error.code)
        ) {
          skippedDeployments.push({
            appId: candidate.appId,
            code: error.code,
            message: error.publicMessage,
          });
          return null;
        }
        throw error;
      }
      await database
        .update(apps)
        .set({ deferredAutomaticDeployment: null })
        .where(eq(apps.id, candidate.appId));
      return result;
    }),
  );
  return {
    deploymentIds: results.flatMap((result) =>
      result ? [result.deployment.id] : [],
    ),
    ...(skippedDeployments.length ? { skippedDeployments } : {}),
  };
}
