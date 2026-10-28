import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  deployments,
  integrationInstallations,
  sourceEnvironments,
  sourceSyncs,
  sources,
} from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { requireActor } from "../auth/actor-context.js";
import { getGitHubRepository } from "../github/client.js";
import { getGitHubInstallationForSource } from "../github/service.js";
import { listRepositoryBranches } from "../github/branches.js";
import { publicSourceSelection } from "./public-selections.js";

export const changeGitHubConnectionSchema = z
  .object({
    githubInstallationId: z.string().uuid(),
    repositoryOwner: z.string().trim().min(1).max(255),
    repositoryName: z.string().trim().min(1).max(255),
  })
  .strict();

const defaultDependencies = {
  getRepository: getGitHubRepository,
  listBranches: listRepositoryBranches,
};

export async function changeSourceGitHubConnection(
  input: z.infer<typeof changeGitHubConnectionSchema> & {
    sourceId: string;
    workspaceId: string;
    actorUserId: string | null;
  },
  dependencies = defaultDependencies,
) {
  requireActor(input.workspaceId, ["repository.update"]);
  const database = getTowbarDatabase();
  const [source] = await database
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.workspaceId, input.workspaceId),
        eq(sources.provider, "github"),
        eq(sources.status, "active"),
      ),
    );
  if (!source?.integrationInstallationId) throw notFound("GitHub repository");
  const destination = await getGitHubInstallationForSource({
    installationId: input.githubInstallationId,
    workspaceId: input.workspaceId,
  });
  const repository = await dependencies.getRepository({
    installationId: destination.externalId,
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
  });
  let repositoryId = source.providerRepositoryId;
  if (!repositoryId) {
    const original = await getGitHubInstallationForSource({
      installationId: source.integrationInstallationId,
      workspaceId: input.workspaceId,
    });
    const existingRepository = await dependencies.getRepository({
      installationId: original.externalId,
      repositoryOwner: source.repositoryOwner,
      repositoryName: source.repositoryName,
    });
    repositoryId = existingRepository.id;
  }
  if (repositoryId !== repository.id)
    throw conflict(
      "Choose the same GitHub repository after its transfer or rename. A different repository must be added separately.",
      "REPOSITORY_IDENTITY_MISMATCH",
    );
  const branches = await dependencies.listBranches({
    installationId: destination.externalId,
    owner: repository.owner,
    repository: repository.name,
  });
  return database.transaction(async (transaction) => {
    const [activeDestination] = await transaction
      .select()
      .from(integrationInstallations)
      .where(eq(integrationInstallations.id, destination.id))
      .for("update");
    if (
      !activeDestination ||
      activeDestination.suspendedAt ||
      activeDestination.externalId !== destination.externalId
    )
      throw conflict(
        "The destination GitHub account changed. Refresh and try again.",
      );
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:github:id:${repository.id}`}, 0))`,
    );
    const repositoryKey = `${input.workspaceId}:github:${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${repositoryKey}, 0))`,
    );
    const [current] = await transaction
      .select()
      .from(sources)
      .where(eq(sources.id, source.id))
      .for("update");
    if (
      !current ||
      current.status !== "active" ||
      current.integrationInstallationId !== source.integrationInstallationId ||
      current.repositoryOwner !== source.repositoryOwner ||
      current.repositoryName !== source.repositoryName ||
      current.providerRepositoryId !== source.providerRepositoryId
    )
      throw conflict(
        "The repository connection changed. Refresh and try again.",
      );
    const environments = await transaction
      .select()
      .from(sourceEnvironments)
      .where(
        and(
          eq(sourceEnvironments.sourceId, source.id),
          isNull(sourceEnvironments.disconnectedAt),
        ),
      )
      .orderBy(sourceEnvironments.id)
      .for("update");
    const missing = environments.filter(
      (environment) => !branches.includes(environment.branch),
    );
    if (missing.length)
      throw conflict(
        `The destination is missing branches: ${[...new Set(missing.map((environment) => environment.branch))].join(", ")}`,
      );
    const [duplicate] = await transaction
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.workspaceId, input.workspaceId),
          eq(sources.provider, "github"),
          ne(sources.id, source.id),
          sql`((${sources.providerRepositoryId} = ${repository.id}) OR (lower(${sources.repositoryOwner}) = ${repository.owner.toLowerCase()} AND lower(${sources.repositoryName}) = ${repository.name.toLowerCase()}))`,
        ),
      );
    if (duplicate)
      throw conflict("This repository is already connected to another source");
    const [sync] = await transaction
      .select({ id: sourceSyncs.id })
      .from(sourceSyncs)
      .where(
        and(
          eq(sourceSyncs.sourceId, source.id),
          inArray(sourceSyncs.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    const [deployment] = await transaction
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.sourceId, source.id),
          sql`${deployments.state} NOT IN ('succeeded', 'succeeded_with_warnings', 'skipped', 'failed', 'cancelled')`,
        ),
      )
      .limit(1);
    if (sync || deployment)
      throw conflict(
        "Wait for this repository's active syncs and deployments to finish before changing its connection.",
      );
    const [updated] = await transaction
      .update(sources)
      .set({
        integrationInstallationId: destination.id,
        providerRepositoryId: repository.id,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, source.id))
      .returning(publicSourceSelection);
    for (const environment of environments)
      await transaction
        .update(sourceEnvironments)
        .set({ mappingRevision: randomUUID(), updatedAt: new Date() })
        .where(eq(sourceEnvironments.id, environment.id));
    return { source: updated };
  });
}
