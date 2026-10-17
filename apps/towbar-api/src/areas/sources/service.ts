import {
  environmentSyncStatuses,
  summarizeSyncStatus,
} from "./environment-status.js";
import { and, desc, eq, inArray, max, notInArray } from "drizzle-orm";
import {
  apps,
  deployments,
  imageVulnerabilityScans,
  integrationWebhookDeliveries,
  releases,
  resourceOperations,
  sourceEnvironments,
  sourceSyncs,
  sources,
} from "@workspace/towbar-database/schema";
import { executeEnvironmentSync } from "./environment-sync.js";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { requireGitLabRuntimeConfiguration } from "../../infrastructure/runtime-integrations.js";
import {
  publicSourceSelection,
  publicSourceSyncSelection,
} from "./public-selections.js";

export async function listSources(workspaceId: string) {
  const database = getTowbarDatabase();
  const rows = await database
    .select({
      ...publicSourceSelection,
      autoDeployPaused: sources.autoDeployPaused,
    })
    .from(sources)
    .where(eq(sources.workspaceId, workspaceId))
    .orderBy(desc(sources.updatedAt));
  const ids = rows.map((source) => source.id);
  const environments = await environmentSyncStatuses(ids);
  const completed = ids.length
    ? await database
        .select({
          sourceId: sourceSyncs.sourceId,
          finishedAt: max(sourceSyncs.finishedAt),
        })
        .from(sourceSyncs)
        .where(
          and(
            inArray(sourceSyncs.sourceId, ids),
            eq(sourceSyncs.status, "succeeded"),
          ),
        )
        .groupBy(sourceSyncs.sourceId)
    : [];
  const lastSynced = new Map(
    completed.map((item) => [item.sourceId, item.finishedAt]),
  );
  return rows.map((source) => ({
    ...source,
    lastSyncedAt: lastSynced.get(source.id) ?? null,
    latestSyncStatus: summarizeSyncStatus(
      environments
        .filter(
          (environment) =>
            environment.sourceId === source.id && !environment.disconnectedAt,
        )
        .map((environment) => environment.latestSyncStatus),
    ),
  }));
}

export async function getSource(sourceId: string, workspaceId: string) {
  const [source] = await getTowbarDatabase()
    .select({
      ...publicSourceSelection,
    })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);
  if (!source) throw notFound("Source");
  const metadata = source;
  const path = [metadata.repositoryOwner, metadata.repositoryName]
    .flatMap((part) => part.split("/"))
    .map(encodeURIComponent)
    .join("/");
  return {
    ...metadata,
    repositoryUrl:
      metadata.provider === "github"
        ? `https://github.com/${path}`
        : new URL(
            path,
            `${requireGitLabRuntimeConfiguration().baseUrl.replace(/\/$/u, "")}/`,
          ).toString(),
  };
}

