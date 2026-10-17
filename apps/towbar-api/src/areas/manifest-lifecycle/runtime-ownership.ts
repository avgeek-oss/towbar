import { and, eq, inArray } from "drizzle-orm";
import { deployments } from "@workspace/towbar-database/schema";
import type { SecretDatabase } from "../secrets/store.js";

// Docker ownership labels are immutable. Deployment history retains the sources
// that were authorized to create runtime objects for this exact workload UUID.
export async function getRuntimeSourceIds(
  database: SecretDatabase,
  workspaceId: string,
  deployableIds: string[],
) {
  const sources = new Map<string, string[]>();
  if (!deployableIds.length) return sources;
  const history = await database
    .select({
      appId: deployments.appId,
      sourceId: deployments.sourceId,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.workspaceId, workspaceId),
        inArray(deployments.appId, deployableIds),
      ),
    )
    .groupBy(deployments.appId, deployments.sourceId);
  for (const row of history) {
    const ids = sources.get(row.appId) ?? [];
    ids.push(row.sourceId);
    sources.set(row.appId, ids);
  }
  return sources;
}
