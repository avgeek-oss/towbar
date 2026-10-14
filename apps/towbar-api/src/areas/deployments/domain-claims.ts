import { reconciliationHostnames } from "./domain-claim-scope.js";
import type { DomainClaimScope } from "./domain-claim-scope.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  deploymentCloudflareDnsDomains,
  deploymentPublicHostnames,
  deploymentTunnelHostnames,
} from "@workspace/towbar-core";
import { terminalDeploymentStates } from "@workspace/towbar-core/temporal";
import {
  apps,
  deployments,
  domainClaims,
  releases,
  servers,
  sshHostKeys,
} from "@workspace/towbar-database/schema";
import { conflict } from "../../http/errors.js";
import type { DomainHandoff } from "@workspace/towbar-core";
import type { SecretDatabase } from "../secrets/store.js";

export async function lockDomainClaims(
  database: SecretDatabase,
  workspaceId: string,
) {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('towbar:domain-claims', 0))`,
  );
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`source-sync:${workspaceId}`}, 0))`,
  );
}

// Also seeds existing installations from retained releases, before their first new sync.
export async function synchronizeDomainClaims(
  database: SecretDatabase,
  workspaceId: string,
  scope?: DomainClaimScope,
) {
  const instances = await database
    .select()
    .from(apps)
    .where(eq(apps.workspaceId, workspaceId));
  const retained = await database
    .select({
      appId: releases.appId,
      deploymentId: releases.deploymentId,
      status: releases.status,
      app: deployments.appSnapshot,
    })
    .from(releases)
    .innerJoin(deployments, eq(deployments.id, releases.deploymentId))
    .where(
      and(
        eq(deployments.workspaceId, workspaceId),
        eq(releases.environment, "production"),
        isNull(releases.retiredAt),
      ),
    )
    .orderBy(desc(releases.promotedAt));
  const previous = await database
    .select()
    .from(domainClaims)
    .where(eq(domainClaims.workspaceId, workspaceId));
  const byHostname = new Map(previous.map((claim) => [claim.hostname, claim]));
  const hostnames = reconciliationHostnames({
    instances,
    previous,
    retained,
    scope,
  });
  const desired = new Map<string, typeof apps.$inferSelect>();
  for (const app of instances.filter((app) => !app.archivedAt))
    for (const hostname of deploymentPublicHostnames(app.config)) {
      if (!hostnames.has(hostname)) continue;
      const owner = desired.get(hostname);
      if (owner && owner.id !== app.id)
        throw conflict(
          `Domain '${hostname}' is assigned to '${owner.name}'. Remove that assignment before moving it.`,
          "DOMAIN_CONFLICT",
        );
      desired.set(hostname, app);
    }
  if (desired.size) {
    const foreign = await database
      .select({ hostname: domainClaims.hostname })
      .from(domainClaims)
      .where(
        and(
          ne(domainClaims.workspaceId, workspaceId),
          inArray(domainClaims.hostname, [...desired.keys()]),
          or(
            isNotNull(domainClaims.desiredAppId),
            isNotNull(domainClaims.activeAppId),
          ),
        ),
      );
    const foreignReleases = await database
      .select({ app: deployments.appSnapshot })
      .from(releases)
      .innerJoin(deployments, eq(deployments.id, releases.deploymentId))
      .where(
        and(
          ne(deployments.workspaceId, workspaceId),
          eq(releases.environment, "production"),
          eq(releases.status, "current"),
          isNull(releases.retiredAt),
        ),
      );
    const foreignHostname =
      foreign[0]?.hostname ??
      foreignReleases
        .flatMap((release) => deploymentPublicHostnames(release.app))
        .find((hostname) => desired.has(hostname));
    if (foreignHostname)
      throw conflict(
        `Domain '${foreignHostname}' belongs to another Towbar workspace.`,
        "DOMAIN_CONFLICT",
      );
  }
  for (const hostname of [...hostnames].sort())
    await reconcileDomainClaim(database, {
      workspaceId,
      hostname,
      target: desired.get(hostname),
      claim: byHostname.get(hostname),
      retained,
      instances,
    });
}

