import {
  lockDomainClaims,
  publishDeploymentDomains,
  resolveDeploymentDomainContext,
} from "./domain-claims.js";
/* eslint-disable max-lines -- Deployment admission, snapshotting, and lifecycle transitions share one transactional service contract. */
import { assertAppStorageServer } from "../apps/storage.js";
import {
  hostLogDeploymentPermissions,
  hostLogExecutionDeployables,
} from "../apps/host-log-collection.js";
import { requireActiveAutomation } from "../auth/automation-authority.js";
import { authorizeQueuedEffect } from "../auth/actor-context.js";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
} from "drizzle-orm";
import {
  deploymentStateSchema,
  terminalDeploymentStates,
} from "@workspace/towbar-core/temporal";
import {
  digestValue,
  isNormalizedCompose,
  isNormalizedResource,
} from "@workspace/towbar-core";
import type { ReleaseCommitPayload } from "@workspace/towbar-core";
import {
  apps,
  deployableRuntimeStates,
  deploymentLogChunks,
  deploymentSteps,
  deployments,
  integrationInstallations,
  previewEnvironments,
  releases,
  servers,
  sources,
  sshHostKeys,
} from "@workspace/towbar-database/schema";

import { getEnv } from "../../env.js";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { cancelDeploymentWorkflow } from "../../infrastructure/temporal.js";
import { createInstallationToken } from "../github/client.js";
import { resolveIntegrationById } from "../integrations/service.js";
import { emitDeploymentNotification } from "../notifications/events.js";
import { publicDeploymentSelection } from "../deployment-selection.js";
import { isVulnerabilityScanningEnabled } from "../vulnerability-scans/admission.js";
import { getDeploymentVulnerabilityScan } from "../vulnerability-scans/service.js";
import { collectRetainedImageTags } from "./image-retention.js";
import { assertReleaseKindMatchesDeployment } from "./release-kind.js";
import { propagatePreviewDeploymentState } from "./preview-status.js";
import { attachDeploymentQueueBlockers } from "./queue-blocker-query.js";

export {
  resolveDeploymentCloudflareSecret,
  resolveDeploymentCloudflareTunnelSecret,
  resolveDeploymentLogin,
  resolveDeploymentSecrets,
} from "./deployment-secrets.js";
const publicDeploymentStepSelection = {
  createdAt: deploymentSteps.createdAt,
  finishedAt: deploymentSteps.finishedAt,
  id: deploymentSteps.id,
  message: deploymentSteps.message,
  sequence: deploymentSteps.sequence,
  startedAt: deploymentSteps.startedAt,
  state: deploymentSteps.state,
  status: deploymentSteps.status,
};
const publicDeploymentLogSelection = {
  content: deploymentLogChunks.content,
  createdAt: deploymentLogChunks.createdAt,
  id: deploymentLogChunks.id,
  sequence: deploymentLogChunks.sequence,
  stream: deploymentLogChunks.stream,
};

export async function listDeployments(workspaceId: string, sourceId?: string) {
  const items = await getTowbarDatabase()
    .select(publicDeploymentSelection)
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .where(
      sourceId
        ? and(
            eq(deployments.workspaceId, workspaceId),
            eq(apps.sourceId, sourceId),
            eq(deployments.environment, "production"),
          )
        : and(
            eq(deployments.workspaceId, workspaceId),
            eq(deployments.environment, "production"),
          ),
    )
    .orderBy(desc(deployments.createdAt));
  return await attachDeploymentQueueBlockers(items);
}

export async function getDeployment(deploymentId: string, workspaceId: string) {
  const [deployment] = await getTowbarDatabase()
    .select({ ...publicDeploymentSelection, appConfig: apps.config })
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!deployment) throw notFound("Deployment");
  const { appConfig, ...publicDeployment } = deployment;
  const [item] = await attachDeploymentQueueBlockers([publicDeployment]);
  return {
    ...item!,
    vulnerabilityScan: await getDeploymentVulnerabilityScan(
      deployment,
      workspaceId,
    ),
    vulnerabilityScanningEnabled: isVulnerabilityScanningEnabled({
      deployable: appConfig,
      instanceEnabled: getEnv().TOWBAR_VULNERABILITY_SCANNING_ENABLED,
    }),
  };
}

export async function listDeploymentSteps(
  deploymentId: string,
  workspaceId: string,
) {
  await getDeployment(deploymentId, workspaceId);
  return await getTowbarDatabase()
    .select(publicDeploymentStepSelection)
    .from(deploymentSteps)
    .where(eq(deploymentSteps.deploymentId, deploymentId))
    .orderBy(asc(deploymentSteps.sequence));
}

