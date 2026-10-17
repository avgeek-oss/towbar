import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  sourceEnvironments,
  sourceSyncs,
  sources,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { listSources } from "./service.js";
import { listSourceEnvironments } from "./environments.js";

export async function assertEnvironmentSyncReporting(
  sourceId: string,
  workspaceId: string,
) {
  const db = getTowbarDatabase();
  const environments = await db
    .select()
    .from(sourceEnvironments)
    .where(eq(sourceEnvironments.sourceId, sourceId));
  const production = environments.find((item) => item.name === "production")!;
  const staging = environments.find((item) => item.name === "staging")!;
  const ids = [randomUUID(), randomUUID()];
  const [originalSource] = await db
    .select({ updatedAt: sources.updatedAt })
    .from(sources)
    .where(eq(sources.id, sourceId));
  const readStatus = async () =>
    (await listSources(workspaceId)).find(
      (source) => source.id === production.sourceId,
    )?.latestSyncStatus;
  await db.insert(sourceSyncs).values(
    [production, staging].map((environment, index) => ({
      id: ids[index],
      sourceId: environment.sourceId,
      sourceEnvironmentId: environment.id,
      mappingRevision: environment.mappingRevision,
      status: index === 0 ? ("failed" as const) : ("succeeded" as const),
      createdAt: new Date(`2050-01-0${index + 1}T00:00:00Z`),
      finishedAt: new Date(
        index === 0 ? "2050-02-01T00:00:00Z" : "2050-01-02T00:01:00Z",
      ),
    })),
  );
  try {
    const successfulTime = new Date("2050-01-02T00:01:00Z").getTime();
    const readLastSynced = async () =>
      (await listSources(workspaceId)).find((source) => source.id === sourceId)
        ?.lastSyncedAt;
    assert.equal(
      new Date((await readLastSynced())!).getTime(),
      successfulTime,
      "failed syncs do not advance Last synced",
    );
    await db
      .update(sources)
      .set({ updatedAt: new Date("2051-01-01T00:00:00Z") })
      .where(eq(sources.id, sourceId));
    assert.equal(
      new Date((await readLastSynced())!).getTime(),
      successfulTime,
      "connection metadata changes do not advance Last synced",
    );
    assert.equal(
      await readStatus(),
      "failed",
      "newer staging success must not hide production failure",
    );
    await db
      .update(sourceEnvironments)
      .set({ mappingRevision: randomUUID() })
      .where(eq(sourceEnvironments.id, production.id));
    assert.equal(
      await readStatus(),
      "never",
      "old mapping attempts do not prove current branch readiness",
    );
    const environments = await listSourceEnvironments(
      production.sourceId,
      workspaceId,
    );
    assert.equal(
      environments.find((item) => item.id === production.id)?.latestSyncStatus,
      "never",
    );
    await db
      .update(sourceEnvironments)
      .set({ disconnectedAt: new Date() })
      .where(eq(sourceEnvironments.id, production.id));
    assert.equal(
      await readStatus(),
      "succeeded",
      "disconnected environments do not participate in sync status",
    );
  } finally {
    await db
      .update(sources)
      .set({ updatedAt: originalSource!.updatedAt })
      .where(eq(sources.id, sourceId));
    await db.delete(sourceSyncs).where(inArray(sourceSyncs.id, ids));
    await db
      .update(sourceEnvironments)
      .set({
        mappingRevision: production.mappingRevision,
        disconnectedAt: production.disconnectedAt,
      })
      .where(eq(sourceEnvironments.id, production.id));
  }
}
