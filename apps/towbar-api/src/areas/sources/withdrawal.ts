import { validateWithdrawalTarget } from "./environment-materialization.js";
import { assertNoRunningCleanup } from "../resource-operations/server-cleanup.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import {
  type RepositoryRemovalPreview,
  digestValue,
} from "@workspace/towbar-core";
import {
  deployments,
  imageVulnerabilityScans,
  repositoryManifests,
  resourceOperations,
  servers,
  sourceEnvironments,
  sourceSyncs,
  sources,
} from "@workspace/towbar-database/schema";
import { HttpError, conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { recordAuditEvent } from "../../infrastructure/audit.js";
import { actorAllows } from "@workspace/towbar-access";
import { auditAttribution, currentActor } from "../auth/actor-context.js";
import { lockDomainClaims } from "../deployments/domain-claims.js";
import {
  changedConfigurationPaths,
  identityKey,
} from "../manifest-lifecycle/plan.js";
import {
  loadManifestRegistry,
  manifestEntities,
  ownershipTransferIsBlocked,
  reconcileManifestIdentities,
} from "../manifest-lifecycle/reconcile.js";
import { repositoryTransferSecrets } from "../manifest-lifecycle/transfer-secrets.js";
import type { SecretDatabase } from "../secrets/store.js";

type Transaction = Parameters<
  Parameters<ReturnType<typeof getTowbarDatabase>["transaction"]>[0]
>[0];
export const repositoryRemovalSchema = z
  .object({
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();

async function prepareWithdrawalPlans(
  database: SecretDatabase,
  workspaceId: string,
  registry: Awaited<ReturnType<typeof loadManifestRegistry>>,
  plans: Awaited<ReturnType<typeof loadManifestRegistry>>["plans"],
  serverByIp: Parameters<typeof validateWithdrawalTarget>[1]["serverByIp"],
) {
  const secretRevisions: string[] = [];
  for (const plan of plans) {
    if (plan.state !== "active") continue;
    const target = plan.declarations[0]!;
    const destination = registry.environments.find(
      (item) => item.environment.id === target.sourceEnvironmentId,
    )!;
    const snapshot = destination.snapshot;
    const existing = plan.workloads[0];
    if (!snapshot.tree || !serverByIp.has(target.config.server)) {
      plan.state = "conflict";
      plan.reason =
        "Sync the connected destination repository with a registered server before ownership can move.";
      continue;
    }
    try {
      await validateWithdrawalTarget(database, {
        workspaceId,
        sourceId: target.sourceId,
        environment: plan.environment,
        config: target.config,
        serverByIp,
        appId: existing?.id,
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      plan.state = "conflict";
      plan.reason = error.publicMessage;
      continue;
    }
    if (
      existing &&
      existing.sourceEnvironmentId !== target.sourceEnvironmentId
    ) {
      if (
        await ownershipTransferIsBlocked(database, existing.id, destination)
      ) {
        plan.state = "conflict";
        plan.reason =
          "Finish active operations and sync the destination again before ownership can move.";
        continue;
      }
      const secrets = await repositoryTransferSecrets(database, {
        workspaceId,
        appId: existing.id,
        sourceId: target.sourceId,
        environment: plan.environment,
        includePreview:
          target.config.kind === "app" && target.config.preview?.enabled,
        required:
          snapshot.manifest.requiredSecrets[
            `${target.config.kind === "app" ? "app" : target.config.kind === "compose" ? "compose" : "resource"}:${target.config.id}`
          ]!,
      });
      secretRevisions.push(secrets.revision);
      if (secrets.missing.length) {
        plan.state = "conflict";
        plan.reason = `Add destination Repository Secrets: ${secrets.missing.join(", ")}, then sync the destination.`;
      }
    }
  }
  return secretRevisions;
}

async function loadWithdrawal(
  database: SecretDatabase,
  sourceId: string,
  workspaceId: string,
  environmentId?: string,
) {
  const [source] = await database
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)));
  if (!source || source.status !== "active") throw notFound("Source");
  const environments = await database
    .select()
    .from(sourceEnvironments)
    .where(
      and(
        eq(sourceEnvironments.sourceId, sourceId),
        environmentId ? eq(sourceEnvironments.id, environmentId) : undefined,
      ),
    );
  if (environmentId && !environments.length) throw notFound("Environment");
  const ids = new Set(environments.map((environment) => environment.id));
  const snapshots = ids.size
    ? await database
        .select()
        .from(repositoryManifests)
        .where(
          and(
            eq(repositoryManifests.workspaceId, workspaceId),
            inArray(repositoryManifests.sourceEnvironmentId, [...ids]),
          ),
        )
    : [];
  const keys = new Set(
    snapshots.flatMap((snapshot) => {
      const environment = environments.find(
        (item) => item.id === snapshot.sourceEnvironmentId,
      )!;
      return manifestEntities(snapshot.manifest).map((config) =>
        identityKey(environment.name, config.id),
      );
    }),
  );
  const registry = await loadManifestRegistry(database, workspaceId, ids);
  for (const { app, environment } of registry.instances)
    if (ids.has(app.sourceEnvironmentId))
      keys.add(identityKey(environment, app.manifestId));
  const plans = registry.plans.filter((plan) =>
    keys.has(identityKey(plan.environment, plan.manifestId)),
  );
  const hosts = await database
    .select()
    .from(servers)
    .where(
      and(eq(servers.workspaceId, workspaceId), isNull(servers.archivedAt)),
    );
  const serverByIp = new Map(
    hosts.map((server) => [server.canonicalIp, server]),
  );
  const secretRevisions = await prepareWithdrawalPlans(
    database,
    workspaceId,
    registry,
    plans,
    serverByIp,
  );
  const repositoryRows = await database
    .select({
      id: sources.id,
      owner: sources.repositoryOwner,
      name: sources.repositoryName,
    })
    .from(sources)
    .where(eq(sources.workspaceId, workspaceId));
  const workloads: RepositoryRemovalPreview["workloads"] = plans.map((plan) => {
    const target = plan.declarations[0];
    const existing = plan.workloads[0];
    const repository = repositoryRows.find(
      (item) => item.id === target?.sourceId,
    );
    return {
      key: plan.key,
      manifestId: plan.manifestId,
      environment: plan.environment,
      name: existing?.config.name ?? target?.config.name ?? plan.manifestId,
      outcome:
        plan.state === "conflict"
          ? "conflict"
          : plan.state === "retired"
            ? "retire"
            : existing?.sourceEnvironmentId === target?.sourceEnvironmentId
              ? "unchanged"
              : "transfer",
      destination:
        target && repository && plan.declarations.length === 1
          ? `${repository.owner}/${repository.name}`
          : null,
      reason: plan.reason,
      changedPaths:
        existing && target
          ? changedConfigurationPaths(existing.config, target.config)
          : [],
    };
  });
  const [activeDeployments, activeSyncs, activeOperations, activeScans] =
    await Promise.all([
      database
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.sourceId, sourceId),
            notInArray(deployments.state, [
              "cancelled",
              "failed",
              "skipped",
              "succeeded",
              "succeeded_with_warnings",
            ]),
          ),
        ),
      database
        .select({ id: sourceSyncs.id })
        .from(sourceSyncs)
        .where(
          and(
            eq(sourceSyncs.sourceId, sourceId),
            inArray(sourceSyncs.status, ["queued", "running"]),
          ),
        ),
      database
        .select({ id: resourceOperations.id })
        .from(resourceOperations)
        .where(
          and(
            eq(resourceOperations.sourceId, sourceId),
            inArray(resourceOperations.state, ["queued", "running"]),
          ),
        ),
      database
        .select({ id: imageVulnerabilityScans.id })
        .from(imageVulnerabilityScans)
        .where(
          and(
            eq(imageVulnerabilityScans.sourceId, sourceId),
            inArray(imageVulnerabilityScans.state, ["pending", "running"]),
          ),
        ),
    ]);
  const blockers = [
    activeDeployments.length
      ? `${activeDeployments.length} active deployments`
      : null,
    activeSyncs.length ? `${activeSyncs.length} active syncs` : null,
    activeOperations.length
      ? `${activeOperations.length} active resource operations`
      : null,
    activeScans.length ? `${activeScans.length} active image scans` : null,
  ].filter((value): value is string => value !== null);
  const preview: RepositoryRemovalPreview = {
    sourceId,
    revision: digestValue({
      source: {
        id: source.id,
        status: source.status,
        updatedAt: source.updatedAt.toISOString(),
      },
      environments: environments.map((environment) => ({
        ...environment,
        updatedAt: environment.updatedAt.toISOString(),
        disconnectedAt: environment.disconnectedAt?.toISOString() ?? null,
      })),
      instanceRevisions: registry.instances
        .filter(({ app }) =>
          plans.some((plan) =>
            plan.workloads.some((workload) => workload.id === app.id),
          ),
        )
        .map(({ app }) => ({
          id: app.id,
          updatedAt: app.updatedAt.toISOString(),
        })),
      workloads,
      secretRevisions,
      claims: plans.map((plan) => ({
        declarations: plan.declarations,
        workloads: plan.workloads,
      })),
      blockers,
    }),
    summary: {
      transfers: workloads.filter((item) => item.outcome === "transfer").length,
      retirements: workloads.filter((item) => item.outcome === "retire").length,
      conflicts: workloads.filter((item) => item.outcome === "conflict").length,
    },
    blockers,
    workloads,
  };
  return { source, environments, registry, plans, preview, serverByIp };
}

