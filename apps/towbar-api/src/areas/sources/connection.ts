import { requireActor } from "../auth/actor-context.js";
import { actorAllows } from "@workspace/towbar-access";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  resolveRepositoryEnvironment,
  sourceEnvironmentMappingSchema,
} from "@workspace/towbar-core";
import { sourceEnvironments, sources } from "@workspace/towbar-database/schema";
import { conflict } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { getGitHubRepository } from "../github/client.js";
import { getGitHubInstallationForSource } from "../github/service.js";
import { fetchRepositoryEnvironmentSnapshot } from "./repository-provider.js";
import { publicSourceSelection } from "./public-selections.js";
import { requestEnvironmentSync } from "./environments.js";

const repositoryProviderSchema = z
  .object({
    provider: z.literal("github").default("github"),
    githubInstallationId: z.string().uuid(),
  })
  .strict();
const repositoryCommonSchema = z
  .object({
    repositoryOwner: z.string().trim().min(1).max(255),
    repositoryName: z.string().trim().min(1).max(255),
  })
  .strict();
const sourceDiscoveryCommonSchema = repositoryCommonSchema.extend({
  discoveryBranch: sourceEnvironmentMappingSchema.shape.branch,
});
export const sourceDiscoverySchema = sourceDiscoveryCommonSchema.extend(
  repositoryProviderSchema.shape,
);
export const sourceConnectionSchema = repositoryCommonSchema.extend({
  ...repositoryProviderSchema.shape,
  environments: z
    .array(sourceEnvironmentMappingSchema)
    .min(1)
    .refine(
      (mappings) =>
        new Set(mappings.map((mapping) => mapping.environment)).size ===
        mappings.length,
      "An environment can only be connected once",
    ),
});

export async function discoverSource(
  input: z.infer<typeof sourceDiscoverySchema> & { workspaceId: string },
) {
  const connection = await repositoryConnection(input);
  const snapshot = await fetchRepositoryEnvironmentSnapshot({
    ...connection,
    branch: input.discoveryBranch,
  });
  return {
    commitSha: snapshot.commitSha,
    environments: Object.entries(snapshot.configuration.environments).map(
      ([name, config]) => ({
        name,
        previewsEnabled: config.previews?.enabled ?? false,
      }),
    ),
  };
}

export async function connectRepositorySource(
  input: z.infer<typeof sourceConnectionSchema> & {
    workspaceId: string;
    actorUserId: string | null;
  },
  dependencies = {
    repository: getGitHubRepository,
    snapshot: fetchRepositoryEnvironmentSnapshot,
    requestSync: requestEnvironmentSync,
  },
) {
  const actor = requireActor(input.workspaceId, ["repository.connect"]);
  const connection = await repositoryConnection(input);
  const githubRepository = await dependencies.repository(connection);
  const resolved: {
    environment: string;
    branch: string;
    previewsEnabled: boolean;
  }[] = [];
  for (const mapping of input.environments) {
    const snapshot = await dependencies.snapshot({
      ...connection,
      branch: mapping.branch,
    });
    const environment = resolveRepositoryEnvironment({
      ...snapshot,
      ...mapping,
    });
    resolved.push({
      ...mapping,
      previewsEnabled: environment.manifest.previewsEnabled,
    });
  }
  const result = await getTowbarDatabase().transaction(async (transaction) => {
    const owner = githubRepository.owner;
    const name = githubRepository.name;
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:github:id:${githubRepository.id}`}, 0))`,
    );
    const repositoryKey = `${input.workspaceId}:${connection.provider}:${owner.toLowerCase()}/${name.toLowerCase()}`;
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${repositoryKey}, 0))`,
    );
    const [existing] = await transaction
      .select({ id: sources.id, status: sources.status })
      .from(sources)
      .where(
        and(
          eq(sources.workspaceId, input.workspaceId),
          eq(sources.provider, connection.provider),
          or(
            eq(sources.providerRepositoryId, githubRepository.id),
            and(
              sql`lower(${sources.repositoryOwner}) = ${owner.toLowerCase()}`,
              sql`lower(${sources.repositoryName}) = ${name.toLowerCase()}`,
            ),
          ),
        ),
      )
      .for("update");
    if (existing?.status === "active")
      throw conflict(
        "This repository is already connected. Add an environment to the existing Repository.",
        "SOURCE_ALREADY_CONNECTED",
      );
    const values = {
      workspaceId: input.workspaceId,
      provider: connection.provider,
      integrationInstallationId: input.githubInstallationId,
      integrationAuthorizationId: null,
      providerRepositoryId: githubRepository.id,
      repositoryName: githubRepository.name,
      repositoryOwner: githubRepository.owner,
    };
    const [source] = existing
      ? await transaction
          .update(sources)
          .set({
            ...values,
            status: "active",
            archivedAt: null,
            autoDeployPaused: !actorAllows(actor, ["deployment.create"]),
            updatedAt: new Date(),
          })
          .where(eq(sources.id, existing.id))
          .returning(publicSourceSelection)
      : await transaction
          .insert(sources)
          .values(values)
          .returning(publicSourceSelection);
    if (!source) throw new Error("Unable to connect Source");
    const environments = await transaction
      .insert(sourceEnvironments)
      .values(
        resolved.map((mapping) => ({
          sourceId: source.id,
          name: mapping.environment,
          branch: mapping.branch,
          previewsEnabled: mapping.previewsEnabled,
          autoDeployPaused: !actorAllows(actor, ["deployment.create"]),
        })),
      )
      .onConflictDoUpdate({
        target: [sourceEnvironments.sourceId, sourceEnvironments.name],
        set: {
          branch: sql`excluded.branch`,
          previewsEnabled: sql`excluded.previews_enabled`,
          autoDeployPaused: !actorAllows(actor, ["deployment.create"]),
          mappingRevision: sql`gen_random_uuid()`,
          disconnectedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return { source, environments };
  });
  const syncs = [];
  for (const environment of result.environments) {
    try {
      const sync = await dependencies.requestSync({
        sourceId: result.source.id,
        environmentId: environment.id,
        workspaceId: input.workspaceId,
        requestedBy: input.actorUserId,
        deployAfterSync: false,
      });
      syncs.push({
        environmentId: environment.id,
        syncId: sync.id,
        error: null,
      });
    } catch (error) {
      syncs.push({
        environmentId: environment.id,
        syncId: null,
        error:
          error instanceof Error ? error.message : "Sync could not be queued",
      });
    }
  }
  return { ...result, syncs };
}

async function repositoryConnection(input: {
  repositoryName: string;
  repositoryOwner: string;
  workspaceId: string;
  provider: "github";
  githubInstallationId: string;
}) {
  const installation = await getGitHubInstallationForSource({
    installationId: input.githubInstallationId,
    workspaceId: input.workspaceId,
  });
  return {
    provider: "github" as const,
    installationId: installation.externalId,
    repositoryName: input.repositoryName,
    repositoryOwner: input.repositoryOwner,
  };
}