export async function listDeploymentLogs(input: {
  afterSequence?: number;
  deploymentId: string;
  workspaceId: string;
}) {
  await getDeployment(input.deploymentId, input.workspaceId);
  return await getTowbarDatabase()
    .select(publicDeploymentLogSelection)
    .from(deploymentLogChunks)
    .where(
      input.afterSequence === undefined
        ? eq(deploymentLogChunks.deploymentId, input.deploymentId)
        : and(
            eq(deploymentLogChunks.deploymentId, input.deploymentId),
            gt(deploymentLogChunks.sequence, input.afterSequence),
          ),
    )
    .orderBy(asc(deploymentLogChunks.sequence))
    .limit(500);
}

export async function cancelDeployment(
  deploymentId: string,
  workspaceId: string,
) {
  const deployment = await getDeployment(deploymentId, workspaceId);
  if (terminalDeploymentStates.has(deployment.state)) {
    throw conflict("This deployment has already finished");
  }
  const cancelledBeforeStart = await cancelQueuedDeployment(
    deploymentId,
    workspaceId,
  );
  if (cancelledBeforeStart) {
    await propagatePreviewDeploymentState(deploymentId, "cancelled");
    await emitDeploymentNotification(
      deploymentId,
      "deployment.cancelled",
    ).catch(() => undefined);
    return cancelledBeforeStart;
  }
  await cancelDeploymentWorkflow(deploymentId);
  return deployment;
}

async function cancelQueuedDeployment(
  deploymentId: string,
  workspaceId: string,
) {
  return await getTowbarDatabase().transaction(async (transaction) => {
    const now = new Date();
    const [deployment] = await transaction
      .update(deployments)
      .set({ finishedAt: now, state: "cancelled", updatedAt: now })
      .where(
        and(
          eq(deployments.id, deploymentId),
          eq(deployments.workspaceId, workspaceId),
          eq(deployments.state, "queued"),
        ),
      )
      .returning(publicDeploymentSelection);
    if (!deployment) return null;
    await transaction.insert(deploymentSteps).values({
      deploymentId,
      finishedAt: now,
      message: "Deployment cancelled before execution",
      sequence: 0,
      startedAt: now,
      state: "cancelled",
      status: "skipped",
    });
    return deployment;
  });
}

