import { and, eq, or } from "drizzle-orm";
import { deployments, releases } from "@workspace/towbar-database/schema";
import type { SecretDatabase } from "../secrets/store.js";

export async function getServerImageOwners(
  database: SecretDatabase,
  workspaceId: string,
  serverId: string,
) {
  const history = await database
    .select({
      appId: releases.appId,
      imageTag: releases.imageTag,
      imageDigest: releases.imageDigest,
    })
    .from(releases)
    .innerJoin(deployments, eq(deployments.id, releases.deploymentId))
    .where(
      and(
        eq(deployments.workspaceId, workspaceId),
        or(
          eq(deployments.serverId, serverId),
          eq(deployments.buildServerId, serverId),
        ),
      ),
    );
  const owners = new Map<string, string | null>();
  for (const release of history) {
    for (const identity of [release.imageTag, release.imageDigest]) {
      if (!identity) continue;
      const existing = owners.get(identity);
      owners.set(
        identity,
        existing === undefined || existing === release.appId
          ? release.appId
          : null,
      );
    }
  }
  return Object.fromEntries(
    [...owners].filter((entry): entry is [string, string] => entry[1] !== null),
  );
}
