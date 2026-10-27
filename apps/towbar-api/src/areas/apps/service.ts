import { assertManifestManaged } from "../manifest-lifecycle/guards.js";
import { requestPreviewDeployment } from "../previews/manual-deployment.js";
import { assertNoRunningCleanup } from "../resource-operations/server-cleanup.js";
import {
  lockDomainClaims,
  reserveDeploymentDomains,
} from "../deployments/domain-claims.js";
/* eslint-disable max-lines -- App lifecycle queries and mutations share one transactional service boundary. */
import { captureQueuedActor } from "../auth/actor-context.js";
import {
  lockRollbackInstance,
  requireServerReady,
} from "./deployment-guards.js";
import { deploymentEnvironmentSnapshot } from "./instance-environment.js";
import { randomUUID } from "node:crypto";

import { and, desc, eq, notInArray } from "drizzle-orm";

import { deploymentWorkflowId } from "@workspace/towbar-core/temporal";
import {
  digestValue,
  getDeployableDeploymentDigest,
  isNormalizedCompose,
  isNormalizedResource,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  releases,
  servers,
  sources,
} from "@workspace/towbar-database/schema";

import { conflict, notFound, unprocessable } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueueDeployment } from "../../infrastructure/temporal.js";
import { publicDeploymentSelection } from "../deployment-selection.js";
import { emitDeploymentNotification } from "../notifications/events.js";
import { scopeDeploymentIdempotencyKey } from "./idempotency.js";
import {
  getInstanceEnvironment,
  lockDeploymentEnvironment,
} from "./instance-environment.js";
import { assertRequiredInstanceSecrets } from "./secrets.js";
import { getApp, getResource } from "./queries.js";
import { resolveBuildServerAdmission } from "./build-server-admission.js";
import { admitApplicationImage } from "../deployments/image-admission.js";
import { cloudflareDnsCredential } from "../deployments/cloudflare-readiness.js";
import {
  hostLogDeploymentPermissions,
  requireHostLogCollection,
  rollbackHostLogConfiguration,
} from "./host-log-collection.js";

export { getApp, getResource, listApps, listResources } from "./queries.js";

export async function listAppDeployments(
  appId: string,
  workspaceId: string,
  environment: "production" | "preview" = "production",
) {
  await getApp(appId, workspaceId);
  return await getTowbarDatabase()
    .select(publicDeploymentSelection)
    .from(deployments)
    .where(
      and(
        eq(deployments.appId, appId),
        eq(deployments.environment, environment),
      ),
    )
    .orderBy(desc(deployments.createdAt));
}

export async function listAppReleases(appId: string, workspaceId: string) {
  await getApp(appId, workspaceId);
  return await getTowbarDatabase()
    .select()
    .from(releases)
    .where(
      and(eq(releases.appId, appId), eq(releases.environment, "production")),
    )
    .orderBy(desc(releases.promotedAt));
}

export async function listResourceDeployments(
  resourceId: string,
  workspaceId: string,
) {
  await getResource(resourceId, workspaceId);
  return await getTowbarDatabase()
    .select(publicDeploymentSelection)
    .from(deployments)
    .where(
      and(
        eq(deployments.appId, resourceId),
        eq(deployments.environment, "production"),
      ),
    )
    .orderBy(desc(deployments.createdAt));
}

export async function listResourceReleases(
  resourceId: string,
  workspaceId: string,
) {
  await getResource(resourceId, workspaceId);
  return await getTowbarDatabase()
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.appId, resourceId),
        eq(releases.environment, "production"),
      ),
    )
    .orderBy(desc(releases.promotedAt));
}

