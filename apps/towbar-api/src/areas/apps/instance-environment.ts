import { and, eq } from "drizzle-orm";
import {
  apps,
  sourceEnvironments,
  sourceSyncs,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { conflict } from "../../http/errors.js";
import type { SecretDatabase } from "../secrets/store.js";

export async function getInstanceEnvironment(
  input: { appId: string; workspaceId: string },
  database: SecretDatabase = getTowbarDatabase(),
) {
  const [environment] = await database
    .select({
      manifestState: apps.manifestState,
      id: sourceEnvironments.id,
      name: sourceEnvironments.name,
      previewsEnabled: sourceEnvironments.previewsEnabled,
      branch: sourceEnvironments.branch,
      mappingRevision: sourceEnvironments.mappingRevision,
      syncedMappingRevision: sourceSyncs.mappingRevision,
      latestCommitSha: sourceEnvironments.latestCommitSha,
      latestManifestDigest: sourceEnvironments.latestManifestDigest,
      disconnectedAt: sourceEnvironments.disconnectedAt,
    })
    .from(apps)
    .innerJoin(
      sourceEnvironments,
      and(
        eq(sourceEnvironments.id, apps.sourceEnvironmentId),
        eq(sourceEnvironments.sourceId, apps.sourceId),
      ),
    )
    .leftJoin(
      sourceSyncs,
      eq(sourceSyncs.id, sourceEnvironments.latestSuccessfulSyncId),
    )
    .where(
      and(eq(apps.id, input.appId), eq(apps.workspaceId, input.workspaceId)),
    )
    .limit(1);
  return environment ?? null;
}

export async function instanceSecretEnvironment(
  input: { appId: string; workspaceId: string; preview?: boolean },
  database: SecretDatabase = getTowbarDatabase(),
) {
  const environment = await getInstanceEnvironment(input, database);
  if (!environment)
    throw conflict(
      "This instance requires an environment mapping",
      "ENVIRONMENT_REQUIRED",
    );
  if (environment.disconnectedAt)
    throw conflict(
      "This environment is disconnected",
      "ENVIRONMENT_DISCONNECTED",
    );
  return input.preview ? `preview:${environment.name}` : environment.name;
}

export async function lockDeploymentEnvironment(
  expected: {
    id: string;
    mappingRevision: string;
    latestCommitSha: string | null;
  },
  transaction: SecretDatabase,
) {
  const [current] = await transaction
    .select()
    .from(sourceEnvironments)
    .where(eq(sourceEnvironments.id, expected.id))
    .for("update");
  if (!current || current.disconnectedAt)
    throw conflict(
      "This environment is disconnected",
      "ENVIRONMENT_DISCONNECTED",
    );
  if (
    current.mappingRevision !== expected.mappingRevision ||
    current.latestCommitSha !== expected.latestCommitSha
  )
    throw conflict(
      "The environment changed. Sync and retry the deployment.",
      "ENVIRONMENT_MAPPING_CHANGED",
    );
  return current;
}

export function deploymentEnvironmentSnapshot(environment: {
  id: string;
  name: string;
  branch: string;
  mappingRevision: string;
}) {
  const { id, name, branch, mappingRevision } = environment;
  return { id, name, branch, mappingRevision };
}