async function reconcileDomainClaim(
  database: SecretDatabase,
  input: {
    workspaceId: string;
    hostname: string;
    target?: typeof apps.$inferSelect;
    claim?: typeof domainClaims.$inferSelect;
    retained: Array<{
      appId: string;
      deploymentId: string;
      status: string;
      app: import("@workspace/towbar-core").NormalizedDeployable;
    }>;
    instances: Array<typeof apps.$inferSelect>;
  },
) {
  const { workspaceId, hostname, target, claim, retained, instances } = input;
  const current = retained.filter(
    (release) =>
      release.status === "current" &&
      deploymentPublicHostnames(release.app).includes(hostname),
  );
  // Removal must not invent a single owner for ambiguous retained routes.
  // The releases continue reserving the hostname until server retirement succeeds.
  if (!claim && current.length > 1) {
    if (canRetireAmbiguousOwners(input, current)) return;
    throw conflict(
      `Domain '${hostname}' has multiple deployed owners. Reconcile the existing routes before deploying.`,
      "DOMAIN_CONFLICT",
    );
  }
  const last =
    current[0] ??
    retained.find((release) =>
      deploymentPublicHostnames(release.app).includes(hostname),
    );
  const lastApp = instances.find((app) => app.id === last?.appId);
  const environmentId =
    claim?.sourceEnvironmentId ??
    lastApp?.sourceEnvironmentId ??
    target?.sourceEnvironmentId;
  if (!environmentId) return;
  if (
    target &&
    target.sourceEnvironmentId !== environmentId &&
    (claim?.activeAppId || current.length)
  )
    throw conflict(
      `Domain '${hostname}' is still served by another environment. Release it there before assigning it here.`,
      "DOMAIN_CONFLICT",
    );
  if (!claim)
    return await seedDomainClaim(database, {
      workspaceId,
      hostname,
      target,
      environmentId,
      current,
      last,
    });
  if (claim.desiredAppId !== (target?.id ?? null)) {
    await requireReservationFinished(database, claim);
    await database
      .update(domainClaims)
      .set({
        desiredAppId: target?.id ?? null,
        sourceEnvironmentId:
          target?.sourceEnvironmentId ?? claim.sourceEnvironmentId,
        generation: randomUUID(),
        pendingDeploymentId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(domainClaims.workspaceId, workspaceId),
          eq(domainClaims.hostname, hostname),
        ),
      );
  }
}

function canRetireAmbiguousOwners(
  input: {
    target?: typeof apps.$inferSelect;
    instances: Array<typeof apps.$inferSelect>;
  },
  owners: Array<{ appId: string }>,
) {
  const archived = new Set(
    input.instances.filter((app) => app.archivedAt).map((app) => app.id),
  );
  return !input.target && owners.every((owner) => archived.has(owner.appId));
}

async function seedDomainClaim(
  database: SecretDatabase,
  input: {
    workspaceId: string;
    hostname: string;
    target?: typeof apps.$inferSelect;
    environmentId: string;
    current: Array<{ appId: string }>;
    last?: { deploymentId: string; appId: string };
  },
) {
  const { workspaceId, hostname, target, environmentId, current, last } = input;
  await database.insert(domainClaims).values({
    workspaceId,
    hostname,
    sourceEnvironmentId: target?.sourceEnvironmentId ?? environmentId,
    desiredAppId: target?.id ?? null,
    activeAppId: current[0]?.appId ?? null,
    activeDeploymentId: last?.deploymentId ?? null,
    releasedAppId: current.length ? null : (last?.appId ?? null),
  });
}

async function requireReservationFinished(
  database: SecretDatabase,
  claim: typeof domainClaims.$inferSelect,
  except?: string,
) {
  if (!claim.pendingDeploymentId || claim.pendingDeploymentId === except)
    return;
  const [pending] = await database
    .select({ state: deployments.state, errorCode: deployments.errorCode })
    .from(deployments)
    .where(eq(deployments.id, claim.pendingDeploymentId));
  if (
    pending &&
    [
      "DEPLOYMENT_COMMIT_UNCERTAIN",
      "DEPLOYMENT_INTERRUPTED_CLEANUP_PENDING",
      "DOMAIN_HANDOFF_RECOVERY_REQUIRED",
    ].includes(pending.errorCode ?? "")
  )
    throw conflict(
      `Domain '${claim.hostname}' requires reconciliation of its previous deployment before retrying.`,
      "DOMAIN_RECOVERY_REQUIRED",
    );
  if (pending && !terminalDeploymentStates.has(pending.state))
    throw conflict(
      `Domain '${claim.hostname}' has a deployment in progress. Retry after it finishes.`,
      "DOMAIN_DEPLOYMENT_IN_PROGRESS",
    );
}

