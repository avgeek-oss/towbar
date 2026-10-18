import { withdrawRepository } from "./withdrawal.js";
import { recordAuditEvent } from "../../infrastructure/audit.js";
import { auditAttribution } from "../auth/actor-context.js";
import { actorAllows } from "@workspace/towbar-access";
import { captureQueuedActor, requireActor } from "../auth/actor-context.js";
import { environmentSyncStatuses } from "./environment-status.js";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  resolveRepositoryEnvironment,
  sourceEnvironmentMappingSchema,
} from "@workspace/towbar-core";
import {
  integrationInstallations,
  sourceEnvironments,
  sourceSyncs,
  sources,
} from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueueSourceSync } from "../../infrastructure/temporal.js";
import { fetchRepositoryEnvironmentSnapshot } from "./repository-provider.js";

export async function sourceRepository(sourceId: string, workspaceId: string) {
  const [source] = await getTowbarDatabase()
    .select({
      id: sources.id,
      repositoryName: sources.repositoryName,
      repositoryOwner: sources.repositoryOwner,
      provider: sources.provider,
      installationId: integrationInstallations.externalId,
      connectionId: sources.integrationAuthorizationId,
      projectId: sources.providerRepositoryId,
    })
    .from(sources)
    .leftJoin(
      integrationInstallations,
      eq(integrationInstallations.id, sources.integrationInstallationId),
    )
    .where(
      and(
        eq(sources.id, sourceId),
        eq(sources.workspaceId, workspaceId),
        eq(sources.status, "active"),
      ),
    )
    .limit(1);
  if (!source) throw notFound("Source");
  if (source.provider === "github" && source.installationId)
    return {
      id: source.id,
      provider: "github" as const,
      installationId: source.installationId,
      repositoryName: source.repositoryName,
      repositoryOwner: source.repositoryOwner,
    };
  if (source.provider === "gitlab" && source.connectionId && source.projectId)
    return {
      id: source.id,
      provider: "gitlab" as const,
      connectionId: source.connectionId,
      projectId: source.projectId,
      repositoryName: source.repositoryName,
      repositoryOwner: source.repositoryOwner,
      workspaceId,
    };
  throw new Error("Repository provider connection is incomplete");
}

export async function listSourceEnvironments(
  sourceId: string,
  workspaceId: string,
) {
  await sourceRepository(sourceId, workspaceId);
  return environmentSyncStatuses([sourceId]);
}

export async function connectSourceEnvironment(input: {
  sourceId: string;
  workspaceId: string;
  environment: string;
  branch: string;
  actorUserId: string | null;
}) {
  const actor = requireActor(input.workspaceId, ["repository.connect"]);
  const mapping = sourceEnvironmentMappingSchema.parse({
    environment: input.environment,
    branch: input.branch,
  });
  const source = await sourceRepository(input.sourceId, input.workspaceId);
  const snapshot = await fetchRepositoryEnvironmentSnapshot({
    ...source,
    branch: mapping.branch,
  });
  const resolved = resolveRepositoryEnvironment({ ...snapshot, ...mapping });
  return getTowbarDatabase().transaction(async (transaction) => {
    const [currentSource] = await transaction
      .select()
      .from(sources)
      .where(eq(sources.id, source.id))
      .for("update");
    if (
      !currentSource ||
      currentSource.status !== "active" ||
      currentSource.repositoryOwner !== source.repositoryOwner ||
      currentSource.repositoryName !== source.repositoryName
    )
      throw conflict(
        "The repository connection changed. Refresh before adding an environment.",
      );
    const [existing] = await transaction
      .select()
      .from(sourceEnvironments)
      .where(
        and(
          eq(sourceEnvironments.sourceId, source.id),
          eq(sourceEnvironments.name, mapping.environment),
        ),
      )
      .for("update");
    if (existing && !existing.disconnectedAt)
      throw conflict(
        "This environment is already connected",
        "ENVIRONMENT_ALREADY_CONNECTED",
      );
    const values = {
      sourceId: source.id,
      name: mapping.environment,
      branch: mapping.branch,
      previewsEnabled: resolved.manifest.previewsEnabled,
      mappingRevision: randomUUID(),
      disconnectedAt: null,
      autoDeployPaused: !actorAllows(actor, ["deployment.create"]),
      updatedAt: new Date(),
    };
    const [environment] = existing
      ? await transaction
          .update(sourceEnvironments)
          .set(values)
          .where(eq(sourceEnvironments.id, existing.id))
          .returning()
      : await transaction.insert(sourceEnvironments).values(values).returning();
    if (!environment) throw new Error("Unable to connect environment");
    await recordAuditEvent(transaction, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: "source.environment.connected",
      targetType: "source",
      targetId: source.id,
      metadata: { environment: mapping.environment, branch: mapping.branch },
      ...auditAttribution(),
    });
    return environment;
  });
}