export async function getDeploymentExecutionContext(deploymentId: string) {
  const [context] = await getTowbarDatabase()
    .select({
      app: deployments.appSnapshot,
      appId: deployments.appId,
      commitSha: deployments.commitSha,
      deploymentId: deployments.id,
      environment: deployments.environment,
      gitRef: deployments.gitRef,
      installationId: integrationInstallations.externalId,
      provider: sources.provider,
      integrationAuthorizationId: sources.integrationAuthorizationId,
      providerRepositoryId: sources.providerRepositoryId,
      kind: deployments.kind,
      repositoryName: sources.repositoryName,
      repositoryOwner: sources.repositoryOwner,
      rollbackRelease: deployments.rollbackReleaseSnapshot,
      previewEnvironmentId: deployments.previewEnvironmentId,
      server: deployments.serverSnapshot,
      serverId: deployments.serverId,
      currentServerConfig: servers.config,
      buildServer: deployments.buildServerSnapshot,
      buildServerId: deployments.buildServerId,
      sourceId: deployments.sourceId,
      workspaceId: deployments.workspaceId,
      requestedByActor: deployments.requestedByActor,
      state: deployments.state,
      targetEnvironment: deployments.targetEnvironment,
    })
    .from(deployments)
    .innerJoin(sources, eq(sources.id, deployments.sourceId))
    .innerJoin(servers, eq(servers.id, deployments.serverId))
    .leftJoin(
      integrationInstallations,
      eq(integrationInstallations.id, sources.integrationInstallationId),
    )
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!context) throw notFound("Deployment");
  const execution = await hostLogExecutionDeployables(context);
  context.app = execution.app;
  if (!isNormalizedResource(context.app))
    await assertAppStorageServer(
      getTowbarDatabase(),
      context.appId,
      context.serverId,
    );
  if (["queued", "waiting_for_server"].includes(context.state)) {
    const actor = await authorizeQueuedEffect(
      context.requestedByActor,
      context.workspaceId,
      hostLogDeploymentPermissions(...execution.deployables),
    );
    if (actor.kind === "system")
      await requireActiveAutomation({
        workspaceId: context.workspaceId,
        deployableId: context.appId,
        mappingRevision: context.targetEnvironment.mappingRevision,
        preview: context.environment === "preview",
      });
  }
  const { domainHandoffs, domainHandoffServers } =
    await resolveDeploymentDomainContext(deploymentId);
  const trustedHostKeys = await getTowbarDatabase()
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
  const buildServerTrustedHostKeys = context.buildServerId
    ? await getTowbarDatabase()
        .select({
          algorithm: sshHostKeys.algorithm,
          fingerprint: sshHostKeys.fingerprint,
          publicKey: sshHostKeys.publicKey,
        })
        .from(sshHostKeys)
        .where(
          and(
            eq(sshHostKeys.serverId, context.buildServerId),
            isNull(sshHostKeys.revokedAt),
          ),
        )
    : [];
  const [currentRelease] = await getTowbarDatabase()
    .select({
      containerName: releases.containerName,
      containerNames: releases.containerNames,
      imageTag: releases.imageTag,
    })
    .from(releases)
    .where(
      and(
        eq(releases.appId, context.appId),
        eq(releases.status, "current"),
        context.environment === "preview"
          ? eq(releases.previewEnvironmentId, context.previewEnvironmentId!)
          : eq(releases.environment, "production"),
      ),
    )
    .limit(1);
  const {
    appId,
    buildServer: buildServerSnapshot,
    buildServerId,
    currentServerConfig: _currentServerConfig,
    installationId: _installationId,
    integrationAuthorizationId: _integrationConnectionId,
    providerRepositoryId: _providerRepositoryId,
    provider: _provider,
    requestedByActor: _actor,
    state: _state,
    targetEnvironment: _target,
    ...publicContext
  } = context;
  const sourceCredential =
    context.kind !== "deploy" ||
    (isNormalizedResource(context.app) &&
      !context.app.container.configFiles?.length)
      ? null
      : context.provider === "github"
        ? context.installationId
          ? {
              apiUrl: "https://api.github.com",
              provider: "github" as const,
              token: await createInstallationToken(context.installationId),
            }
          : (() => {
              throw new Error("GitHub source is missing its installation");
            })()
        : context.integrationAuthorizationId
          ? await resolveGitLabSourceCredential({
              connectionId: context.integrationAuthorizationId,
              environment: context.targetEnvironment.name,
              sourceId: context.sourceId,
              projectId:
                context.providerRepositoryId ??
                (() => {
                  throw new Error("GitLab source is missing its project ID");
                })(),
              workspaceId: context.workspaceId,
            })
          : (() => {
              throw new Error("GitLab source is missing its integration");
            })();
  return {
    ...publicContext,
    domainHandoffs,
    domainHandoffServers,
    currentRelease: currentRelease
      ? {
          ...currentRelease,
          containerNames:
            currentRelease.containerNames.length > 0
              ? currentRelease.containerNames
              : [currentRelease.containerName],
        }
      : null,
    deployableId: appId,
    environmentName:
      context.environment === "preview"
        ? `preview:${context.targetEnvironment.name}`
        : context.targetEnvironment.name,
    runtimeId:
      context.environment === "preview"
        ? await getPreviewRuntimeId(context.previewEnvironmentId!)
        : appId,
    sourceCredential,
    trustedHostKeys,
    ...(buildServerSnapshot && buildServerId
      ? {
          buildServer: {
            config: buildServerSnapshot,
            id: buildServerId,
            transfer:
              !isNormalizedResource(context.app) &&
              !isNormalizedCompose(context.app) &&
              context.app.buildServer
                ? context.app.buildServer.transfer
                : "direct",
            trustedHostKeys: buildServerTrustedHostKeys,
          },
        }
      : {}),
  };
}

async function resolveGitLabSourceCredential(input: {
  connectionId: string;
  environment: string;
  sourceId: string;
  projectId: string;
  workspaceId: string;
}) {
  const resolved = await resolveIntegrationById({
    id: input.connectionId,
    providers: ["gitlab"],
    target: {
      kind: "repository",
      purpose: "source",
      repositoryId: input.sourceId,
      environment: input.environment,
    },
    workspaceId: input.workspaceId,
  });
  if (resolved.connectionInput.provider !== "gitlab")
    throw new Error("GitLab source resolved an incompatible integration");
  return {
    allowPrivateNetwork:
      resolved.connectionInput.configuration.allowPrivateNetwork,
    baseUrl: resolved.connectionInput.configuration.baseUrl,
    projectId: input.projectId,
    provider: "gitlab" as const,
    token: resolved.connectionInput.credentials.token,
  };
}

