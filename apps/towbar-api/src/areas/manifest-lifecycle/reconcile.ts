import { recordAuditEvent } from "../../infrastructure/audit.js";
import { auditAttribution } from "../auth/actor-context.js";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  apps,
  deployments,
  repositoryManifests,
  resourceOperations,
  sourceEnvironments,
} from "@workspace/towbar-database/schema";
import {
  type NormalizedApp,
  type NormalizedComposeWorkload,
  type NormalizedDeploymentManifest,
  type NormalizedResource,
  type RepositoryTree,
  isNormalizedResource,
  reconcileManifest,
} from "@workspace/towbar-core";
import { terminalDeploymentStates } from "@workspace/towbar-core/temporal";
import type { SecretDatabase } from "../secrets/store.js";
import { materializeEnvironment } from "../sources/environment-materialization.js";
import { synchronizeDomainClaims } from "../deployments/domain-claims.js";
import {
  type ManifestDeclaration,
  identityKey,
  planManifestIdentities,
} from "./plan.js";

type MaterializationInput = Parameters<typeof materializeEnvironment>[1];
export function manifestEntities(manifest: NormalizedDeploymentManifest) {
  return [
    ...manifest.apps,
    ...(manifest.compose ?? []),
    ...(manifest.resources ?? []),
  ];
}
export async function loadManifestRegistry(
  database: SecretDatabase,
  workspaceId: string,
) {
  const environments = await database
    .select({ environment: sourceEnvironments, snapshot: repositoryManifests })
    .from(sourceEnvironments)
    .innerJoin(
      repositoryManifests,
      eq(repositoryManifests.sourceEnvironmentId, sourceEnvironments.id),
    )
    .where(eq(repositoryManifests.workspaceId, workspaceId));
  const declarations: ManifestDeclaration[] = environments.flatMap(
    ({ environment, snapshot }) =>
      manifestEntities(snapshot.manifest).map((config) => ({
        environment: environment.name,
        sourceEnvironmentId: environment.id,
        sourceId: environment.sourceId,
        commitSha: snapshot.commitSha,
        config,
      })),
  );
  const instances = await database
    .select({ app: apps, environment: sourceEnvironments.name })
    .from(apps)
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .where(
      and(eq(apps.workspaceId, workspaceId), ne(apps.manifestState, "removed")),
    );
  return {
    environments,
    declarations,
    instances,
    plans: planManifestIdentities(
      declarations,
      instances.map(({ app, environment }) => ({ ...app, environment })),
    ),
  };
}

export async function reconcileRepositoryManifests(
  database: Parameters<typeof materializeEnvironment>[0],
  input: {
    workspaceId: string;
    allowAutomaticDeployment: boolean;
    scheduleAutomaticDeployment: boolean;
    environment: MaterializationInput["environment"];
    manifest: ReturnType<
      typeof import("@workspace/towbar-core").resolveRepositoryEnvironment
    >["manifest"];
    commitSha: string;
    paths: Record<string, string[]>;
    tree: RepositoryTree;
    serverByIp: MaterializationInput["serverByIp"];
  },
) {
  const [previous] = await database
    .select()
    .from(repositoryManifests)
    .where(eq(repositoryManifests.sourceEnvironmentId, input.environment.id));
  await database
    .insert(repositoryManifests)
    .values({
      sourceEnvironmentId: input.environment.id,
      workspaceId: input.workspaceId,
      commitSha: input.commitSha,
      manifest: input.manifest,
      tree: input.tree,
      paths: { ...input.paths },
    })
    .onConflictDoUpdate({
      target: repositoryManifests.sourceEnvironmentId,
      set: {
        commitSha: input.commitSha,
        manifest: input.manifest,
        tree: input.tree,
        paths: { ...input.paths },
        observedAt: new Date(),
      },
    });
  const registry = await loadManifestRegistry(database, input.workspaceId);
  const touched = new Set(
    [
      ...manifestEntities(input.manifest),
      ...(previous ? manifestEntities(previous.manifest) : []),
    ].map((config) => `${input.environment.name}:${config.id}`),
  );
  for (const { app, environment } of registry.instances)
    if (app.sourceEnvironmentId === input.environment.id)
      touched.add(`${environment}:${app.manifestId}`);
  const result = reconcileManifest({
    currentApps: [],
    desired: { ...input.manifest, apps: [], compose: [], resources: [] },
  });
  const issues: { message: string; path: string[] }[] = [];
  const environmentIds = new Set([input.environment.id]);
  for (const plan of registry.plans) {
    if (!touched.has(identityKey(plan.environment, plan.manifestId))) continue;
    await reconcileIdentity(database, {
      input,
      registry,
      result,
      issues,
      plan,
    });
    for (const declaration of plan.declarations)
      environmentIds.add(declaration.sourceEnvironmentId);
  }
  // Domain moves must see the complete sync, including assignments released by other manifests.
  for (const sourceEnvironmentId of environmentIds)
    await synchronizeDomainClaims(database, input.workspaceId, {
      sourceEnvironmentId,
    });
  return { reconciliation: result, issues };
}

