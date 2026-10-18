import {
  getInstanceEnvironment,
  instanceSecretEnvironment,
} from "./instance-environment.js";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  isNormalizedResource,
  requiredKeysForStage,
  resolveSecretReferences,
  secretReferenceDependencies,
  secretStages,
  validateSecretReferences,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  previewEnvironments,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { HttpError, notFound, unprocessable } from "../../http/errors.js";
import {
  mutateSecret,
  readSecretMetadata,
  readSecretValues,
  requireSecretOwner,
} from "../secrets/store.js";
import type { SecretDatabase, SecretOwner } from "../secrets/store.js";
import type {
  NormalizedDeployable,
  RequiredSecrets,
  SecretMutation,
  SecretStage,
} from "@workspace/towbar-core";

export async function getEnvironmentSecretOwner(owner: SecretOwner) {
  const ownership = await requireSecretOwner(owner);
  if (owner.type !== "app") return { ...ownership, resource: false };
  const [app] = await getTowbarDatabase()
    .select({ config: apps.config })
    .from(apps)
    .where(and(eq(apps.id, owner.id), eq(apps.workspaceId, owner.workspaceId)))
    .limit(1);
  if (!app) throw notFound("App");
  return { ...ownership, resource: isNormalizedResource(app.config) };
}

export async function listEnvironmentSecrets(
  owner: SecretOwner,
  environment: string,
) {
  const ownership = await getEnvironmentSecretOwner(owner);
  if (
    (environment === "preview" || environment.startsWith("preview:")) &&
    ownership.resource
  )
    throw unprocessable("Resources do not support preview secrets");
  const stages = ownership.resource ? ["deployment" as const] : secretStages;
  const previewTargets =
    owner.type === "app" &&
    (environment === "preview" || environment.startsWith("preview:"))
      ? await getTowbarDatabase()
          .select({
            id: previewEnvironments.id,
            pullRequestNumber: previewEnvironments.pullRequestNumber,
          })
          .from(previewEnvironments)
          .where(
            and(
              eq(previewEnvironments.appId, owner.id),
              eq(previewEnvironments.workspaceId, owner.workspaceId),
              inArray(previewEnvironments.status, [
                "healthy",
                "failed",
                "building",
              ]),
            ),
          )
      : [];
  const successfulDeployments =
    owner.type === "app"
      ? await getTowbarDatabase()
          .selectDistinctOn([deployments.previewEnvironmentId], {
            previewId: deployments.previewEnvironmentId,
            revisions: deployments.secretRevisions,
          })
          .from(deployments)
          .where(
            and(
              eq(deployments.appId, owner.id),
              eq(
                deployments.environment,
                environment === "preview" || environment.startsWith("preview:")
                  ? "preview"
                  : "production",
              ),
              inArray(deployments.state, [
                "succeeded",
                "succeeded_with_warnings",
              ]),
            ),
          )
          .orderBy(
            deployments.previewEnvironmentId,
            desc(deployments.createdAt),
          )
      : [];
  return await Promise.all(
    stages.map(async (stage) => {
      const local = await readSecretMetadata({ ...owner, environment, stage });
      const global =
        owner.type === "app"
          ? await readSecretMetadata({
              workspaceId: owner.workspaceId,
              type: "workspace",
              environment: "production",
              stage,
            })
          : { keys: [], revision: null, updatedAt: null };
      const repository =
        owner.type === "app" && ownership.sourceId
          ? await readSecretMetadata({
              workspaceId: owner.workspaceId,
              type: "repository",
              id: ownership.sourceId,
              environment: "production",
              stage,
            })
          : { keys: [], revision: null, updatedAt: null };
      const localValues =
        owner.type === "app"
          ? await readSecretValues({ ...owner, environment, stage })
          : { values: {} };
      const dependencies = secretReferenceDependencies(localValues.values);
      const revisions = successfulDeployments[0]?.revisions;
      const hasPendingRevisions = (
        deploymentRevisions?: Record<string, string | null> | null,
      ) =>
        local.revision !== (deploymentRevisions?.[`${stage}:local`] ?? null) ||
        (dependencies.global &&
          global.revision !==
            (deploymentRevisions?.[`${stage}:global`] ?? null)) ||
        (dependencies.repository &&
          repository.revision !==
            (deploymentRevisions?.[`${stage}:repository`] ?? null));
      return {
        stage,
        environment,
        ...local,
        inheritedKeys: [] as string[],
        inheritedOrigins: {} as Record<string, "global">,
        availableReferences: {
          globals: owner.type === "app" ? global.keys : [],
          repo: repository.keys,
        },
        repositoryId: owner.type === "app" ? ownership.sourceId : null,
        inheritedRevisions: {
          global: global.revision,
          repository: repository.revision,
        },
        pendingChanges:
          owner.type === "app" &&
          ((environment === "preview" || environment.startsWith("preview:")) &&
          previewTargets.length
            ? previewTargets.some((preview) =>
                hasPendingRevisions(
                  successfulDeployments.find(
                    (deployment) => deployment.previewId === preview.id,
                  )?.revisions,
                ),
              )
            : hasPendingRevisions(revisions)),
        affectedDeployables: previewTargets.length
          ? previewTargets.map((preview) => ({
              id: preview.id,
              name: `PR #${preview.pullRequestNumber}`,
              kind: "preview" as const,
            }))
          : [],
      };
    }),
  );
}

