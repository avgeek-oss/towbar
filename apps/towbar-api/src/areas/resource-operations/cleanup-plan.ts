import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import {
  type ServerCleanupPlan,
  deploymentPublicHostnames,
  isNormalizedResource,
} from "@workspace/towbar-core";
import { terminalDeploymentStates } from "@workspace/towbar-core/temporal";
import {
  apps,
  deployments,
  domainClaims,
  previewEnvironments,
  releases,
  resourceOperations,
  serverDeployableOwnership,
  servers,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { notFound } from "../../http/errors.js";
import type { SecretDatabase } from "../secrets/store.js";

export async function getCleanupExpected(
  serverId: string,
  database: SecretDatabase = getTowbarDatabase(),
  retirementId?: string,
): Promise<ServerCleanupPlan & { ownedDeployableIds: string[] }> {
  const [server] = await database
    .select()
    .from(servers)
    .where(eq(servers.id, serverId));
  if (!server) throw notFound("Server");
  const instances = await database
    .select()
    .from(apps)
    .where(eq(apps.workspaceId, server.workspaceId));
  const history = await database
    .select()
    .from(deployments)
    .where(eq(deployments.workspaceId, server.workspaceId));
  const ownership = await database
    .select()
    .from(serverDeployableOwnership)
    .where(eq(serverDeployableOwnership.serverId, serverId));
  const owned = new Set([
    ...ownership.map((row) => row.deployableId),
    ...instances
      .filter((app) => app.serverId === serverId)
      .map((app) => app.id),
    ...history
      .filter(
        (deployment) =>
          deployment.serverId === serverId ||
          deployment.buildServerId === serverId,
      )
      .map((deployment) => deployment.appId),
  ]);
  const protectedIds = new Set(
    history
      .filter(
        (deployment) =>
          !terminalDeploymentStates.has(deployment.state) ||
          [
            "DEPLOYMENT_COMMIT_UNCERTAIN",
            "DEPLOYMENT_INTERRUPTED_CLEANUP_PENDING",
            "DOMAIN_HANDOFF_RECOVERY_REQUIRED",
          ].includes(deployment.errorCode ?? ""),
      )
      .map((deployment) => deployment.appId),
  );
  const pendingOperations = await database
    .select()
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.workspaceId, server.workspaceId),
        inArray(resourceOperations.state, ["queued", "running"]),
      ),
    );
  for (const operation of pendingOperations)
    if (operation.resourceId) protectedIds.add(operation.resourceId);
  const claims = await database
    .select()
    .from(domainClaims)
    .where(eq(domainClaims.workspaceId, server.workspaceId));
  for (const claim of claims) {
    // A successor deployment owns the route transition, including cross-server handoffs.
    const ownerId = claim.activeAppId ?? claim.releasedAppId;
    if (
      ownerId &&
      (claim.pendingDeploymentId ||
        (claim.desiredAppId && claim.desiredAppId !== ownerId))
    )
      protectedIds.add(ownerId);
  }
  for (const app of instances)
    if (app.manifestState !== "removed" && app.id !== retirementId)
      protectedIds.add(app.id);
  const activeIds = instances
    .filter((app) => !app.archivedAt)
    .map((app) => app.id);
  const retained = activeIds.length
    ? await database
        .select()
        .from(releases)
        .where(
          and(
            inArray(releases.appId, activeIds),
            inArray(releases.status, ["current", "previous"]),
            isNull(releases.retiredAt),
          ),
        )
    : [];
  const retiringApps = instances.filter(
    (app) =>
      app.id === retirementId &&
      app.manifestState === "removing" &&
      owned.has(app.id) &&
      app.archivedAt &&
      !protectedIds.has(app.id),
  );
  const previews = retiringApps.length
    ? await database
        .select()
        .from(previewEnvironments)
        .where(
          inArray(
            previewEnvironments.appId,
            retiringApps.map((app) => app.id),
          ),
        )
    : [];
  const retiredReleases = retiringApps.length
    ? await database
        .select({
          appId: releases.appId,
          project: releases.containerName,
          app: deployments.appSnapshot,
        })
        .from(releases)
        .innerJoin(deployments, eq(deployments.id, releases.deploymentId))
        .where(
          and(
            eq(deployments.serverId, serverId),
            inArray(
              releases.appId,
              retiringApps.map((app) => app.id),
            ),
          ),
        )
    : [];
  return {
    ownedDeployableIds: [...owned],
    deployableIds: activeIds,
    protectedDeployableIds: [...protectedIds],
    containerNames: retained.flatMap((release) => [
      release.containerName,
      ...release.containerNames,
    ]),
    composeProjects: retained.map((release) => release.containerName),
    imageTags: [
      ...retained.map((release) => release.imageTag),
      ...instances
        .filter((app) => !app.archivedAt)
        .flatMap(({ config }) =>
          isNormalizedResource(config)
            ? [config.image]
            : config.deployment?.type === "image"
              ? [config.deployment.image]
              : [],
        ),
    ],
    retiring: retiringApps.map((app) => {
      const runtimeIds = [
        app.id,
        ...previews
          .filter((preview) => preview.appId === app.id)
          .map((preview) => preview.runtimeId),
      ];
      // Failed Compose attempts can leave labeled storage before a release is recorded.
      const usedCompose = history.some(
        (deployment) =>
          deployment.appId === app.id &&
          deployment.serverId === serverId &&
          deployment.appSnapshot.kind === "compose",
      );
      return {
        deployableId: app.id,
        sourceId: app.sourceId,
        runtimeIds,
        composeProjects: [
          ...new Set([
            ...retiredReleases
              .filter(
                (release) =>
                  release.appId === app.id && release.app.kind === "compose",
              )
              .map((release) => release.project),
            ...(usedCompose
              ? runtimeIds.map((runtime) => `towbar-${runtime}`.slice(0, 63))
              : []),
          ]),
        ],
      };
    }),
  };
}

