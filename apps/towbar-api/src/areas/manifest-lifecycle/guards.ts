import { eq } from "drizzle-orm";
import {
  apps,
  sourceEnvironments,
  sources,
} from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import type { SecretDatabase } from "../secrets/store.js";

export async function assertManifestManaged(
  database: SecretDatabase,
  appId: string,
) {
  const [app] = await database
    .select({
      state: apps.manifestState,
      disconnectedAt: sourceEnvironments.disconnectedAt,
      sourceStatus: sources.status,
    })
    .from(apps)
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .where(eq(apps.id, appId))
    .for("update", { of: apps });
  if (!app) throw notFound("Workload");
  if (
    app.state !== "active" ||
    app.disconnectedAt ||
    app.sourceStatus !== "active"
  )
    throw conflict(
      "This workload has a manifest conflict or pending retirement. Correct its declaration in Git and sync before deploying.",
      "MANIFEST_NOT_MANAGED",
    );
}