export function previewRepositoryRemoval(
  sourceId: string,
  workspaceId: string,
  environmentId?: string,
) {
  return getTowbarDatabase().transaction(async (transaction) => {
    await lockDomainClaims(transaction, workspaceId);
    return (
      await loadWithdrawal(transaction, sourceId, workspaceId, environmentId)
    ).preview;
  });
}

export async function withdrawRepository(
  database: Transaction,
  input: {
    sourceId: string;
    workspaceId: string;
    environmentId?: string;
    expectedRevision?: string;
    expectedMappingRevision?: string;
    actorUserId?: string | null;
  },
) {
  await lockDomainClaims(database, input.workspaceId);
  const [source] = await database
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .for("update");
  if (!source) throw notFound("Source");
  if (!input.environmentId && source.status === "archived")
    return { id: source.id };
  if (source.status !== "active") throw notFound("Source");
  await database
    .select({ id: sourceEnvironments.id })
    .from(sourceEnvironments)
    .where(eq(sourceEnvironments.sourceId, input.sourceId))
    .orderBy(sourceEnvironments.id)
    .for("update");
  await assertNoRunningCleanup(database, input.workspaceId);
  const review = await loadWithdrawal(
    database,
    input.sourceId,
    input.workspaceId,
    input.environmentId,
  );
  if (review.preview.blockers.length)
    throw conflict(
      `Wait for active Source operations: ${review.preview.blockers.join(", ")}.`,
      "SOURCE_BUSY",
    );
  if (
    input.expectedRevision &&
    input.expectedRevision !== review.preview.revision
  )
    throw conflict(
      "Repository removal impact changed. Refresh and review it again.",
      "SOURCE_REMOVAL_CHANGED",
    );
  const environment = review.environments[0];
  if (
    input.environmentId &&
    (!environment ||
      environment.disconnectedAt ||
      environment.mappingRevision !== input.expectedMappingRevision)
  )
    throw conflict(
      "The environment mapping changed. Refresh before disconnecting.",
      "ENVIRONMENT_MAPPING_CHANGED",
    );
  for (const item of review.environments) {
    if (item.disconnectedAt) continue;
    await database
      .update(sourceEnvironments)
      .set({
        disconnectedAt: new Date(),
        mappingRevision: randomUUID(),
        autoDeployPaused: true,
        updatedAt: new Date(),
      })
      .where(eq(sourceEnvironments.id, item.id));
  }
  if (!input.environmentId)
    await database
      .update(sources)
      .set({
        status: "archived",
        archivedAt: new Date(),
        autoDeployPaused: true,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, input.sourceId));
  const actor = currentActor();
  await reconcileManifestIdentities(database, {
    workspaceId: input.workspaceId,
    registry: review.registry,
    plans: review.plans,
    serverByIp: review.serverByIp,
    allowAutomaticDeployment: Boolean(
      actor && actorAllows(actor, ["deployment.create"]),
    ),
    scheduleAutomaticDeployment: false,
  });
  await recordAuditEvent(database, {
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: input.environmentId
      ? "source.environment.disconnected"
      : "source.removed",
    targetType: "source",
    targetId: input.sourceId,
    metadata: {
      ...review.preview.summary,
      ...(environment && input.environmentId
        ? { environment: environment.name }
        : {}),
    },
    ...auditAttribution(),
  });
  return input.environmentId
    ? (
        await database
          .select()
          .from(sourceEnvironments)
          .where(eq(sourceEnvironments.id, input.environmentId))
      )[0]!
    : { id: source.id };
}