export async function reserveDeploymentDomains(
  database: SecretDatabase,
  deployment: typeof deployments.$inferSelect,
) {
  if (deployment.environment !== "production") return;
  await synchronizeDomainClaims(database, deployment.workspaceId, {
    appId: deployment.appId,
    hostnames: deploymentPublicHostnames(deployment.appSnapshot),
  });
  const hostnames = deploymentPublicHostnames(deployment.appSnapshot);
  const claims = await database
    .select()
    .from(domainClaims)
    .where(
      and(
        eq(domainClaims.workspaceId, deployment.workspaceId),
        or(
          eq(domainClaims.activeAppId, deployment.appId),
          ...(hostnames.length
            ? [inArray(domainClaims.hostname, hostnames)]
            : []),
        ),
      ),
    );
  for (const hostname of hostnames) {
    const claim = claims.find((claim) => claim.hostname === hostname);
    if (!claim || claim.desiredAppId !== deployment.appId)
      throw conflict(
        `Domain '${hostname}' is no longer assigned to this workload. Sync and deploy its current configuration.`,
        "DOMAIN_ASSIGNMENT_CHANGED",
      );
  }
  for (const claim of claims) {
    if (
      claim.activeAppId === deployment.appId &&
      claim.desiredAppId &&
      claim.desiredAppId !== deployment.appId
    ) {
      const [target] = await database
        .select({ name: apps.name })
        .from(apps)
        .where(eq(apps.id, claim.desiredAppId));
      throw conflict(
        `Domain '${claim.hostname}' is moving to '${target?.name ?? "another workload"}'. Deploy that workload first to keep the current route available.`,
        "DOMAIN_HANDOFF_PENDING",
      );
    }
    await requireReservationFinished(database, claim, deployment.id);
    await database
      .update(domainClaims)
      .set({ pendingDeploymentId: deployment.id, updatedAt: new Date() })
      .where(
        and(
          eq(domainClaims.workspaceId, deployment.workspaceId),
          eq(domainClaims.hostname, claim.hostname),
        ),
      );
  }
  const handoffs = await deploymentDomainHandoffs(database, deployment);
  await database
    .update(deployments)
    .set({ domainHandoffSnapshot: handoffs })
    .where(eq(deployments.id, deployment.id));
}

export async function deploymentDomainHandoffs(
  database: SecretDatabase,
  deployment: typeof deployments.$inferSelect,
): Promise<DomainHandoff[]> {
  if (deployment.environment !== "production") return [];
  if (deployment.domainHandoffSnapshot?.length)
    return deployment.domainHandoffSnapshot;
  const claims = await database
    .select()
    .from(domainClaims)
    .where(
      and(
        eq(domainClaims.workspaceId, deployment.workspaceId),
        eq(domainClaims.pendingDeploymentId, deployment.id),
      ),
    );
  const handoffs: DomainHandoff[] = [];
  for (const claim of claims) {
    if (
      claim.desiredAppId !== deployment.appId ||
      !deploymentPublicHostnames(deployment.appSnapshot).includes(
        claim.hostname,
      )
    )
      continue;
    const ownerId = claim.activeAppId ?? claim.releasedAppId;
    if (!ownerId || ownerId === deployment.appId || !claim.activeDeploymentId)
      continue;
    const [owner] = await database
      .select()
      .from(apps)
      .where(
        and(eq(apps.id, ownerId), eq(apps.workspaceId, deployment.workspaceId)),
      );
    const [previous] = await database
      .select()
      .from(deployments)
      .where(eq(deployments.id, claim.activeDeploymentId));
    if (
      !owner ||
      !previous ||
      owner.sourceEnvironmentId !== deployment.targetEnvironment.id ||
      (!owner.archivedAt &&
        deploymentPublicHostnames(owner.config).includes(claim.hostname))
    )
      throw conflict(
        `Domain '${claim.hostname}' is still assigned to another workload.`,
        "DOMAIN_CONFLICT",
      );
    handoffs.push({
      hostname: claim.hostname,
      previousAppId: owner.id,
      previousAppName: owner.name,
      previousServerId: previous.serverId,
      previousServerIp: previous.serverSnapshot.ip,
      previousDeploymentId: previous.id,
      previousManagedDns: [
        ...deploymentCloudflareDnsDomains(previous.appSnapshot),
        ...deploymentTunnelHostnames(previous.appSnapshot),
      ].includes(claim.hostname),
    });
  }
  return handoffs;
}