type ReconcileInput = Parameters<typeof reconcileRepositoryManifests>[1];
async function reconcileIdentity(
  database: Parameters<typeof materializeEnvironment>[0],
  context: {
    input: ReconcileInput;
    registry: Awaited<ReturnType<typeof loadManifestRegistry>>;
    result: ReturnType<typeof reconcileManifest>;
    issues: { message: string; path: string[] }[];
    plan: ReturnType<typeof planManifestIdentities>[number];
  },
) {
  const { input, registry, result, issues, plan } = context;
  const ids = plan.workloads.map((w) => w.id);
  const existing = registry.instances.find(({ app }) => app.id === ids[0])?.app;
  const removingIds = new Set(
    registry.instances
      .filter(
        ({ app }) => ids.includes(app.id) && app.manifestState === "removing",
      )
      .map(({ app }) => app.id),
  );
  if (removingIds.size) {
    if (plan.declarations.length)
      issues.push({
        message: `${plan.manifestId}: Permanent removal is already queued or running. Wait for its result before adopting this ID.`,
        path: [plan.manifestId],
      });
  }
  if (plan.state !== "active") {
    const retainedIds = ids.filter((id) => !removingIds.has(id));
    if (retainedIds.length)
      await database
        .update(apps)
        .set({
          manifestState: plan.state,
          ...(plan.state === "retired"
            ? { retiredAt: existing?.retiredAt ?? new Date() }
            : {}),
          updatedAt: new Date(),
        })
        .where(inArray(apps.id, retainedIds));
    if (plan.reason)
      issues.push({
        message: `${plan.manifestId}: ${plan.reason}`,
        path: [plan.manifestId],
      });
    return;
  }
  const declaration = plan.declarations[0]!;
  const target = registry.environments.find(
    ({ environment }) => environment.id === declaration.sourceEnvironmentId,
  )!;
  const transferring =
    existing &&
    existing.sourceEnvironmentId !== declaration.sourceEnvironmentId;
  if (transferring) {
    if (await ownershipTransferIsBlocked(database, existing.id, target)) {
      await database
        .update(apps)
        .set({ manifestState: "conflict", updatedAt: new Date() })
        .where(eq(apps.id, existing.id));
      issues.push({
        message: `${plan.manifestId}: Finish active operations and sync the connected destination repository again before ownership can move.`,
        path: [plan.manifestId],
      });
      return;
    }
  }
  if (!input.allowAutomaticDeployment)
    await database
      .update(sourceEnvironments)
      .set({ autoDeployPaused: true, updatedAt: new Date() })
      .where(eq(sourceEnvironments.id, target.environment.id));
  const config = declaration.config;
  const current = existing
    ? [{ ...existing, identity: existing.manifestId }]
    : [];
  const desired = {
    ...target.snapshot.manifest,
    apps: config.kind === "app" ? [config] : [],
    compose: config.kind === "compose" ? [config] : [],
    resources: isNormalizedResource(config) ? [config] : [],
  };
  const reconciliation = reconcileManifest({
    currentApps: current
      .filter((a) => a.kind === "app")
      .map((a) => ({ ...a, config: a.config as NormalizedApp })),
    currentCompose: current
      .filter((a) => a.kind === "compose")
      .map((a) => ({ ...a, config: a.config as NormalizedComposeWorkload })),
    currentResources: current
      .filter((a) => a.kind !== "app" && a.kind !== "compose")
      .map((a) => ({ ...a, config: a.config as NormalizedResource })),
    desired,
  });
  await materializeEnvironment(database, {
    reconciliation,
    workspaceId: input.workspaceId,
    sourceId: target.environment.sourceId,
    environment: target.environment,
    commitSha: target.snapshot.commitSha,
    tree: target.snapshot.tree ?? input.tree,
    serverByIp: input.serverByIp,
    requiredSecrets: target.snapshot.manifest.requiredSecrets,
  });

  if (transferring) {
    await recordAuditEvent(database, {
      workspaceId: input.workspaceId,
      action: "workload.ownership.transferred",
      targetType: "app",
      targetId: existing.id,
      metadata: {
        previousSourceId: existing.sourceId,
        sourceId: target.environment.sourceId,
        manifestId: existing.manifestId,
      },
      ...auditAttribution(),
    });
  }
  if (
    shouldResumeAutomaticDeployment(
      existing,
      config,
      input.scheduleAutomaticDeployment,
    )
  )
    await deferOwnershipDeployment(
      database,
      existing.id,
      target.snapshot.commitSha,
    );
  result.apps.push(...reconciliation.apps);
  result.compose.push(...reconciliation.compose);
  result.resources.push(...reconciliation.resources);
  for (const key of Object.keys(
    result.summary,
  ) as (keyof typeof result.summary)[])
    result.summary[key] += reconciliation.summary[key];
}

