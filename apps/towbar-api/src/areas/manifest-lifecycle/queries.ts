import { repositoryTransferSecrets } from "./transfer-secrets.js";
import { eq } from "drizzle-orm";
import {
  resourceOperations,
  servers,
  sources,
} from "@workspace/towbar-database/schema";
import type {
  ManifestLifecycleItem,
  ManifestLifecycleResponse,
} from "@workspace/towbar-core";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { changedConfigurationPaths, identityKey } from "./plan.js";
import { loadManifestRegistry } from "./reconcile.js";

export function listManifestLifecycle(
  workspaceId: string,
  query: {
    tab?: "conflicts" | "retirements";
    search?: string;
    offset: number;
    limit: number;
  },
): Promise<ManifestLifecycleResponse> {
  const database = getTowbarDatabase();
  return database.transaction(async (transaction) => {
    const registry = await loadManifestRegistry(transaction, workspaceId);
    const repositories = await transaction
      .select()
      .from(sources)
      .where(eq(sources.workspaceId, workspaceId));
    const hosts = await transaction
      .select()
      .from(servers)
      .where(eq(servers.workspaceId, workspaceId));
    const operations = await transaction
      .select({
        id: resourceOperations.id,
        state: resourceOperations.state,
        errorMessage: resourceOperations.errorMessage,
        request: resourceOperations.request,
      })
      .from(resourceOperations)
      .where(eq(resourceOperations.workspaceId, workspaceId));
    const repositoryName = (id: string) => {
      const source = repositories.find((r) => r.id === id);
      return source
        ? `${source.repositoryOwner}/${source.repositoryName}`
        : "Disconnected repository";
    };
    for (const plan of registry.plans) {
      const existing = plan.workloads[0];
      const target = plan.declarations[0];
      if (
        plan.state !== "active" ||
        existing?.manifestState !== "conflict" ||
        !target ||
        existing.sourceEnvironmentId === target.sourceEnvironmentId
      )
        continue;
      const snapshot = registry.environments.find(
        (entry) => entry.environment.id === target.sourceEnvironmentId,
      )!.snapshot;
      const secrets = await repositoryTransferSecrets(transaction, {
        workspaceId,
        appId: existing.id,
        sourceId: target.sourceId,
        environment: plan.environment,
        includePreview:
          target.config.kind === "app" && target.config.preview?.enabled,
        required:
          snapshot.manifest.requiredSecrets[
            `${target.config.kind === "app" ? "app" : target.config.kind === "compose" ? "compose" : "resource"}:${target.config.id}`
          ]!,
      });
      if (secrets.missing.length) {
        plan.state = "conflict";
        plan.reason = `Add destination Repository Secrets: ${secrets.missing.join(", ")}, then sync the destination.`;
      }
    }
    const items: ManifestLifecycleItem[] = registry.plans.flatMap((plan) => {
      const retained = registry.instances.filter(({ app }) =>
        plan.workloads.some((w) => w.id === app.id),
      );
      const groups =
        plan.declarations.length === 0
          ? retained.map((instance) => [instance])
          : [retained];
      return groups.flatMap((instances) => {
        const state = instances.some(
          ({ app }) => app.manifestState === "removing",
        )
          ? "removing"
          : plan.state === "active" &&
              instances.some(({ app }) => app.manifestState === "conflict")
            ? "conflict"
            : plan.state;
        if (state === "active") return [];
        return [
          {
            key:
              plan.declarations.length === 0
                ? `${identityKey(plan.environment, plan.manifestId)}:${instances[0]!.app.id}`
                : plan.key,
            manifestId: plan.manifestId,
            environment: plan.environment,
            state,
            reason:
              plan.reason ??
              (state === "conflict"
                ? "Sync the destination again after active operations finish to complete ownership reconciliation."
                : null),
            declarations: plan.declarations.map((d) => ({
              sourceId: d.sourceId,
              sourceEnvironmentId: d.sourceEnvironmentId,
              repository: repositoryName(d.sourceId),
              provider: repositories.find((source) => source.id === d.sourceId)
                ?.provider,
              branch:
                registry.environments.find(
                  (e) => e.environment.id === d.sourceEnvironmentId,
                )?.environment.branch ?? "",
              commitSha: d.commitSha,
              manifestFiles: declarationFiles(
                registry,
                d.sourceEnvironmentId,
                d.config.id,
              ).map((path) => {
                const source = repositories.find(
                  (source) => source.id === d.sourceId,
                );
                return {
                  path,
                  url:
                    source?.provider === "github"
                      ? `https://github.com/${source.repositoryOwner}/${source.repositoryName}/blob/${d.commitSha}/${path}`
                      : null,
                };
              }),
              changedPaths: instances[0]
                ? changedConfigurationPaths(instances[0].app.config, d.config)
                : [],
            })),
            workloads: instances.map(({ app }) => ({
              id: app.id,
              name: app.name,
              kind: app.kind,
              sourceId: app.sourceId,
              repository: repositoryName(app.sourceId),
              provider: repositories.find(
                (source) => source.id === app.sourceId,
              )?.provider,
              serverId: app.serverId,
              serverIp:
                hosts.find((s) => s.id === app.serverId)?.canonicalIp ?? "",
              revision: app.updatedAt.toISOString(),
              retiredAt: app.retiredAt?.toISOString() ?? null,
              href:
                app.kind === "app" || app.kind === "compose"
                  ? `/services/${app.id}`
                  : `/datastores/${app.id}`,
            })),
            operations: operations
              .filter(
                (o) =>
                  o.request.type === "cleanup_orphans" &&
                  instances.some(
                    ({ app }) =>
                      o.request.type === "cleanup_orphans" &&
                      app.id === o.request.retirementId,
                  ),
              )
              .map(({ id, state, errorMessage }) => ({
                id,
                state,
                errorMessage,
              })),
          },
        ];
      });
    });
    const counts = {
      conflicts: items.filter((i) => i.state === "conflict").length,
      retirements: items.filter((i) => i.state !== "conflict").length,
      removing: items.filter(
        (item) =>
          item.state === "removing" &&
          item.operations.some((operation) =>
            ["queued", "running"].includes(operation.state),
          ),
      ).length,
    };
    const filtered = items.filter(
      (i) =>
        (!query.tab ||
          (query.tab === "conflicts"
            ? i.state === "conflict"
            : i.state !== "conflict")) &&
        (!query.search ||
          JSON.stringify(i).toLowerCase().includes(query.search.toLowerCase())),
    );
    return {
      items: filtered.slice(query.offset, query.offset + query.limit),
      counts,
      total: filtered.length,
      nextOffset:
        query.offset + query.limit < filtered.length
          ? query.offset + query.limit
          : null,
    };
  });
}

function declarationFiles(
  registry: Awaited<ReturnType<typeof loadManifestRegistry>>,
  environmentId: string,
  manifestId: string,
) {
  const paths = registry.environments.find(
    (entry) => entry.environment.id === environmentId,
  )?.snapshot.paths;
  return paths && Object.hasOwn(paths, manifestId) ? paths[manifestId]! : [];
}