export async function recordRetiredWorkloads(
  database: SecretDatabase,
  operation: typeof resourceOperations.$inferSelect,
  retiredIds: string[],
) {
  if (operation.request.type !== "cleanup_orphans") return;
  const allowed = operation.request.retiringDeployableIds ?? [];
  const ids = retiredIds.filter((id) => allowed.includes(id));
  if (!ids.length) return;
  const archived = await database
    .select({ id: apps.id, archivedAt: apps.archivedAt })
    .from(apps)
    .where(
      and(eq(apps.workspaceId, operation.workspaceId), inArray(apps.id, ids)),
    );
  const eligible = archived
    .filter((app) => app.archivedAt)
    .map((app) => app.id);
  if (!eligible.length) return;
  const retiredDeployments = database
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.serverId, operation.serverId),
        inArray(deployments.appId, eligible),
      ),
    );
  await database
    .update(releases)
    .set({
      retiredAt: new Date(),
      status: "superseded",
      supersededAt: new Date(),
    })
    .where(
      and(
        inArray(releases.deploymentId, retiredDeployments),
        isNull(releases.retiredAt),
      ),
    );
  const stillServing = await database
    .select({ appId: releases.appId, app: deployments.appSnapshot })
    .from(releases)
    .innerJoin(deployments, eq(deployments.id, releases.deploymentId))
    .where(
      and(
        eq(deployments.workspaceId, operation.workspaceId),
        eq(releases.environment, "production"),
        eq(releases.status, "current"),
        isNull(releases.retiredAt),
      ),
    );
  const retiredReleases = await database
    .select({ deploymentId: releases.deploymentId })
    .from(releases)
    .where(
      and(inArray(releases.appId, eligible), isNotNull(releases.retiredAt)),
    );
  const retiredDeploymentIds = new Set(
    retiredReleases.map((release) => release.deploymentId),
  );
  const claims = await database
    .select()
    .from(domainClaims)
    .where(
      and(
        eq(domainClaims.workspaceId, operation.workspaceId),
        or(
          inArray(domainClaims.activeAppId, eligible),
          inArray(domainClaims.releasedAppId, eligible),
        ),
      ),
    );
  for (const claim of claims) {
    const ownerId = claim.activeAppId ?? claim.releasedAppId;
    if (
      !ownerId ||
      !eligible.includes(ownerId) ||
      (claim.activeDeploymentId !== null &&
        !retiredDeploymentIds.has(claim.activeDeploymentId)) ||
      claim.pendingDeploymentId ||
      stillServing.some(
        (release) =>
          release.appId === ownerId &&
          deploymentPublicHostnames(release.app).includes(claim.hostname),
      )
    )
      continue;
    await database
      .update(domainClaims)
      .set({
        activeAppId: null,
        activeDeploymentId: null,
        releasedAppId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(domainClaims.workspaceId, operation.workspaceId),
          eq(domainClaims.hostname, claim.hostname),
        ),
      );
  }
}
