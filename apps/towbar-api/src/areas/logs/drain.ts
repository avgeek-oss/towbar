import { currentLogSequence } from "./policy.js";
import type { LogCollectorPrincipal } from "./ingest.js";
import { ensureLogSchema, logStorage } from "./storage.js";

export async function verifyLogDrain(
  principal: LogCollectorPrincipal,
  eventIds: string[],
) {
  const storage = logStorage();
  await ensureLogSchema(storage);
  const rows = await storage.execute<{ eventId: string }>(
    "SELECT DISTINCT eventId FROM log_records WHERE workspaceId = {workspaceId:UUID} AND serverId = {serverId:UUID} AND ingestSequence <= {sequence:UInt64} AND eventId IN {eventIds:Array(String)} LIMIT 128 FORMAT JSONEachRow",
    {
      workspaceId: principal.workspaceId,
      serverId: principal.serverId,
      eventIds,
      sequence: await currentLogSequence(principal.workspaceId),
    },
    { readOnly: true },
  );
  return { acceptedEventIds: rows.map((row) => row.eventId) };
}
