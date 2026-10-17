"use client";
import { useAccess } from "./access-context";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { useState } from "react";
import {
  configuredRepositoryProviders,
  SourceCreateModal,
} from "./source-create";
import {
  InventorySidebar,
  useInventoryQuery,
  type InventoryCounts,
} from "./inventory-sidebar";
import {
  Add01Icon,
  DashboardCircleIcon,
  DatabaseIcon,
  GitBranchIcon,
  ReloadIcon,
} from "@hugeicons/core-free-icons";

import {
  Tooltip,
  TooltipText,
} from "@avgeek-oss/design-system/overlays/tooltip";

import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "next/navigation";
import type { App, Resource, Source } from "@workspace/towbar-web-client";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";

import { ActionButton, DashboardPage } from "@/components/page-parts";
import {
  prefetchApiQueries,
  refreshApiQueries,
  useApiQuery,
} from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import {
  queueRepositorySyncs,
  type RepositorySyncResponse,
} from "@/lib/repository-sync";
import { countSourceInventory } from "@/lib/source-inventory";
import { LastSyncedTime } from "./last-synced-time";

export function SourceIndex() {
  const router = useRouter();
  const [addingSource, setAddingSource] = useState(false);
  const { can } = useAccess();
  const filtered = useInventoryQuery("sources").includes("?");
  const query = useApiQuery<{ sources: Source[]; counts: InventoryCounts }>(
    useInventoryQuery("sources"),
  );
  const allSources = useApiQuery<{ sources: Source[] }>(
    filtered && can("repository.sync") ? "/v1/core/sources" : null,
  );
  const activeSources = (
    (filtered ? allSources.data : query.data)?.sources ?? []
  ).filter((source) => source.status === "active");
  const apps = useApiQuery<{ apps: App[] }>("/v1/core/apps");
  const resources = useApiQuery<{ resources: Resource[] }>(
    "/v1/core/resources",
  );
  const github = useApiQuery<{
    connections: { suspendedAt: string | null }[];
  }>("/v1/core/github/installation", 30_000);
  const gitlab = useApiQuery<{ connections: unknown[] }>(
    "/v1/core/gitlab/connections",
    30_000,
  );
  const providerAvailabilityLoaded = Boolean(github.data && gitlab.data);
  const hasConfiguredProvider =
    configuredRepositoryProviders({
      githubConnected: Boolean(
        github.data?.connections.some((item) => !item.suspendedAt),
      ),
      gitlabConnected: Boolean(gitlab.data?.connections.length),
    }).length > 0;
  const providerAvailabilityFailed = Boolean(github.error || gitlab.error);
  const noConfiguredProvider =
    providerAvailabilityLoaded && !hasConfiguredProvider;
  const addRepositoryDisabled =
    !providerAvailabilityFailed &&
    (!providerAvailabilityLoaded || noConfiguredProvider);
  const error = query.error ?? apps.error ?? resources.error;
  const inventory = countSourceInventory(
    apps.data?.apps ?? [],
    resources.data?.resources ?? [],
  );
  function prepareSource(source: Source) {
    const href = `/repositories/${source.id}`;
    router.prefetch(href);
    return prefetchApiQueries([
      `/v1/core/sources/${source.id}`,
      `/v1/core/sources/${source.id}/syncs`,
      `/v1/core/sources/${source.id}/apps`,
      `/v1/core/sources/${source.id}/resources`,
    ]);
  }
  const columns: ResourceTableColumn<Source>[] = [
    {
      key: "repository",
      header: "Repository",
      cell: (source) => (
        <span className="flex min-w-0 items-center gap-2">
          <IntegrationProviderLogo
            provider="github"
            className="size-5"
            size={20}
          />
          <TooltipText
            className="truncate"
            tooltip={`${source.repositoryOwner}/${source.repositoryName}`}
          >
            {source.repositoryOwner}/
            <span className="font-medium">{source.repositoryName}</span>
          </TooltipText>
        </span>
      ),
      className: "w-full min-w-56",
    },
    {
      key: "status",
      header: "Status",
      className: "whitespace-nowrap",
      cell: (source) => <StatusBadge status={source.status} />,
    },
    {
      key: "inventory",
      header: "Manifest inventories",
      className: "min-w-60 whitespace-nowrap",
      cell: (source) => {
        const counts = inventory.get(source.id);
        return (
          <span className="inline-flex items-center gap-4">
            {[
              {
                label: "service",
                count: counts?.apps ?? 0,
                icon: DashboardCircleIcon,
              },
              {
                label: "datastore",
                count: counts?.resources ?? 0,
                icon: DatabaseIcon,
              },
            ].map(({ label, count, icon }) => (
              <TooltipText
                key={label}
                aria-label={`${count} ${label}${count === 1 ? "" : "s"}`}
                tooltip={`${count} ${label}${count === 1 ? "" : "s"}`}
                className="inline-flex items-center gap-1.5"
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={icon}
                  className="size-4 text-muted-foreground"
                />
                <span className="tabular-nums">{count}</span>
                <span className="text-muted">
                  {label}
                  {count === 1 ? "" : "s"}
                </span>
              </TooltipText>
            ))}
          </span>
        );
      },
    },
    {
      key: "last-synced",
      header: "Last synced",
      cell: (source) => <LastSyncedTime value={source.updatedAt} />,
      className: "min-w-40 whitespace-nowrap",
    },
  ];

  return (
    <DashboardPage
      icon={GitBranchIcon}
      actions={
        <div className="flex flex-wrap justify-end gap-2">
          {can("repository.sync") && activeSources.length > 0 ? (
            <ActionButton
              action={async () => {
                const { queued, failures } = await queueRepositorySyncs(
                  activeSources,
                  (sourceId) =>
                    api.post<RepositorySyncResponse>(
                      `/v1/core/sources/${sourceId}/environments/syncs`,
                    ),
                );
                if (failures.length) {
                  refreshApiQueries();
                  throw new Error(
                    `${queued} environment sync${queued === 1 ? "" : "s"} queued. ${failures.join("; ")}`,
                  );
                }
              }}
              pendingLabel="Queueing syncs…"
              success="Repository syncs queued"
            >
              <HugeiconsIcon aria-hidden="true" icon={ReloadIcon} />
              Sync All
            </ActionButton>
          ) : null}
          {can("repository.connect") ? (
            <AddRepositoryButton
              isDisabled={addRepositoryDisabled}
              noConfiguredProvider={noConfiguredProvider}
              onPress={() => setAddingSource(true)}
            />
          ) : null}
        </div>
      }
      title="Repositories"
    >
      {addingSource && can("repository.connect") ? (
        <SourceCreateModal onClose={() => setAddingSource(false)} />
      ) : null}
      <InventorySidebar kind="sources" counts={query.data?.counts} />
      {error ? (
        <QueryError message={error} />
      ) : !query.data || !apps.data || !resources.data ? (
        <QueryLoading variant="table" />
      ) : (
        <ResourceTable
          ariaLabel="Repositories"
          columns={columns}
          emptyAction={
            can("repository.connect") ? (
              <AddRepositoryButton
                isDisabled={addRepositoryDisabled}
                noConfiguredProvider={noConfiguredProvider}
                onPress={() => setAddingSource(true)}
              />
            ) : undefined
          }
          emptyDescription={
            filtered
              ? "Try changing or clearing the filters."
              : "Connect a GitHub repository to import its Towbar manifest."
          }
          emptyTitle={
            filtered ? "No matching repositories" : "No repositories yet"
          }
          getRowHref={(source) => `/repositories/${source.id}`}
          getRowKey={(source) => source.id}
          items={query.data.sources}
          onRowLinkIntent={(source) => {
            void prepareSource(source).catch(() => undefined);
          }}
          onRowLinkNavigate={(source, event) => {
            event.preventDefault();
            void Promise.race([
              prepareSource(source),
              new Promise((resolve) => setTimeout(resolve, 150)),
            ])
              .catch(() => undefined)
              .finally(() => router.push(`/repositories/${source.id}`));
          }}
          tableClassName="min-w-[680px] 2xl:min-w-[900px]"
        />
      )}
    </DashboardPage>
  );
}

function AddRepositoryButton({
  isDisabled,
  noConfiguredProvider,
  onPress,
}: {
  isDisabled: boolean;
  noConfiguredProvider: boolean;
  onPress: () => void;
}) {
  const button = (
    <Button isDisabled={isDisabled} onPress={onPress}>
      <HugeiconsIcon
        aria-hidden="true"
        icon={Add01Icon}
        className="size-4 shrink-0"
      />
      Add repository
    </Button>
  );
  if (!noConfiguredProvider) return button;
  return (
    <Tooltip>
      <Tooltip.Trigger
        aria-label="Why adding a repository is unavailable"
        className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
        render={(props) => <span {...props} />}
        tabIndex={0}
      >
        {button}
      </Tooltip.Trigger>
      <Tooltip.Content placement="top" showArrow>
        <Tooltip.Arrow />
        No source provider connected yet.
      </Tooltip.Content>
    </Tooltip>
  );
}