export async function updateEnvironmentSecrets(input: {
  owner: SecretOwner;
  environment: string;
  stage: SecretStage;
  mutation: SecretMutation;
  actorUserId: string | null;
}) {
  const ownership = await getEnvironmentSecretOwner(input.owner);
  if (
    (input.environment === "preview" ||
      input.environment.startsWith("preview:")) &&
    ownership.resource
  )
    throw unprocessable("Resources do not support preview secrets");
  if (ownership.resource && input.stage !== "deployment")
    throw unprocessable("Resources only support runtime secrets");
  return await mutateSecret(
    { ...input.owner, environment: input.environment, stage: input.stage },
    input.mutation,
    input.actorUserId,
    (values) => {
      try {
        validateSecretReferences(
          values,
          input.owner.type === "server" ? "app" : input.owner.type,
        );
      } catch (error) {
        throw unprocessable(
          error instanceof Error ? error.message : "Invalid secret reference",
          "SECRET_REFERENCE_INVALID",
        );
      }
    },
  );
}

export async function resolveEnvironmentStage(
  input: {
    workspaceId: string;
    sourceId: string;
    appId: string;
    environment: string;
    stage: SecretStage;
  },
  database: SecretDatabase = getTowbarDatabase(),
) {
  const slot = {
    workspaceId: input.workspaceId,
    environment: input.environment,
    stage: input.stage,
  };
  const empty = { values: {} as Record<string, string>, revision: null };
  const local = await readSecretValues(
    { ...slot, type: "app", id: input.appId },
    database,
  );
  const dependencies = secretReferenceDependencies(local.values);
  const global = dependencies.global
    ? await readSecretValues(
        { ...slot, type: "workspace", environment: "production" },
        database,
      )
    : empty;
  // Resolve against the current owner so repository moves cannot retain access to the old store.
  const ownership = dependencies.repository
    ? await requireSecretOwner(
        { ...slot, type: "app", id: input.appId },
        database,
      )
    : null;
  const repository = ownership?.sourceId
    ? await readSecretValues(
        {
          ...slot,
          type: "repository",
          id: ownership.sourceId,
          environment: "production",
        },
        database,
      )
    : empty;
  return {
    values: resolveValues(local.values, global.values, repository.values),
    revisions: {
      [`${input.stage}:local`]: local.revision,
      [`${input.stage}:global`]: dependencies.global ? global.revision : null,
      [`${input.stage}:repository`]: dependencies.repository
        ? repository.revision
        : null,
    },
  };
}

function resolveValues(
  local: Record<string, string>,
  global: Record<string, string>,
  repository: Record<string, string>,
) {
  try {
    validateSecretReferences(local, "app");
    return resolveSecretReferences(local, global, repository);
  } catch (error) {
    throw unprocessable(
      error instanceof Error
        ? error.message
        : "Secret references could not be resolved",
      "SECRET_REFERENCE_INVALID",
    );
  }
}