export async function publishDeploymentDomains(
  database: SecretDatabase,
  deployment: Pick<
    typeof deployments.$inferSelect,
    "id" | "workspaceId" | "appId" | "appSnapshot" | "environment"
  >,
) {
  if (deployment.environment !== "production") return;
  const hostnames = deploymentPublicHostnames(deployment.appSnapshot);
  const claims = await database
    .select()
    .from(domainClaims)
    .where(
      and(
        eq(domainClaims.workspaceId, deployment.workspaceId),
        eq(domainClaims.pendingDeploymentId, deployment.id),
      ),
    );
  for (const hostname of hostnames) {
    if (
      !claims.some(
        (claim) =>
          claim.hostname === hostname &&
          claim.desiredAppId === deployment.appId,
      )
    )
      throw conflict(
        `Domain '${hostname}' changed ownership before release commit.`,
        "DOMAIN_ASSIGNMENT_CHANGED",
      );
  }
  for (const claim of claims) {
    const owned = hostnames.includes(claim.hostname);
    await database
      .update(domainClaims)
      .set({
        activeAppId: owned ? deployment.appId : null,
        activeDeploymentId: owned ? deployment.id : claim.activeDeploymentId,
        releasedAppId: owned
          ? null
          : (claim.activeAppId ?? claim.releasedAppId),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(domainClaims.workspaceId, deployment.workspaceId),
          eq(domainClaims.hostname, claim.hostname),
        ),
      );
  }
}

export async function resolveDeploymentDomainContext(deploymentId: string) {
  const [deployment] = await getTowbarDatabase()
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!deployment) throw conflict("Deployment is unavailable");
  const domainHandoffs = await getTowbarDatabase().transaction(
    async (database) => {
      await lockDomainClaims(database, deployment.workspaceId);
      const [currentDeployment] = await database
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId));
      if (!currentDeployment) throw conflict("Deployment is unavailable");
      if (!terminalDeploymentStates.has(currentDeployment.state))
        await reserveDeploymentDomains(database, currentDeployment);
      return await deploymentDomainHandoffs(database, currentDeployment);
    },
  );
  const domainHandoffServers = [];
  for (const serverId of [
    ...new Set(domainHandoffs.map((handoff) => handoff.previousServerId)),
  ].filter((id) => id !== deployment.serverId)) {
    const [server] = await getTowbarDatabase()
      .select()
      .from(servers)
      .where(
        and(
          eq(servers.id, serverId),
          eq(servers.workspaceId, deployment.workspaceId),
        ),
      );
    if (!server || server.archivedAt)
      throw conflict(
        "The previous domain owner's server is unavailable",
        "DOMAIN_OWNER_UNAVAILABLE",
      );
    const trustedHostKeys = await getTowbarDatabase()
      .select({
        algorithm: sshHostKeys.algorithm,
        fingerprint: sshHostKeys.fingerprint,
        publicKey: sshHostKeys.publicKey,
      })
      .from(sshHostKeys)
      .where(
        and(eq(sshHostKeys.serverId, serverId), isNull(sshHostKeys.revokedAt)),
      );
    domainHandoffServers.push({
      id: serverId,
      server: server.config,
      trustedHostKeys,
    });
  }
  return { domainHandoffs, domainHandoffServers };
}