async function deferOwnershipDeployment(
  database: SecretDatabase,
  appId: string,
  commitSha: string,
) {
  const [updated] = await database
    .select()
    .from(apps)
    .where(eq(apps.id, appId));
  if (!updated?.deploymentDigest) return;
  await database
    .update(apps)
    .set({
      deferredAutomaticDeployment: {
        commitSha,
        deploymentDigest: updated.deploymentDigest,
        manifestId: appId,
        deferredAt: new Date().toISOString(),
        reason: "paused",
        scope: "environment",
      },
    })
    .where(eq(apps.id, appId));
}

async function ownershipTransferIsBlocked(
  database: SecretDatabase,
  appId: string,
  target: Awaited<
    ReturnType<typeof loadManifestRegistry>
  >["environments"][number],
) {
  if (target.environment.disconnectedAt || !target.snapshot.tree) return true;
  const history = await database
    .select({ state: deployments.state })
    .from(deployments)
    .where(eq(deployments.appId, appId));
  if (
    history.some(
      (deployment) => !terminalDeploymentStates.has(deployment.state),
    )
  )
    return true;
  const operations = await database
    .select({ id: resourceOperations.id })
    .from(resourceOperations)
    .where(
      and(
        eq(resourceOperations.resourceId, appId),
        inArray(resourceOperations.state, ["queued", "running"]),
      ),
    );
  return operations.length > 0;
}

function shouldResumeAutomaticDeployment(
  existing: typeof apps.$inferSelect | undefined,
  config: import("@workspace/towbar-core").NormalizedDeployable,
  schedule: boolean,
): existing is typeof apps.$inferSelect {
  return Boolean(
    schedule &&
    existing &&
    existing.manifestState !== "active" &&
    config.autoDeploy,
  );
}
