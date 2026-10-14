import { asc, eq, sql } from "drizzle-orm";
import { logRetentionState } from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { getLogConfiguration } from "./configuration.js";
import { LogStorage, ensureLogSchema } from "./storage.js";

export async function maintainLogRetention(now = new Date()) {
  const configuration = getLogConfiguration();
  if (!configuration) return { requested: 0 };
  const db = getTowbarDatabase();
  const minimum = new Date(
    now.getTime() - configuration.retentionDays * 86400000,
  ).toISOString();
  await db.update(logRetentionState).set({
    cutoffAt: sql`greatest(${logRetentionState.cutoffAt}, ${minimum}::timestamptz)`,
  });
  const due = await db
    .select()
    .from(logRetentionState)
    .where(
      sql`${logRetentionState.prunedBeforeAt} is null or ${logRetentionState.prunedBeforeAt} < date_trunc('hour', ${logRetentionState.cutoffAt})`,
    )
    .orderBy(asc(logRetentionState.prunedBeforeAt))
    .limit(20);
  if (!due.length) return { requested: 0 };
  const storage = new LogStorage(configuration);
  await ensureLogSchema(storage);
  for (const state of due) {
    const floor = new Date(
      Math.floor(state.cutoffAt.getTime() / 3600000) * 3600000,
    );
    await storage.execute(
      "ALTER TABLE log_records DELETE WHERE workspaceId = {workspaceId:UUID} AND timestamp < {retentionFloor:DateTime64(9)}",
      { workspaceId: state.workspaceId, retentionFloor: floor.toISOString() },
    );
    await db
      .update(logRetentionState)
      .set({ prunedBeforeAt: floor })
      .where(eq(logRetentionState.workspaceId, state.workspaceId));
  }
  return { requested: due.length };
}