export async function deleteSource(sourceId: string, workspaceId: string) {
  return await getTowbarDatabase().transaction(async (transaction) => {
    const [source] = await transaction
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
      )
      .for("update")
      .limit(1);
    if (!source) throw notFound("Source");
    const retained = await transaction
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.sourceId, sourceId))
      .limit(1);
    const provenance = await transaction
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.sourceId, sourceId))
      .limit(1);
    if (retained.length || provenance.length)
      throw conflict(
        "This repository owns workloads or retained history. Disconnect its environments to stop syncing; review missing manifests on the Retirements page.",
        "SOURCE_HAS_RETAINED_WORKLOADS",
      );

    const [
      activeDeployment,
      activeSync,
      activeOperation,
      activeVulnerabilityScan,
    ] = await Promise.all([
      transaction
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
        )
        .limit(1),
      transaction
        .select({ id: sourceSyncs.id })
        .from(sourceSyncs)
        .where(
          and(
            eq(sourceSyncs.sourceId, sourceId),
            inArray(sourceSyncs.status, ["queued", "running"]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: resourceOperations.id })
        .from(resourceOperations)
        .where(
          and(
            eq(resourceOperations.sourceId, sourceId),
            inArray(resourceOperations.state, ["queued", "running"]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: imageVulnerabilityScans.id })
        .from(imageVulnerabilityScans)
        .where(
          and(
            eq(imageVulnerabilityScans.sourceId, sourceId),
            inArray(imageVulnerabilityScans.state, ["pending", "running"]),
          ),
        )
        .limit(1),
    ]);
    if (
      activeDeployment.length ||
      activeSync.length ||
      activeOperation.length ||
      activeVulnerabilityScan.length
    ) {
      throw conflict(
        "Cancel or wait for active Source operations before deletion",
        "SOURCE_BUSY",
      );
    }

    const appRows = await transaction
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.sourceId, sourceId));
    const appIds = appRows.map((app) => app.id);
    if (appIds.length > 0) {
      await transaction.delete(releases).where(inArray(releases.appId, appIds));
    }
    await transaction
      .delete(imageVulnerabilityScans)
      .where(eq(imageVulnerabilityScans.sourceId, sourceId));
    await transaction
      .delete(deployments)
      .where(eq(deployments.sourceId, sourceId));
    await transaction.delete(apps).where(eq(apps.sourceId, sourceId));
    await transaction
      .delete(integrationWebhookDeliveries)
      .where(eq(integrationWebhookDeliveries.sourceId, sourceId));
    await transaction.delete(sources).where(eq(sources.id, sourceId));

    return { id: source.id };
  });
}

export async function executeSourceSync(syncId: string) {
  const [sync] = await getTowbarDatabase()
    .select({
      sourceId: sourceSyncs.sourceId,
      sourceEnvironmentId: sourceSyncs.sourceEnvironmentId,
      workspaceId: sources.workspaceId,
    })
    .from(sourceSyncs)
    .innerJoin(sources, eq(sources.id, sourceSyncs.sourceId))
    .where(eq(sourceSyncs.id, syncId))
    .limit(1);
  if (!sync) throw notFound("Source sync");
  if (!sync.sourceEnvironmentId) {
    const message = "Source sync requires an environment mapping.";
    await getTowbarDatabase()
      .update(sourceSyncs)
      .set({
        status: "failed",
        finishedAt: new Date(),
        issues: [{ path: [], message }],
      })
      .where(eq(sourceSyncs.id, syncId));
    throw conflict(message, "ENVIRONMENT_REQUIRED");
  }
  return executeEnvironmentSync(syncId, sync.workspaceId);
}

export async function listSourceSyncs(sourceId: string, workspaceId: string) {
  await getSource(sourceId, workspaceId);
  return await getTowbarDatabase()
    .select(publicSourceSyncSelection)
    .from(sourceSyncs)
    .leftJoin(
      sourceEnvironments,
      and(
        eq(sourceEnvironments.id, sourceSyncs.sourceEnvironmentId),
        eq(sourceEnvironments.sourceId, sourceSyncs.sourceId),
      ),
    )
    .where(eq(sourceSyncs.sourceId, sourceId))
    .orderBy(desc(sourceSyncs.createdAt));
}

export async function getSourceSync(
  sourceId: string,
  syncId: string,
  workspaceId: string,
) {
  await getSource(sourceId, workspaceId);
  const [sync] = await getTowbarDatabase()
    .select(publicSourceSyncSelection)
    .from(sourceSyncs)
    .leftJoin(
      sourceEnvironments,
      and(
        eq(sourceEnvironments.id, sourceSyncs.sourceEnvironmentId),
        eq(sourceEnvironments.sourceId, sourceSyncs.sourceId),
      ),
    )
    .where(and(eq(sourceSyncs.id, syncId), eq(sourceSyncs.sourceId, sourceId)))
    .limit(1);
  if (!sync) throw notFound("Source sync");
  return sync;
}
