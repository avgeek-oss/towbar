import { and, eq } from "drizzle-orm";
import {
  createPreviewAppSnapshot,
  isNormalizedCompose,
  isNormalizedResource,
  previewHostname,
  resolveRepositoryEnvironment,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  previewEnvironments,
  servers,
  sources,
} from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import { resolvePreviewConfiguration } from "./configuration.js";
import { assertRequiredInstanceSecrets } from "../apps/secrets.js";
import { getInstanceEnvironment } from "../apps/instance-environment.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueueDeployment } from "../../infrastructure/temporal.js";
import { publishPreviewDeploymentStatus } from "../deployments/preview-status.js";
import { emitDeploymentNotification } from "../notifications/events.js";
import { calculateReleaseDeploymentDigest } from "../sources/deployment-digests.js";
import {
  fetchRepositoryEnvironmentSnapshot,
  fetchRepositoryPullRequest,
  fetchRepositoryTree,
  sourceProviderClient,
} from "../sources/repository-provider.js";
import { withPreviewLifecycleLock } from "./lifecycle-lock.js";
import {
  previewPullRequestDisposition,
  samePreviewPullRequestRevision,
} from "./pull-request.js";
import { admitPreviewDeployment } from "./admission.js";

// Explicit editor action: revalidate the PR and use current manifest-owned
// infrastructure, while secret assignments remain owned by the persisted app ID.
export async function requestPreviewDeployment(input: {
  previewEnvironmentId: string;
  workspaceId: string;
  requestedBy: string | null;
  idempotencyKey?: string;
}) {
  const database = getTowbarDatabase();
  const [row] = await database
    .select({
      sourceId: previewEnvironments.sourceId,
      pullRequestNumber: previewEnvironments.pullRequestNumber,
    })
    .from(previewEnvironments)
    .where(
      and(
        eq(previewEnvironments.id, input.previewEnvironmentId),
        eq(previewEnvironments.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Preview");
  return withPreviewLifecycleLock(
    {
      sourceId: row.sourceId,
      pullRequestNumber: row.pullRequestNumber,
    },
    async () => {
      if (input.idempotencyKey) {
        const [existing] = await database
          .select({
            id: deployments.id,
            appId: deployments.appId,
            state: deployments.state,
            server: deployments.serverSnapshot,
            buildServer: deployments.buildServerSnapshot,
          })
          .from(deployments)
          .where(
            and(
              eq(deployments.workspaceId, input.workspaceId),
              eq(deployments.idempotencyKey, input.idempotencyKey),
              eq(deployments.previewEnvironmentId, input.previewEnvironmentId),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.state === "queued") {
            await enqueueDeployment({
              appId: existing.appId,
              deploymentId: existing.id,
              buildConcurrency:
                existing.buildServer?.buildConcurrency ??
                existing.server.buildConcurrency ??
                1,
              previewBuildConcurrency:
                existing.server.previewBuildConcurrency ?? 1,
              priority: "preview",
              serverIp: existing.buildServer?.ip ?? existing.server.ip,
            });
          }
          return { accepted: true, deploymentId: existing.id, replayed: true };
        }
      }
      return deployCurrentPreview(input);
    },
  );
}

async function deployCurrentPreview(input: {
  previewEnvironmentId: string;
  workspaceId: string;
  requestedBy: string | null;
  idempotencyKey?: string;
}) {
  const database = getTowbarDatabase();
  const [row] = await database
    .select({
      preview: previewEnvironments,
      app: apps,
      server: servers,
      source: sources,
    })
    .from(previewEnvironments)
    .innerJoin(apps, eq(apps.id, previewEnvironments.appId))
    .innerJoin(servers, eq(servers.id, apps.serverId))
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .where(
      and(
        eq(previewEnvironments.id, input.previewEnvironmentId),
        eq(previewEnvironments.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Preview");
  const { app, server, source, preview } = row;
  if (
    app.archivedAt ||
    source.status !== "active" ||
    isNormalizedResource(app.config) ||
    isNormalizedCompose(app.config) ||
    !app.config.preview?.enabled
  )
    throw conflict("Preview is no longer enabled for this app");
  if (!server.preparedAt || server.preparedConfigDigest !== server.configDigest)
    throw conflict("Prepare the server before deploying this preview");
  const environment = await getInstanceEnvironment({
    appId: app.id,
    workspaceId: input.workspaceId,
  });
  if (
    !environment ||
    environment.disconnectedAt ||
    !environment.previewsEnabled ||
    environment.mappingRevision !== environment.syncedMappingRevision ||
    !environment.latestManifestDigest
  )
    throw conflict(
      "Sync a connected environment with previews enabled before deploying",
    );
  const provider = await sourceProviderClient(source.id);
  const pullRequest = await fetchRepositoryPullRequest(
    provider,
    preview.pullRequestNumber,
  );
  if (
    previewPullRequestDisposition({
      pullRequest,
      repositoryName: source.repositoryName,
      repositoryOwner: source.repositoryOwner,
      sourceBranches: [environment.branch],
    }).action !== "deploy"
  )
    throw conflict("This pull request is no longer eligible for previews");
  const repositorySnapshot = await fetchRepositoryEnvironmentSnapshot({
    ...provider,
    commitSha: pullRequest.headSha,
  });
  const configuration = resolvePreviewConfiguration({
    resolved: resolveRepositoryEnvironment({
      ...repositorySnapshot,
      environment: environment.name,
      branch: environment.branch,
    }),
    target: app.config,
  });
  if (!configuration)
    throw conflict("This app does not enable previews in the PR configuration");
  const hostname = previewHostname({
    appId: app.id,
    domain: app.config.preview.domain,
    pullRequestNumber: preview.pullRequestNumber,
    sourceId: source.id,
  });
  if (server.id !== preview.serverId || hostname !== preview.hostname)
    throw conflict(
      "Preview infrastructure changed. Remove this preview before recreating it.",
    );
  const config = createPreviewAppSnapshot(configuration.config, {
    branch: pullRequest.headBranch,
    hostname,
  });
  const repositoryTree = configuration.config.deploymentInputs.length
    ? await fetchRepositoryTree(provider, pullRequest.headSha)
    : undefined;
  const digests = calculateReleaseDeploymentDigest({
    commitSha: pullRequest.headSha,
    deployable: config,
    deploymentInputs: configuration.config.deploymentInputs,
    repositoryTree,
    server: server.config,
  });
  await assertRequiredInstanceSecrets({
    appId: app.id,
    config,
    sourceId: source.id,
    workspaceId: input.workspaceId,
    preview: true,
    declarations: configuration.requiredSecrets,
  });
  const latestPullRequest = await fetchRepositoryPullRequest(
    provider,
    preview.pullRequestNumber,
  );
  if (!samePreviewPullRequestRevision(pullRequest, latestPullRequest))
    throw conflict(
      "The pull request changed. Retry against its latest revision.",
      "PREVIEW_REVISION_CHANGED",
    );
  const admission = await admitPreviewDeployment({
    requiredSecrets: configuration.requiredSecrets,
    targetEnvironment: environment,
    targetConfigDigest: app.configDigest,
    appId: app.id,
    branch: pullRequest.headBranch,
    commitSha: pullRequest.headSha,
    config,
    ...digests,
    hostname,
    manifestDigest: configuration.manifestDigest,
    pullRequestNumber: preview.pullRequestNumber,
    server: server.config,
    serverId: server.id,
    sourceId: source.id,
    ttlHours: app.config.preview.ttlHours,
    workspaceId: input.workspaceId,
    force: true,
    manualIdempotencyKey: input.idempotencyKey,
    requestedBy: input.requestedBy,
  });
  if (!admission.created || !admission.deploymentId)
    throw conflict("Preview cannot be deployed while cleanup is active");
  await emitDeploymentNotification(
    admission.deploymentId,
    "deployment.queued",
  ).catch(() => undefined);
  await publishPreviewDeploymentStatus(admission.deploymentId, "queued").catch(
    () => undefined,
  );
  await enqueueDeployment({
    appId: app.id,
    buildConcurrency: server.config.buildConcurrency ?? 1,
    deploymentId: admission.deploymentId,
    previewBuildConcurrency: server.config.previewBuildConcurrency ?? 1,
    priority: "preview",
    serverIp: server.config.ip,
  });
  return {
    accepted: true,
    deploymentId: admission.deploymentId,
    replayed: false,
  };
}