export async function assertRequiredInstanceSecrets(
  input: {
    appId: string;
    sourceId: string;
    workspaceId: string;
    preview?: boolean;
    declarations?: RequiredSecrets;
    config?: NormalizedDeployable;
  },
  database: SecretDatabase = getTowbarDatabase(),
) {
  const config =
    input.config ??
    (
      await database
        .select({ config: apps.config })
        .from(apps)
        .where(
          and(
            eq(apps.id, input.appId),
            eq(apps.workspaceId, input.workspaceId),
          ),
        )
        .limit(1)
    )[0]?.config;
  const environment = await instanceSecretEnvironment(input, database);
  for (const stage of secretStages) {
    if (input.declarations) {
      const required = requiredKeysForStage(input.declarations, stage);
      if (!required.length) continue;
      const resolved = await resolveEnvironmentStage(
        { ...input, environment, stage },
        database,
      );
      const missing = required
        .filter((key) => !Object.hasOwn(resolved.values, key))
        .filter(() => !externallyResolved(config, stage));
      if (missing.length)
        throw unprocessable(
          `Required secrets missing in ${environment} (${stage}): ${missing.join(", ")}`,
          "REQUIRED_SECRETS_MISSING",
        );
      continue;
    }
    const metadata = await readSecretMetadata(
      {
        type: "app",
        id: input.appId,
        workspaceId: input.workspaceId,
        environment,
        stage,
      },
      database,
    );
    const missing = metadata.missingKeys.filter(
      () => !externallyResolved(config, stage),
    );
    if (missing.length)
      throw unprocessable(
        `Required secrets missing in ${environment} (${stage}): ${missing.join(", ")}`,
        "REQUIRED_SECRETS_MISSING",
      );
    if (metadata.declared && metadata.keys.length)
      await resolveEnvironmentStage({ ...input, environment, stage }, database);
  }
}

export async function getInstanceSecretReadiness(input: {
  appId: string;
  workspaceId: string;
}) {
  const database = getTowbarDatabase();
  const [app] = await database
    .select({
      requiredSecrets: apps.requiredSecrets,
      config: apps.config,
      sourceId: apps.sourceId,
    })
    .from(apps)
    .where(
      and(
        eq(apps.id, input.appId),
        eq(apps.workspaceId, input.workspaceId),
        isNull(apps.archivedAt),
      ),
    )
    .limit(1);
  if (!app) throw notFound("App");
  const environment = await instanceSecretEnvironment(
    {
      appId: input.appId,
      workspaceId: input.workspaceId,
    },
    database,
  );
  for (const stage of secretStages) {
    const required = requiredKeysForStage(app.requiredSecrets, stage);
    if (!required.length) continue;
    try {
      const resolved = await resolveEnvironmentStage(
        {
          appId: input.appId,
          environment,
          sourceId: app.sourceId,
          stage,
          workspaceId: input.workspaceId,
        },
        database,
      );
      if (
        required.some(
          (key) =>
            !Object.hasOwn(resolved.values, key) &&
            !externallyResolved(app.config, stage),
        )
      )
        return { ready: false };
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.code === "SECRET_REFERENCE_INVALID"
      )
        return { ready: false };
      throw error;
    }
  }
  return { ready: true };
}

function externallyResolved(
  config: NormalizedDeployable | undefined,
  stage: SecretStage,
) {
  const source = config?.externalSecrets;
  if (!source) return false;
  return stage === "deployment";
}

export async function listSecretEnvironments(owner: SecretOwner) {
  const ownership = await getEnvironmentSecretOwner(owner);
  if (owner.type === "workspace" || owner.type === "repository")
    return ["production"];
  if (owner.type === "app") {
    const environment = await getInstanceEnvironment({
      appId: owner.id,
      workspaceId: owner.workspaceId,
    });
    if (!environment)
      throw unprocessable(
        "This instance requires an environment mapping",
        "ENVIRONMENT_REQUIRED",
      );
    return ownership.resource
      ? [environment.name]
      : [environment.name, `preview:${environment.name}`];
  }
  throw unprocessable("Server credentials use their dedicated settings page");
}
