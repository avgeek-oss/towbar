import { assertAppStorageServer } from "../apps/storage.js";
import { and, eq, isNull, ne } from "drizzle-orm";
import {
  type IntegrationProvider,
  type IntegrationPurpose,
  type NormalizedDeployable,
  digestValue,
  integrationScopeAllows,
} from "@workspace/towbar-core";
import type {
  servers,
  sourceEnvironments,
} from "@workspace/towbar-database/schema";
import {
  apps,
  integrationAuthorizations,
  logPolicies,
  sourceEntities,
} from "@workspace/towbar-database/schema";
import { conflict } from "../../http/errors.js";
import type { getTowbarDatabase } from "../../infrastructure/database.js";
import { getRuntimeIntegrations } from "../../infrastructure/runtime-integrations.js";
import { reconcileInstanceSecretDeclarations } from "../secrets/declarations.js";
import { calculateDesiredDeploymentDigest } from "./deployment-digests.js";
import type {
  ManifestReconciliation,
  RepositoryTree,
  RequiredSecrets,
} from "@workspace/towbar-core";

type Transaction = Parameters<
  Parameters<ReturnType<typeof getTowbarDatabase>["transaction"]>[0]
>[0];

// eslint-disable-next-line complexity -- Materialization resolves every entity kind and integration scope in one deterministic snapshot.
export async function materializeEnvironment(
  transaction: Transaction,
  input: {
    reconciliation: ManifestReconciliation;
    sourceId: string;
    workspaceId: string;
    environment: typeof sourceEnvironments.$inferSelect;
    commitSha: string;
    tree: RepositoryTree;
    serverByIp: Map<string, typeof servers.$inferSelect>;
    requiredSecrets: Record<string, RequiredSecrets>;
  },
) {
  const { reconciliation, environment, workspaceId, tree, serverByIp } = input;
  const connections = await transaction
    .select()
    .from(integrationAuthorizations)
    .where(
      and(
        eq(integrationAuthorizations.workspaceId, workspaceId),
        isNull(integrationAuthorizations.disconnectedAt),
      ),
    );
  const availableIntegrations: IntegrationDescriptor[] = [
    ...connections.map(({ provider, scopes, slug }) => ({
      provider,
      scopes,
      slug,
    })),
    ...Object.keys(getRuntimeIntegrations().providers).map((provider) => {
      const typedProvider = provider as IntegrationProvider;
      return {
        provider: typedProvider,
        scopes: [
          {
            kind: "workspace" as const,
            purpose: purposeByProvider[typedProvider],
          },
        ],
        slug: typedProvider,
      };
    }),
  ];
  for (const action of [
    ...reconciliation.apps,
    ...reconciliation.compose,
    ...reconciliation.resources,
  ]) {
    if (action.action === "archive") {
      if (action.current)
        await transaction
          .update(apps)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(apps.id, action.current.id));
      continue;
    }
    const entity = action.desired!;
    validateIntegrationReferences(entity, {
      connections: availableIntegrations,
      environment: environment.name,
      sourceId: input.sourceId,
    });
    const entityType =
      entity.kind === "app"
        ? "app"
        : entity.kind === "compose"
          ? "compose"
          : "resource";
    const server = serverByIp.get(entity.server);
    if (!server)
      throw conflict(
        `Register server '${entity.server}' before syncing`,
        "SERVER_NOT_CONFIGURED",
      );
    if (entityType === "app" && action.current) {
      if (
        action.current.config.container.volumes?.length &&
        action.current.config.server !== entity.server
      ) {
        throw conflict(
          "Move this app's persistent data before changing its server",
          "APP_STORAGE_SERVER_MISMATCH",
        );
      }
      await assertAppStorageServer(transaction, action.current.id, server.id);
    }
    const [logical] = await transaction
      .insert(sourceEntities)
      .values({
        sourceId: input.sourceId,
        manifestId: entity.id,
        entityType,
        resourceType:
          entity.kind === "app" || entity.kind === "compose"
            ? null
            : entity.kind,
      })
      .onConflictDoNothing()
      .returning();
    const logicalEntity =
      logical ??
      (
        await transaction
          .select()
          .from(sourceEntities)
          .where(
            and(
              eq(sourceEntities.sourceId, input.sourceId),
              eq(sourceEntities.manifestId, entity.id),
              eq(sourceEntities.entityType, entityType),
            ),
          )
      )[0];
    if (!logicalEntity) throw new Error("Logical entity was not created");
    const resourceType =
      entity.kind === "app" || entity.kind === "compose" ? null : entity.kind;
    if (logicalEntity.resourceType !== resourceType) {
      const [retained] = await transaction
        .select({ id: apps.id })
        .from(apps)
        .where(
          and(
            eq(apps.entityId, logicalEntity.id),
            ne(apps.manifestState, "removed"),
          ),
        )
        .limit(1);
      if (retained)
        throw conflict(
          `Resource '${entity.id}' cannot change type while existing instances are retained`,
          "RESOURCE_TYPE_CHANGED",
        );
      await transaction
        .update(sourceEntities)
        .set({ resourceType })
        .where(eq(sourceEntities.id, logicalEntity.id));
    }
    const digest = calculateDesiredDeploymentDigest({
      commitSha: input.commitSha,
      deployable: entity,
      repositoryTree: tree,
      server: server.config,
    });
    const declarations = input.requiredSecrets[`${entityType}:${entity.id}`];
    if (!declarations)
      throw new Error(
        "Missing required secret declarations for resolved entity",
      );
    const values = {
      workspaceId,
      sourceId: input.sourceId,
      entityId: logicalEntity.id,
      sourceEnvironmentId: environment.id,
      serverId: server.id,
      manifestId: entity.id,
      kind: entity.kind,
      name: entity.name,
      description: entity.description ?? null,
      config: entity,
      configDigest: digestValue(entity),
      deploymentDigest: digest.deploymentDigest,
      sourceInputDigest: digest.sourceInputDigest,
      sourceRevision: input.commitSha,
      requiredSecrets: declarations,
      archivedAt: null,
      manifestState: "active" as const,
      retiredAt: null,
      updatedAt: new Date(),
    };
    const [instance] = action.current
      ? await transaction
          .update(apps)
          .set(values)
          .where(eq(apps.id, action.current.id))
          .returning({ id: apps.id })
      : await transaction
          .insert(apps)
          .values(values)
          .returning({ id: apps.id });
    if (!instance)
      throw new Error("Instance secret declarations were not resolved");
    if (entity.logs?.restrict === "admin") {
      await transaction
        .insert(logPolicies)
        .values({ workspaceId, workloadId: instance.id, restricted: true })
        .onConflictDoUpdate({
          target: [logPolicies.workspaceId, logPolicies.workloadId],
          set: { restricted: true, updatedAt: new Date() },
        });
    }
    await reconcileInstanceSecretDeclarations(
      {
        appId: instance.id,
        workspaceId,
        environment: environment.name,
        declarations: values.requiredSecrets,
      },
      transaction,
    );
    if (entity.kind === "app" && entity.preview?.enabled) {
      await reconcileInstanceSecretDeclarations(
        {
          appId: instance.id,
          workspaceId,
          environment: `preview:${environment.name}`,
          declarations: values.requiredSecrets,
        },
        transaction,
      );
    }
  }
}