export async function getDeploymentRecoveryStatus(deploymentId: string) {
  const [deployment] = await getTowbarDatabase()
    .select({
      appId: deployments.appId,
      appSnapshot: deployments.appSnapshot,
      environment: deployments.environment,
      previewEnvironmentId: deployments.previewEnvironmentId,
      state: deployments.state,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment) throw notFound("Deployment");
  const [release] = await getTowbarDatabase()
    .select({ id: releases.id })
    .from(releases)
    .where(eq(releases.deploymentId, deploymentId))
    .limit(1);
  if (!release) {
    return {
      committed: false,
      compose: isNormalizedCompose(deployment.appSnapshot),
      retainedImageTags: [],
      state: deployment.state,
    };
  }
  const retainedReleases = await getTowbarDatabase()
    .select({ imageTag: releases.imageTag })
    .from(releases)
    .where(
      and(
        eq(releases.appId, deployment.appId),
        inArray(releases.status, ["current", "previous"]),
        deployment.previewEnvironmentId
          ? eq(releases.previewEnvironmentId, deployment.previewEnvironmentId)
          : eq(releases.environment, "production"),
      ),
    );
  const rollbackReservations = await getTowbarDatabase()
    .select({
      rollbackReleaseSnapshot: deployments.rollbackReleaseSnapshot,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.appId, deployment.appId),
        eq(deployments.environment, deployment.environment),
        deployment.previewEnvironmentId
          ? eq(
              deployments.previewEnvironmentId,
              deployment.previewEnvironmentId,
            )
          : isNull(deployments.previewEnvironmentId),
        eq(deployments.kind, "rollback"),
        notInArray(deployments.state, [
          "cancelled",
          "failed",
          "succeeded",
          "succeeded_with_warnings",
          "skipped",
        ]),
      ),
    );
  return {
    committed: true,
    compose: isNormalizedCompose(deployment.appSnapshot),
    retainedImageTags: collectRetainedImageTags(
      retainedReleases,
      rollbackReservations,
    ),
    state: deployment.state,
  };
}