export async function requestAppDeployment(input: {
  appId: string;
  expectedCommitSha?: string;
  idempotencyKey: string;
  requestedBy: string | null;
  workspaceId: string;
  expectedType?: "app" | "resource";
}) {
  const request = {
    ...input,
    idempotencyKey: scopeDeploymentIdempotencyKey("deploy", input),
  };
  const database = getTowbarDatabase();
  const existing = await findIdempotentDeployment(request);
  if (existing) return { deployment: existing, replayed: true };

  const target = await getAppForDeployment(request.appId, request.workspaceId);
  requireDeployableType(target.config, request.expectedType ?? "app");
  if (target.archivedAt) {
    throw conflict("Archived apps cannot be deployed");
  }
  if (!target.commitSha || !target.deploymentDigest || !target.manifestDigest) {
    throw unprocessable("The Source must have a successful sync before deploy");
  }
  requireServerReady(target);
  requireHostLogCollection(target.serverConfig, target.config);
  cloudflareDnsCredential(target.config);
  await assertRequiredInstanceSecrets({
    appId: target.id,
    config: target.config,
    sourceId: target.sourceId,
    workspaceId: request.workspaceId,
  });
  const imageAdmission = await admitApplicationImage({
    deployable: target.config,
    environment: target.environment.name,
    sourceId: target.sourceId,
    workspaceId: request.workspaceId,
  });
  const commitSha = target.commitSha;
  const deploymentDigest = target.deploymentDigest;
  const manifestDigest = target.manifestDigest;
  if (request.expectedCommitSha && commitSha !== request.expectedCommitSha) {
    throw conflict(
      "A newer Source revision is already available",
      "SOURCE_REVISION_SUPERSEDED",
    );
  }
  const deploymentId = randomUUID();
  let admission;
  try {
    admission = await database.transaction(async (transaction) => {
      await lockDomainClaims(transaction, request.workspaceId);
      await assertNoRunningCleanup(transaction, request.workspaceId);
      await assertManifestManaged(transaction, target.id);
      await lockDeploymentEnvironment(target.environment, transaction);
      const [currentApp] = await transaction
        .select({
          archivedAt: apps.archivedAt,
          deploymentDigest: apps.deploymentDigest,
          id: apps.id,
          serverConfig: servers.config,
          serverConfigDigest: servers.configDigest,
          serverPreparedAt: servers.preparedAt,
          serverPreparedConfigDigest: servers.preparedConfigDigest,
          sourceRevision: apps.sourceRevision,
        })
        .from(apps)
        .innerJoin(servers, eq(servers.id, apps.serverId))
        .where(
          and(
            eq(apps.id, target.id),
            eq(apps.workspaceId, request.workspaceId),
          ),
        )
        .for("update");
      if (!currentApp) throw notFound("App");
      if (currentApp.archivedAt)
        throw conflict("Archived apps cannot be deployed");
      requireServerReady(currentApp);
      requireHostLogCollection(currentApp.serverConfig, target.config);
      if (
        currentApp.sourceRevision !== commitSha ||
        currentApp.deploymentDigest !== deploymentDigest
      ) {
        throw conflict(
          "A newer Source revision is already available",
          "SOURCE_REVISION_SUPERSEDED",
        );
      }
      const buildServer = await resolveBuildServerAdmission(transaction, {
        deployable: target.config,
        runtimeServerId: target.serverId,
        workspaceId: request.workspaceId,
      });
      if (!request.requestedBy) {
        const [sameDeployment] = await transaction
          .select({ id: deployments.id })
          .from(deployments)
          .where(
            and(
              eq(deployments.appId, target.id),
              eq(deployments.environment, "production"),
              eq(deployments.deploymentDigest, deploymentDigest),
              notInArray(deployments.state, [
                "cancelled",
                "failed",
                "skipped",
                "succeeded",
                "succeeded_with_warnings",
              ]),
            ),
          )
          .orderBy(desc(deployments.createdAt))
          .limit(1);
        if (sameDeployment) {
          return { deploymentId: sameDeployment.id, replayed: true };
        }
      }
      const now = new Date();
      await transaction
        .update(deployments)
        .set({
          errorCode: "DEPLOYMENT_SUPERSEDED",
          errorMessage: "Superseded by a newer deployment request",
          finishedAt: now,
          state: "skipped",
          updatedAt: now,
        })
        .where(
          and(
            eq(deployments.appId, target.id),
            eq(deployments.environment, "production"),
            eq(deployments.state, "queued"),
          ),
        );
      const deploymentValues: typeof deployments.$inferInsert = {
        appId: target.id,
        appSnapshot: imageAdmission.snapshot,
        requiredSecrets: target.requiredSecrets,
        targetEnvironment: deploymentEnvironmentSnapshot(target.environment),
        commitSha,
        configDigest: digestValue(imageAdmission.snapshot),
        deploymentDigest,
        deployableKind: target.kind,
        id: deploymentId,
        idempotencyKey: request.idempotencyKey,
        manifestDigest,
        imageDigest: imageAdmission.imageDigest,
        imageSourceReference: imageAdmission.imageSourceReference,
        requestedBy: request.requestedBy,
        ...captureQueuedActor(
          request.workspaceId,
          hostLogDeploymentPermissions(target.config),
        ),
        serverId: target.serverId,
        serverSnapshot: target.serverConfig,
        buildServerId: buildServer?.id,
        buildServerSnapshot: buildServer?.snapshot,
        sourceId: target.sourceId,
        sourceInputDigest: target.sourceInputDigest,
        temporalWorkflowId: deploymentWorkflowId(deploymentId),
        workspaceId: request.workspaceId,
      };
      const [created] = await transaction
        .insert(deployments)
        .values(deploymentValues)
        .returning();
      if (!created) throw new Error("Unable to admit deployment");
      await reserveDeploymentDomains(transaction, created);
      return {
        buildServer,
        deploymentId: created.id,
        replayed: false,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replay = await findIdempotentDeployment(request);
      if (replay) return { deployment: replay, replayed: true };
    }
    throw error;
  }
  if (!admission) throw new Error("Unable to admit deployment");
  if (admission.replayed) {
    return {
      deployment: await getPublicDeployment(
        admission.deploymentId,
        request.workspaceId,
      ),
      replayed: true,
    };
  }
  await emitDeploymentNotification(deploymentId, "deployment.queued").catch(
    () => undefined,
  );
  try {
    await enqueueDeployment({
      appId: target.id,
      buildConcurrency:
        admission.buildServer?.snapshot.buildConcurrency ??
        target.serverConfig.buildConcurrency ??
        1,
      deploymentId,
      previewBuildConcurrency: target.serverConfig.previewBuildConcurrency ?? 1,
      serverIp: admission.buildServer?.snapshot.ip ?? target.serverIp,
    });
  } catch (error) {
    await database
      .update(deployments)
      .set({
        errorCode: "TEMPORAL_UNAVAILABLE",
        errorMessage: "Deployment queue is unavailable",
        finishedAt: new Date(),
        state: "failed",
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));
    await emitDeploymentNotification(deploymentId, "deployment.failed").catch(
      () => undefined,
    );
    throw error;
  }
  return {
    deployment: await getPublicDeployment(
      admission.deploymentId,
      request.workspaceId,
    ),
    replayed: false,
  };
}

export async function requestAppRollback(input: {
  appId: string;
  idempotencyKey: string;
  releaseId?: string;
  requestedBy: string | null;
  workspaceId: string;
  expectedType?: "app" | "resource";
}) {
  const request = {
    ...input,
    idempotencyKey: scopeDeploymentIdempotencyKey("rollback", input),
  };
  const existing = await findIdempotentDeployment(request);
  if (existing) return { deployment: existing, replayed: true };

  const app = await getAppForDeployment(request.appId, request.workspaceId);
  requireDeployableType(app.config, request.expectedType ?? "app");
  if (app.archivedAt) {
    throw conflict("Archived apps cannot be rolled back");
  }
  requireServerReady(app);
  const conditions = [
    eq(releases.appId, app.id),
    eq(releases.status, "previous"),
    eq(releases.environment, "production"),
  ];
  if (request.releaseId) conditions.push(eq(releases.id, request.releaseId));
  const [release] = await getTowbarDatabase()
    .select()
    .from(releases)
    .where(and(...conditions))
    .orderBy(desc(releases.promotedAt))
    .limit(1);
  if (!release) throw notFound("Release");

  const [original] = await getTowbarDatabase()
    .select()
    .from(deployments)
    .where(eq(deployments.id, release.deploymentId))
    .limit(1);
  if (!original) throw notFound("Release deployment");
  if (original.serverId !== app.serverId)
    throw conflict("The rollback release belongs to a different server");
  requireHostLogCollection(app.serverConfig, app.config, original.appSnapshot);
  const rollbackUsesSource = isNormalizedCompose(original.appSnapshot);
  const rollbackApp = rollbackUsesSource
    ? original.appSnapshot
    : rollbackHostLogConfiguration(app.config, original.appSnapshot);
  const rollbackRuntimeChanged =
    digestValue(rollbackApp) !== digestValue(app.config);
  cloudflareDnsCredential(rollbackApp);
  const deploymentId = randomUUID();
  let deployment;
  try {
    deployment = await getTowbarDatabase().transaction(async (transaction) => {
      await lockDomainClaims(transaction, input.workspaceId);
      await assertNoRunningCleanup(transaction, input.workspaceId);
      await assertManifestManaged(transaction, app.id);
      await lockDeploymentEnvironment(app.environment, transaction);
      const current = await lockRollbackInstance(
        transaction,
        app.id,
        request.workspaceId,
      );
      if (!current) throw notFound("App");
      if (current.archivedAt)
        throw conflict("Archived apps cannot be rolled back");
      requireServerReady(current);
      requireHostLogCollection(
        current.serverConfig,
        app.config,
        original.appSnapshot,
      );
      if (
        current.configDigest !== app.configDigest ||
        current.deploymentDigest !== app.deploymentDigest ||
        current.serverId !== app.serverId ||
        current.serverConfigDigest !== app.serverConfigDigest
      )
        throw conflict(
          "The instance changed. Retry the rollback.",
          "SOURCE_REVISION_SUPERSEDED",
        );
      const [retained] = await transaction
        .select({ id: releases.id })
        .from(releases)
        .where(and(eq(releases.id, release.id), ...conditions))
        .for("update");
      if (!retained)
        throw conflict("The rollback release is no longer available");
      const [admitted] = await transaction
        .insert(deployments)
        .values({
          appId: app.id,
          appSnapshot: rollbackApp,
          requiredSecrets: rollbackUsesSource
            ? original.requiredSecrets
            : app.requiredSecrets,
          targetEnvironment: deploymentEnvironmentSnapshot(app.environment),
          commitSha: rollbackUsesSource
            ? release.commitSha
            : (app.commitSha ?? original.commitSha),
          configDigest: rollbackUsesSource
            ? original.configDigest
            : digestValue(rollbackApp),
          deploymentDigest: rollbackUsesSource
            ? original.deploymentDigest
            : rollbackRuntimeChanged
              ? getDeployableDeploymentDigest({
                  deployable: rollbackApp,
                  server: app.serverConfig,
                  sourceInputDigest: app.sourceInputDigest,
                })
              : (app.deploymentDigest ?? original.deploymentDigest),
          deployableKind: original.deployableKind,
          id: deploymentId,
          idempotencyKey: request.idempotencyKey,
          kind: "rollback",
          manifestDigest: rollbackUsesSource
            ? original.manifestDigest
            : (app.manifestDigest ?? original.manifestDigest),
          requestedBy: request.requestedBy,
          ...captureQueuedActor(
            request.workspaceId,
            hostLogDeploymentPermissions(app.config, original.appSnapshot),
          ),
          rollbackReleaseSnapshot: {
            commitSha: release.commitSha,
            containerName: release.containerName,
            imageTag: release.imageTag,
            releaseId: release.id,
            sourceDeploymentId: release.deploymentId,
          },
          serverId: app.serverId,
          serverSnapshot: app.serverConfig,
          sourceId: app.sourceId,
          sourceInputDigest: rollbackUsesSource
            ? original.sourceInputDigest
            : app.sourceInputDigest,
          temporalWorkflowId: deploymentWorkflowId(deploymentId),
          workspaceId: request.workspaceId,
        })
        .returning();
      if (!admitted) throw new Error("Unable to admit rollback");
      await reserveDeploymentDomains(transaction, admitted);
      return admitted;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replay = await findIdempotentDeployment(request);
      if (replay) return { deployment: replay, replayed: true };
    }
    throw error;
  }
  if (!deployment) throw new Error("Unable to admit rollback");
  await emitDeploymentNotification(deploymentId, "deployment.queued").catch(
    () => undefined,
  );
  try {
    await enqueueDeployment({
      appId: deployment.appId,
      buildConcurrency: deployment.serverSnapshot.buildConcurrency ?? 1,
      deploymentId,
      previewBuildConcurrency:
        deployment.serverSnapshot.previewBuildConcurrency ?? 1,
      serverIp: deployment.serverSnapshot.ip,
    });
  } catch (error) {
    await getTowbarDatabase()
      .update(deployments)
      .set({
        errorCode: "TEMPORAL_UNAVAILABLE",
        errorMessage: "Deployment queue is unavailable",
        finishedAt: new Date(),
        state: "failed",
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));
    await emitDeploymentNotification(deploymentId, "deployment.failed").catch(
      () => undefined,
    );
    throw error;
  }
  return {
    deployment: await getPublicDeployment(deployment.id, request.workspaceId),
    replayed: false,
  };
}

export async function requestDeploymentRetry(input: {
  deploymentId: string;
  idempotencyKey: string;
  requestedBy: string | null;
  workspaceId: string;
}) {
  const [original] = await getTowbarDatabase()
    .select({
      appId: deployments.appId,
      appSnapshot: deployments.appSnapshot,
      environment: deployments.environment,
      previewEnvironmentId: deployments.previewEnvironmentId,
      kind: deployments.kind,
      rollbackReleaseSnapshot: deployments.rollbackReleaseSnapshot,
      state: deployments.state,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.id, input.deploymentId),
        eq(deployments.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!original) throw notFound("Deployment");
  if (original.state !== "failed" && original.state !== "cancelled") {
    throw conflict("Only failed or cancelled deployments can be retried");
  }

  if (original.environment === "preview") {
    if (!original.previewEnvironmentId) throw notFound("Preview");
    const result = await requestPreviewDeployment({
      previewEnvironmentId: original.previewEnvironmentId,
      workspaceId: input.workspaceId,
      requestedBy: input.requestedBy,
      idempotencyKey: `preview:retry:${digestValue(JSON.stringify({ deploymentId: input.deploymentId, key: input.idempotencyKey }))}`,
    });
    return {
      deployment: await getPublicDeployment(
        result.deploymentId,
        input.workspaceId,
      ),
      replayed: result.replayed,
    };
  }

  if (original.kind === "rollback") {
    if (!original.rollbackReleaseSnapshot) {
      throw conflict("Rollback deployment is missing its release snapshot");
    }
    return await requestAppRollback({
      appId: original.appId,
      idempotencyKey: input.idempotencyKey,
      releaseId: original.rollbackReleaseSnapshot.releaseId,
      requestedBy: input.requestedBy,
      workspaceId: input.workspaceId,
      expectedType: isNormalizedResource(original.appSnapshot)
        ? "resource"
        : "app",
    });
  }

  return await requestAppDeployment({
    appId: original.appId,
    idempotencyKey: input.idempotencyKey,
    requestedBy: input.requestedBy,
    workspaceId: input.workspaceId,
    expectedType: isNormalizedResource(original.appSnapshot)
      ? "resource"
      : "app",
  });
}

async function getAppForDeployment(appId: string, workspaceId: string) {
  const [app] = await getTowbarDatabase()
    .select({
      archivedAt: apps.archivedAt,
      requiredSecrets: apps.requiredSecrets,
      config: apps.config,
      configDigest: apps.configDigest,
      deploymentDigest: apps.deploymentDigest,
      id: apps.id,
      kind: apps.kind,
      serverConfig: servers.config,
      serverId: servers.id,
      serverIp: servers.canonicalIp,
      serverPreparedAt: servers.preparedAt,
      serverPreparedConfigDigest: servers.preparedConfigDigest,
      serverConfigDigest: servers.configDigest,
      sourceId: sources.id,
      sourceInputDigest: apps.sourceInputDigest,
    })
    .from(apps)
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .innerJoin(servers, eq(servers.id, apps.serverId))
    .where(and(eq(apps.id, appId), eq(apps.workspaceId, workspaceId)))
    .limit(1);
  if (!app) throw notFound("App");
  const environment = await getInstanceEnvironment({ appId, workspaceId });
  if (!environment)
    throw conflict(
      "This instance requires an environment mapping",
      "ENVIRONMENT_REQUIRED",
    );
  if (environment.disconnectedAt)
    throw conflict(
      "This environment is disconnected",
      "ENVIRONMENT_DISCONNECTED",
    );
  if (environment.mappingRevision !== environment.syncedMappingRevision) {
    throw conflict(
      "Sync this environment after changing its branch or repository connection before deploying",
      "ENVIRONMENT_SYNC_REQUIRED",
    );
  }
  return {
    ...app,
    environment,
    commitSha: environment.latestCommitSha,
    manifestDigest: environment.latestManifestDigest,
  };
}

function requireDeployableType(
  config: (typeof apps.$inferSelect)["config"],
  expectedType: "app" | "resource",
) {
  const actualType = isNormalizedResource(config) ? "resource" : "app";
  if (actualType !== expectedType) {
    throw notFound(expectedType === "app" ? "App" : "Resource");
  }
}

async function findIdempotentDeployment(input: {
  appId: string;
  idempotencyKey: string;
  workspaceId: string;
}) {
  const [existing] = await getTowbarDatabase()
    .select(publicDeploymentSelection)
    .from(deployments)
    .where(
      and(
        eq(deployments.workspaceId, input.workspaceId),
        eq(deployments.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing && existing.appId !== input.appId) {
    throw conflict(
      "This Idempotency-Key was already used for a different app",
      "IDEMPOTENCY_KEY_CONFLICT",
    );
  }
  return existing;
}

async function getPublicDeployment(deploymentId: string, workspaceId: string) {
  const [deployment] = await getTowbarDatabase()
    .select(publicDeploymentSelection)
    .from(deployments)
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!deployment) throw notFound("Deployment");
  return deployment;
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
