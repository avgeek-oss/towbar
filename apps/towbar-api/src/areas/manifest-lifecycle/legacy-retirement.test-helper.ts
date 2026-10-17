import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  apps,
  repositoryManifests,
  sourceEntities,
} from "@workspace/towbar-database/schema";
import type { SecretDatabase } from "../secrets/store.js";
import { listManifestLifecycle } from "./queries.js";

export async function assertIndependentRetirements(
  db: SecretDatabase,
  input: {
    workspaceId: string;
    fresh: typeof apps.$inferSelect;
    sourceId: string;
    sourceEnvironmentId: string;
  },
) {
  const { workspaceId, fresh, sourceId, sourceEnvironmentId } = input;
  const [destinationEntity] = await db
    .select()
    .from(sourceEntities)
    .where(
      and(
        eq(sourceEntities.sourceId, sourceId),
        eq(sourceEntities.manifestId, "site"),
      ),
    );
  assert(destinationEntity);
  const duplicateId = randomUUID();
  await db.insert(apps).values({
    ...fresh,
    id: duplicateId,
    sourceId: sourceId,
    sourceEnvironmentId: sourceEnvironmentId,
    entityId: destinationEntity.id,
    manifestState: "retired",
  });
  await db
    .update(apps)
    .set({ manifestState: "retired" })
    .where(eq(apps.id, fresh.id));
  await db
    .delete(repositoryManifests)
    .where(eq(repositoryManifests.workspaceId, workspaceId));
  const legacyRetirements = await listManifestLifecycle(workspaceId, {
    tab: "retirements",
    offset: 0,
    limit: 50,
  });
  assert.equal(legacyRetirements.items.length, 2);
  assert(legacyRetirements.items.every((item) => item.workloads.length === 1));
  assert.equal(
    new Set(legacyRetirements.items.map((item) => item.key)).size,
    2,
  );
  assert.deepEqual(
    new Set(
      legacyRetirements.items.flatMap((item) =>
        item.workloads.map((entry) => entry.id),
      ),
    ),
    new Set([fresh.id, duplicateId]),
  );
}