type IntegrationReference = {
  path: string;
  providers: readonly IntegrationProvider[];
  purpose: IntegrationPurpose;
  slug: string;
};

type IntegrationDescriptor = Pick<
  typeof integrationAuthorizations.$inferSelect,
  "provider" | "scopes" | "slug"
>;

const purposeByProvider: Record<IntegrationProvider, IntegrationPurpose> = {
  aws: "backup",
  cloudflare: "ingress",
  doppler: "secret",
  gcs: "backup",
  github: "source",
  gitlab: "source",
  infisical: "secret",
  r2: "backup",
  registry: "image",
  s3: "backup",
};

function validateIntegrationReferences(
  entity: NormalizedDeployable,
  input: {
    connections: IntegrationDescriptor[];
    environment: string;
    sourceId: string;
  },
) {
  for (const reference of collectIntegrationReferences(entity)) {
    const connection = input.connections.find(
      (candidate) => candidate.slug === reference.slug,
    );
    if (!connection)
      throw conflict(
        `${reference.path} references disconnected or missing integration '${reference.slug}'`,
        "INTEGRATION_NOT_CONFIGURED",
      );
    if (!reference.providers.includes(connection.provider))
      throw conflict(
        `${reference.path} references '${reference.slug}', which uses incompatible provider '${connection.provider}'`,
        "INTEGRATION_PROVIDER_MISMATCH",
      );
    if (
      !integrationScopeAllows(connection.scopes, {
        environment: input.environment,
        kind: "repository",
        purpose: reference.purpose,
        repositoryId: input.sourceId,
      })
    )
      throw conflict(
        `${reference.path} references integration '${reference.slug}' outside its permitted repository or environment scope`,
        "INTEGRATION_SCOPE_DENIED",
      );
  }
}

function collectIntegrationReferences(
  entity: NormalizedDeployable,
): IntegrationReference[] {
  const references: IntegrationReference[] = [];
  const add = (
    slug: string | undefined,
    purpose: IntegrationPurpose,
    providers: readonly IntegrationProvider[],
    path: string,
  ) => {
    if (slug) references.push({ path, providers, purpose, slug });
  };
  if ("buildServer" in entity && entity.buildServer?.transfer === "registry")
    add(
      entity.buildServer.registry,
      "image",
      ["registry"],
      `${entity.id}.buildServer.registry`,
    );
  if ("deployment" in entity && entity.deployment?.type === "image")
    add(
      entity.deployment.registry,
      "image",
      ["registry"],
      `${entity.id}.deployment.registry`,
    );
  if (entity.externalSecrets)
    add(
      entity.externalSecrets.integration,
      "secret",
      ["infisical", "doppler"],
      `${entity.id}.externalSecrets.integration`,
    );
  if (entity.kind === "compose") {
    for (const [service, policy] of Object.entries(entity.services)) {
      add(
        policy.ingress?.type === "cloudflare-tunnel"
          ? policy.ingress.integration
          : undefined,
        "ingress",
        ["cloudflare"],
        `${entity.id}.services.${service}.ingress.integration`,
      );
    }
  } else {
    add(
      entity.ingress?.type === "cloudflare-tunnel"
        ? entity.ingress.integration
        : undefined,
      "ingress",
      ["cloudflare"],
      `${entity.id}.ingress.integration`,
    );
    if ("backup" in entity)
      add(
        entity.backup?.integration,
        "backup",
        ["s3", "r2", "gcs"],
        `${entity.id}.backup.integration`,
      );
  }
  return references;
}