export async function updateEnvironmentBranch(input: {
  sourceId: string;
  environmentId: string;
  workspaceId: string;
  branch: string;
  expectedRevision: string;
  actorUserId: string | null;
}) {
  const actor = requireActor(input.workspaceId, ["repository.update"]);
  const source = await sourceRepository(input.sourceId, input.workspaceId);
  const [environment] = await getTowbarDatabase()
    .select()
    .from(sourceEnvironments)
    .where(
      and(
        eq(sourceEnvironments.id, input.environmentId),
        eq(sourceEnvironments.sourceId, source.id),
        isNull(sourceEnvironments.disconnectedAt),
      ),
    );
  if (!environment) throw notFound("Environment");
  const mapping = sourceEnvironmentMappingSchema.parse({
    environment: environment.name,
    branch: input.branch,
  });
  const snapshot = await fetchRepositoryEnvironmentSnapshot({
    ...source,
    branch: mapping.branch,
  });
  resolveRepositoryEnvironment({ ...snapshot, ...mapping });
  return getTowbarDatabase().transaction(async (transaction) => {
    const [updated] = await transaction
      .update(sourceEnvironments)
      .set({
        branch: mapping.branch,
        ...(!actorAllows(actor, ["deployment.create"])
          ? { autoDeployPaused: true }
          : {}),
        mappingRevision: randomUUID(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sourceEnvironments.id, environment.id),
          eq(sourceEnvironments.mappingRevision, input.expectedRevision),
          isNull(sourceEnvironments.disconnectedAt),
        ),
      )
      .returning();
    if (!updated)
      throw conflict(
        "The environment mapping changed. Refresh before saving.",
        "ENVIRONMENT_MAPPING_CHANGED",
      );
    await recordAuditEvent(transaction, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: "source.environment.branch_updated",
      targetType: "source",
      targetId: source.id,
      metadata: {
        environment: environment.name,
        previousBranch: environment.branch,
        branch: mapping.branch,
      },
      ...auditAttribution(),
    });
    return updated;
  });
}

export async function requestEnvironmentSync(
  input: {
    sourceId: string;
    environmentId: string;
    workspaceId: string;
    requestedBy: string | null;
    deployAfterSync: boolean;
    expectedMappingRevision?: string;
  },
  enqueue = enqueueSourceSync,
) {
  await sourceRepository(input.sourceId, input.workspaceId);
  const sync = await getTowbarDatabase().transaction(async (transaction) => {
    const [environment] = await transaction
      .select()
      .from(sourceEnvironments)
      .where(
        and(
          eq(sourceEnvironments.id, input.environmentId),
          eq(sourceEnvironments.sourceId, input.sourceId),
          isNull(sourceEnvironments.disconnectedAt),
        ),
      )
      .for("update");
    if (!environment) throw notFound("Environment");
    if (
      input.expectedMappingRevision &&
      environment.mappingRevision !== input.expectedMappingRevision
    ) {
      throw conflict(
        "Environment branch mapping changed. Retry with the current mapping.",
        "ENVIRONMENT_MAPPING_CHANGED",
      );
    }
    if (
      !actorAllows(requireActor(input.workspaceId, ["repository.sync"]), [
        "deployment.create",
      ])
    ) {
      await transaction
        .update(sourceEnvironments)
        .set({ autoDeployPaused: true, updatedAt: new Date() })
        .where(eq(sourceEnvironments.id, environment.id));
    }
    const [row] = await transaction
      .insert(sourceSyncs)
      .values({
        sourceId: input.sourceId,
        sourceEnvironmentId: environment.id,
        mappingRevision: environment.mappingRevision,
        requestedBy: input.requestedBy,
        ...captureQueuedActor(
          input.workspaceId,
          input.deployAfterSync
            ? ["repository.sync", "deployment.create"]
            : ["repository.sync"],
        ),
        deployAfterSync: input.deployAfterSync,
      })
      .returning();
    if (!row) throw new Error("Unable to queue environment sync");
    return row;
  });
  try {
    await enqueue({ sourceId: input.sourceId, syncId: sync.id });
  } catch (error) {
    await getTowbarDatabase()
      .update(sourceSyncs)
      .set({
        status: "failed",
        finishedAt: new Date(),
        issues: [
          {
            message: "Unable to enqueue sync. Retry the environment sync.",
            path: [],
          },
        ],
      })
      .where(
        and(eq(sourceSyncs.id, sync.id), eq(sourceSyncs.status, "queued")),
      );
    throw error;
  }
  return sync;
}

export function disconnectSourceEnvironment(input: {
  sourceId: string;
  environmentId: string;
  workspaceId: string;
  expectedRevision: string;
  actorUserId: string | null;
  expectedRemovalRevision?: string;
}) {
  return getTowbarDatabase().transaction(async (transaction) => {
    const result = await withdrawRepository(transaction, {
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      environmentId: input.environmentId,
      expectedMappingRevision: input.expectedRevision,
      expectedRevision: input.expectedRemovalRevision,
      actorUserId: input.actorUserId,
    });
    if (!("name" in result))
      throw new Error("Environment withdrawal did not return an environment");
    return result;
  });
}

export async function getEnvironmentManifest(input: {
  sourceId: string;
  environmentId: string;
  workspaceId: string;
}) {
  await sourceRepository(input.sourceId, input.workspaceId);
  const [environment] = await getTowbarDatabase()
    .select()
    .from(sourceEnvironments)
    .where(
      and(
        eq(sourceEnvironments.id, input.environmentId),
        eq(sourceEnvironments.sourceId, input.sourceId),
      ),
    );
  if (!environment) throw notFound("Environment");
  if (!environment.latestSuccessfulSyncId) return null;
  const [sync] = await getTowbarDatabase()
    .select({
      commitSha: sourceSyncs.commitSha,
      rawManifest: sourceSyncs.rawManifest,
    })
    .from(sourceSyncs)
    .where(
      and(
        eq(sourceSyncs.id, environment.latestSuccessfulSyncId),
        eq(sourceSyncs.sourceEnvironmentId, environment.id),
      ),
    );
  if (!sync?.rawManifest) return null;
  const snapshot = JSON.parse(sync.rawManifest) as {
    root: string;
    files: { path: string; content: string }[];
  };
  return {
    commitSha: sync.commitSha,
    files: [{ path: "towbar.yml", content: snapshot.root }, ...snapshot.files],
  };
}
