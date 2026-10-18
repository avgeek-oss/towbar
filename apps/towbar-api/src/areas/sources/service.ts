import { withdrawRepository } from "./withdrawal.js";
import {
  environmentSyncStatuses,
  summarizeSyncStatus,
} from "./environment-status.js";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import {
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
    .where(
      and(eq(sources.workspaceId, workspaceId), eq(sources.status, "active")),
    )
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
    .where(
      and(
        eq(sources.id, sourceId),
        eq(sources.workspaceId, workspaceId),
        eq(sources.status, "active"),
      ),
    )
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

export function deleteSource(
  sourceId: string,
  workspaceId: string,
  expectedRevision?: string,
) {
  return getTowbarDatabase().transaction((transaction) =>
    withdrawRepository(transaction, {
      sourceId,
      workspaceId,
      expectedRevision,
    }),
  );
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