export async function commitDeploymentRelease(
  deploymentId: string,
  input: ReleaseCommitPayload,
) {
  const [owner] = await getTowbarDatabase()
    .select({ workspaceId: deployments.workspaceId })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!owner) throw notFound("Deployment");
  const result = await getTowbarDatabase().transaction(async (transaction) => {
    await lockDomainClaims(transaction, owner.workspaceId);
    const [deployment] = await transaction
      .select({
        id: deployments.id,
        workspaceId: deployments.workspaceId,
        appId: deployments.appId,
        appSnapshot: deployments.appSnapshot,
        commitSha: deployments.commitSha,
        deploymentDigest: deployments.deploymentDigest,
        sourceInputDigest: deployments.sourceInputDigest,
        environment: deployments.environment,
        gitRef: deployments.gitRef,
        admittedImageDigest: deployments.imageDigest,
        previewEnvironmentId: deployments.previewEnvironmentId,
      })
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .for("update")
      .limit(1);
    if (!deployment) throw notFound("Deployment");
    assertReleaseKindMatchesDeployment(deployment.appSnapshot, input);
    if (
      deployment.admittedImageDigest &&
      deployment.admittedImageDigest !== input.imageDigest
    ) {
      throw conflict(
        "The pulled image digest differs from the digest resolved at admission",
        "IMAGE_DIGEST_CHANGED",
      );
    }
    if (deployment.previewEnvironmentId) {
      const [environment] = await transaction
        .select({
          latestCommitSha: previewEnvironments.latestCommitSha,
          status: previewEnvironments.status,
        })
        .from(previewEnvironments)
        .where(eq(previewEnvironments.id, deployment.previewEnvironmentId))
        .for("update")
        .limit(1);
      if (
        !environment ||
        !["building", "healthy", "failed"].includes(environment.status)
      ) {
        throw conflict(
          "The Preview environment is no longer active",
          "PREVIEW_UNAVAILABLE",
        );
      }
      if (environment.latestCommitSha !== deployment.commitSha) {
        throw conflict(
          "A newer Preview commit is already available",
          "PREVIEW_SUPERSEDED",
        );
      }
    }
    const [existingRelease] = await transaction
      .select()
      .from(releases)
      .where(eq(releases.deploymentId, deploymentId))
      .limit(1);
    let release = existingRelease;
    // Activities are at-least-once. A replay after the first commit must not
    // demote the release that this same deployment already promoted.
    if (!release) {
      await publishDeploymentDomains(transaction, deployment);
      await transaction
        .update(releases)
        .set({ status: "superseded", supersededAt: new Date() })
        .where(
          and(
            eq(releases.appId, deployment.appId),
            eq(releases.status, "previous"),
            deployment.previewEnvironmentId
              ? eq(
                  releases.previewEnvironmentId,
                  deployment.previewEnvironmentId,
                )
              : eq(releases.environment, "production"),
          ),
        );
      await transaction
        .update(releases)
        .set({ status: "previous" })
        .where(
          and(
            eq(releases.appId, deployment.appId),
            eq(releases.status, "current"),
            deployment.previewEnvironmentId
              ? eq(
                  releases.previewEnvironmentId,
                  deployment.previewEnvironmentId,
                )
              : eq(releases.environment, "production"),
          ),
        );
      [release] = await transaction
        .insert(releases)
        .values({
          appId: deployment.appId,
          commitSha: deployment.commitSha,
          composeServices: input.composeServices ?? [],
          configDigest: digestValue(deployment.appSnapshot),
          deploymentDigest: deployment.deploymentDigest,
          containerName: input.containerName,
          containerNames: input.containerNames,
          deploymentId,
          imageDigest: input.imageDigest,
          imagePlatform: input.imagePlatform,
          imageTag: input.imageTag,
          environment: deployment.environment,
          gitRef: deployment.gitRef,
          previewEnvironmentId: deployment.previewEnvironmentId,
          sourceInputDigest: deployment.sourceInputDigest,
          status: "current",
        })
        .onConflictDoNothing({ target: releases.deploymentId })
        .returning();
      if (!release) {
        [release] = await transaction
          .select()
          .from(releases)
          .where(eq(releases.deploymentId, deploymentId))
          .limit(1);
      }
    }
    if (!release) throw new Error("Unable to commit deployment release");
    if (
      release.imageDigest &&
      (release.imageDigest !== input.imageDigest ||
        release.imagePlatform !== input.imagePlatform)
    ) {
      throw conflict(
        "The committed release has different image provenance",
        "RELEASE_PROVENANCE_CONFLICT",
      );
    }
    await transaction
      .update(deployments)
      .set({
        imageDigest: release.imageDigest ?? input.imageDigest,
        imagePlatform: release.imagePlatform ?? input.imagePlatform,
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));
    const runtimeCheckedAt = new Date();
    if (deployment.environment === "production") {
      await transaction
        .insert(deployableRuntimeStates)
        .values({
          appId: deployment.appId,
          checkedAt: runtimeCheckedAt,
          desiredState: "running",
          driftReasons: [],
          driftStatus: "in_sync",
          healthStatus: "healthy",
          observedContainerName: input.containerName,
          observedImage: input.imageTag,
          observedState: "running",
          updatedAt: runtimeCheckedAt,
        })
        .onConflictDoUpdate({
          target: deployableRuntimeStates.appId,
          set: {
            checkedAt: runtimeCheckedAt,
            desiredState: "running",
            driftReasons: [],
            driftStatus: "in_sync",
            healthStatus: "healthy",
            observedContainerName: input.containerName,
            observedImage: input.imageTag,
            observedState: "running",
            updatedAt: runtimeCheckedAt,
          },
        });
    }

    const retainedReleases = await transaction
      .select({ imageTag: releases.imageTag })
      .from(releases)
      .where(
        and(
          eq(releases.appId, deployment.appId),
          inArray(releases.status, ["current", "previous"]),
          deployment.previewEnvironmentId
            ? eq(releases.previewEnvironmentId, deployment.previewEnvironmentId)
            : eq(releases.environment, "production"),
        ),
      );
    const rollbackReservations = await transaction
      .select({
        rollbackReleaseSnapshot: deployments.rollbackReleaseSnapshot,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.appId, deployment.appId),
          eq(deployments.environment, deployment.environment),
          deployment.previewEnvironmentId
            ? eq(
                deployments.previewEnvironmentId,
                deployment.previewEnvironmentId,
              )
            : isNull(deployments.previewEnvironmentId),
          eq(deployments.kind, "rollback"),
          notInArray(deployments.state, [
            "cancelled",
            "failed",
            "succeeded",
            "succeeded_with_warnings",
            "skipped",
          ]),
        ),
      );
    return {
      release,
      retainedImageTags: collectRetainedImageTags(
        retainedReleases,
        rollbackReservations,
      ),
    };
  });
  return {
    release: result.release,
    retainedImageTags: result.retainedImageTags,
  };
}

async function getPreviewRuntimeId(previewEnvironmentId: string) {
  const [environment] = await getTowbarDatabase()
    .select({ runtimeId: previewEnvironments.runtimeId })
    .from(previewEnvironments)
    .where(eq(previewEnvironments.id, previewEnvironmentId))
    .limit(1);
  if (!environment) throw notFound("Preview environment");
  return environment.runtimeId;
}

export { deploymentStateSchema };
