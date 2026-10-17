import { eq } from "drizzle-orm";
import { apps } from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import type { SecretDatabase } from "../secrets/store.js";

export async function assertManifestManaged(
  database: SecretDatabase,
  appId: string,
) {
  const [app] = await database
    .select({ state: apps.manifestState })
    .from(apps)
    .where(eq(apps.id, appId))
    .for("update");
  if (!app) throw notFound("Workload");
  if (app.state !== "active")
    throw conflict(
      "This workload has a manifest conflict or pending retirement. Correct its declaration in Git and sync before deploying.",
      "MANIFEST_NOT_MANAGED",
    );
}
