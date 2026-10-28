import { captureQueuedActor } from "../auth/actor-context.js";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import {
  sourceEnvironments,
  sourceSyncs,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { requestEnvironmentSync } from "./environments.js";
import { executeEnvironmentSync } from "./environment-sync.js";

export async function assertCompletedSyncRetry(input: {
  staging: typeof sourceEnvironments.$inferSelect;
  workspaceId: string;
  snapshotCommit: string;
  dependencies: NonNullable<Parameters<typeof executeEnvironmentSync>[2]>;
}) {
  const { staging, workspaceId, snapshotCommit, dependencies } = input;
  const sourceId = staging.sourceId;
  const database = getTowbarDatabase();

  const [previousEnvironment] = await database
    .select()
    .from(sourceEnvironments)
    .where(eq(sourceEnvironments.id, staging.id));
  const [job] = await database
    .insert(sourceSyncs)
    .values({
      sourceId,
      sourceEnvironmentId: staging.id,
      mappingRevision: staging.mappingRevision,
      ...captureQueuedActor(workspaceId, ["admin"]),
    })
    .returning();
  assert(job);
  let retry: ReturnType<typeof executeEnvironmentSync> | undefined;
  let fetched = false;
  await database.transaction(async (transaction) => {
    await transaction
      .select()
      .from(sourceSyncs)
      .where(eq(sourceSyncs.id, job.id))
      .for("update");
    retry = executeEnvironmentSync(job.id, workspaceId, {
      ...dependencies,
      snapshot: (...args) => {
        fetched = true;
        return dependencies.snapshot(...args);
      },
    });
    void retry.catch(() => undefined);
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      await transaction.execute(sql`select pg_stat_clear_snapshot()`);
      const rows = await transaction.execute<{ waiting: boolean }>(
        sql`select exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query ilike '%update%towbar_source_syncs%') as waiting`,
      );
      if (rows[0]?.waiting) {
        waiting = true;
        break;
      }
      await delay(20);
    }
    assert(waiting, "Retry must be blocked at the running-state update");
    await transaction
      .update(sourceSyncs)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        commitSha: snapshotCommit,
      })
      .where(eq(sourceSyncs.id, job.id));
    await transaction
      .update(sourceEnvironments)
      .set({ latestSuccessfulSyncId: job.id })
      .where(eq(sourceEnvironments.id, staging.id));
  });
  assert.equal((await retry)?.status, "succeeded");
  assert.equal(fetched, false);
  const [stored] = await database
    .select()
    .from(sourceSyncs)
    .where(eq(sourceSyncs.id, job.id));
  assert.equal(stored?.status, "succeeded");
  await database
    .update(sourceEnvironments)
    .set({
      latestSuccessfulSyncId: previousEnvironment!.latestSuccessfulSyncId,
    })
    .where(eq(sourceEnvironments.id, staging.id));
  await database.delete(sourceSyncs).where(eq(sourceSyncs.id, job.id));
  for (const state of ["queued", "running", "succeeded"] as const) {
    let syncId = "";
    await assert.rejects(
      requestEnvironmentSync(
        {
          sourceId,
          environmentId: staging.id,
          workspaceId,
          requestedBy: null,
          deployAfterSync: false,
        },
        async (input) => {
          syncId = input.syncId;
          if (state !== "queued")
            await database
              .update(sourceSyncs)
              .set({ status: state })
              .where(eq(sourceSyncs.id, syncId));
          throw new Error("Signal delivery response lost");
        },
      ),
      /Signal delivery response lost/,
    );
    const [record] = await database
      .select()
      .from(sourceSyncs)
      .where(eq(sourceSyncs.id, syncId));
    assert.equal(record?.status, state === "queued" ? "failed" : state);
    await database.delete(sourceSyncs).where(eq(sourceSyncs.id, syncId));
  }
}

export async function assertStaleSync(
  staging: typeof sourceEnvironments.$inferSelect,
  sync: () => Promise<unknown>,
  metadata: () => Promise<{ keys: string[] }>,
) {
  const database = getTowbarDatabase();

  await database
    .update(sourceEnvironments)
    .set({ mappingRevision: randomUUID(), branch: "next" })
    .where(eq(sourceEnvironments.id, staging.id));
  await assert.rejects(sync(), /mapping changed/);
  assert.deepEqual((await metadata()).keys, ["ADDED", "EMPTY"]);
}
