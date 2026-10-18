"use client";
import { SourceGitHubConnection } from "./source-github-connection";
import { useAccess } from "./access-context";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { groupDeployableInstances } from "@/lib/deployable-groups";
import { useDetailNavigation } from "@/hooks/use-detail-navigation";
import {
  DashboardCircleIcon,
  DatabaseIcon,
  Delete02Icon,
  CloudIcon,
  ReloadIcon,
  SourceCodeIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";

import { ElapsedTime } from "./elapsed-time";
import { EnvironmentChip } from "./environment-chip";

import { HugeiconsIcon } from "@hugeicons/react";
import { useParams } from "next/navigation";
import { useRouter } from "@/hooks/use-guarded-router";
import { type Key, type ReactNode } from "react";
import type {
  App,
  Deployment,
  Resource,
  RuntimeCapacity,
  Server,
  Source,
  SourceSync,
} from "@workspace/towbar-web-client";
import { useUrlTablePagination as useTablePagination } from "@/hooks/use-url-pagination";
import { Pagination } from "@avgeek-oss/design-system/navigation/pagination";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";

import {
  ActionButton,
  DashboardPage,
  FormCard,
  InlineLink,
  PageTabs,
  sourcesBreadcrumb,
} from "@/components/page-parts";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { RelativeTime } from "./last-synced-time";
import { formatDate } from "./dashboard-overview";
import { SourceEnvironmentManifest } from "./source-environment-manifest";
import { SourceEnvironments } from "./source-environments";
import { SourceEnvironmentConnect } from "./source-environment-connect";
import { SourceApps, SourceResources } from "./source-inventory";
import { ResponsiveSubtabs } from "./responsive-subtabs";
import { RepositorySecrets } from "./app-secrets";
import { AutoDeployControlEditor } from "./auto-deploy-control";

const SOURCE_SYNC_PAGE_SIZE = 10;

export function SourceDetail() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const router = useRouter();
  const detailNavigation = useDetailNavigation();
  const { can } = useAccess();
  const source = useApiQuery<{
    canManageSource: boolean;
    source: Source;
  }>(`/v1/core/sources/${sourceId}`);
  const repository = source.data?.source;
  const branches = useApiQuery<{ branches: string[] }>(
    repository && can("repository.read")
      ? `/v1/core/sources/${sourceId}/branches`
      : null,
  );
  const syncs = useApiQuery<{ syncs: SourceSync[] }>(
    `/v1/core/sources/${sourceId}/syncs`,
    5_000,
  );
  const apps = useApiQuery<{ apps: App[] }>(
    `/v1/core/sources/${sourceId}/apps`,
    5_000,
  );
  const resources = useApiQuery<{ resources: Resource[] }>(
    `/v1/core/sources/${sourceId}/resources`,
    5_000,
  );
  const deployments = useApiQuery<{ deployments: Deployment[] }>(
    `/v1/core/sources/${sourceId}/deployments`,
    5_000,
  );
  const capacity = useApiQuery<{ capacities: RuntimeCapacity[] }>(
    `/v1/core/sources/${sourceId}/capacity`,
    5_000,
  );
  const servers = useApiQuery<{ servers: Server[] }>("/v1/core/servers", 5_000);
  const error = source.error ?? syncs.error;
  if (error)
    return (
      <DashboardPage
        icon={SourceCodeIcon}
        titleIcon={
          <IntegrationProviderLogo
            provider={repository?.provider ?? "github"}
            className="size-6"
            size={24}
          />
        }
        breadcrumbAncestors={sourcesBreadcrumb}
        title="Repository"
      >
        <QueryError message={error} />
      </DashboardPage>
    );
  if (!source.data || !syncs.data) return <QueryLoading variant="detail" />;

  const item = source.data.source;
  const latestSync = syncs.data.syncs[0];
  const syncColumns: ResourceTableColumn<SourceSync>[] = [
    {
      key: "environment",
      header: "Environment",
      cell: (sync) =>
        sync.environment ? (
          <EnvironmentChip name={sync.environment.name} />
        ) : (
          "Not recorded"
        ),
      className: "min-w-36",
    },
    {
      key: "status",
      header: "Status",
      cell: (sync) => (
        <StatusBadge
          status={sync.status}
          tooltip={
            sync.finishedAt
              ? `Repository sync ${sync.status}. Finished ${formatDate(sync.finishedAt)}.`
              : `Repository sync ${sync.status}. Requested ${formatDate(sync.createdAt)}.`
          }
        />
      ),
    },
    {
      key: "branch",
      header: "Branch",
      cell: (sync) =>
        sync.environment ? (
          <TypographyCode className="whitespace-nowrap">
            {sync.environment.branch}
          </TypographyCode>
        ) : (
          "Not recorded"
        ),
      className: "min-w-36",
    },
    {
      key: "result",
      header: "Result",
      cell: (sync) =>
        getSyncIssueMessage(sync.issues) ??
        (sync.status === "succeeded"
          ? "Manifest accepted"
          : sync.status === "failed"
            ? "Sync failed"
            : "Pending validation"),
      className: "min-w-48 whitespace-nowrap",
    },
    {
      key: "requested",
      header: "Requested",
      cell: (sync) => <RelativeTime label="Requested" value={sync.createdAt} />,
      className: "whitespace-nowrap",
    },
    {
      key: "duration",
      header: "Duration",
      cell: (sync) => <ElapsedTime {...sync} />,
    },
    {
      key: "commit",
      header: "Commit",
      cell: (sync) => (
        <TypographyCode
          className="whitespace-nowrap"
          title={sync.commitSha ?? undefined}
        >
          {sync.commitSha?.slice(0, 12) ??
            (sync.status === "queued" || sync.status === "running"
              ? "Resolving revision"
              : "Revision not recorded")}
        </TypographyCode>
      ),
      className: "w-full min-w-44",
    },
  ];

  return (
    <DashboardPage
      icon={SourceCodeIcon}
      titleIcon={
        <IntegrationProviderLogo
          provider={item.provider}
          className="size-6"
          size={24}
        />
      }
      actions={
        <div className="flex flex-wrap justify-end gap-2">
          {source.data.canManageSource &&
          item.status === "active" &&
          detailNavigation.section === "environments" ? (
            <SourceEnvironmentConnect
              sourceId={sourceId}
              branches={branches.data?.branches ?? []}
            />
          ) : null}
          {item.status === "active" && can("repository.sync") ? (
            <ActionButton
              action={async () => {
                const result = await api.post<{
                  outcomes: {
                    environmentId: string;
                    syncId: string | null;
                    error: string | null;
                  }[];
                }>(`/v1/core/sources/${sourceId}/environments/syncs`);
                const failures = result.outcomes.filter(
                  (outcome) => outcome.error,
                );
                if (failures.length) {
                  throw new Error(
                    `${result.outcomes.length - failures.length} environment syncs queued; ${failures.length} failed: ${failures.map((outcome) => outcome.error).join("; ")}`,
                  );
                }
                if (!result.outcomes.length)
                  throw new Error("No connected environments to sync");
              }}
              confirm={{
                actionLabel: "Sync",
                description:
                  "Towbar will refresh each environment’s inventory from its mapped branch. This does not deploy workloads.",
                title: "Sync environments now?",
              }}
              pendingLabel="Queueing sync…"
              success="Environment syncs queued"
              variant="primary"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={ReloadIcon}
                className="size-4 shrink-0"
              />
              Sync
            </ActionButton>
          ) : null}
        </div>
      }
      breadcrumbAncestors={sourcesBreadcrumb}
      breadcrumbSwitcher={{ id: sourceId, kind: "sources" }}
      badge={
        (detailNavigation.section ?? "environments") === "environments" ? (
          latestSync ? (
            <InlineLink
              className="inline-flex items-center"
              href={`/repositories/${sourceId}/syncs/${latestSync.id}`}
            >
              <SyncStatusChip sync={latestSync} />
            </InlineLink>
          ) : (
            <SyncStatusChip />
          )
        ) : undefined
      }
      title={item.repositoryName}
      titleContent={
        item.repositoryUrl ? (
          <InlineExternalLink
            className="text-xl"
            href={item.repositoryUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${item.repositoryOwner}/${item.repositoryName} on ${item.provider === "github" ? "GitHub" : "GitLab"} (opens in a new tab)`}
            tooltip={`${item.repositoryOwner}/${item.repositoryName}`}
          >
            {item.repositoryName}
          </InlineExternalLink>
        ) : (
          <span className="truncate text-xl">{item.repositoryName}</span>
        )
      }
    >
      <PageTabs
        defaultValue="environments"
        tabs={[
          {
            value: "environments",
            label: "Environments",
            icon: <HugeiconsIcon icon={CloudIcon} />,
            content: (
              <SourceEnvironments
                sourceId={sourceId}
                canManage={source.data.canManageSource}
                branches={branches.data?.branches ?? []}
              />
            ),
          },
          {
            value: "services",
            label: "Services",
            icon: <HugeiconsIcon icon={DashboardCircleIcon} />,
            indicator: apps.data
              ? {
                  label: String(
                    groupDeployableInstances(apps.data.apps).length,
                  ),
                  variant: "secondary",
                }
              : undefined,
            content: (
              <SourceApps
                apps={apps.data?.apps}
                capacities={capacity.data?.capacities}
                deployments={deployments.data?.deployments}
                error={
                  apps.error ??
                  capacity.error ??
                  deployments.error ??
                  servers.error
                }
                servers={servers.data?.servers}
              />
            ),
          },
          {
            value: "datastores",
            label: "Datastores",
            icon: <HugeiconsIcon icon={DatabaseIcon} />,
            indicator: resources.data
              ? {
                  label: String(
                    groupDeployableInstances(resources.data.resources).length,
                  ),
                  variant: "secondary",
                }
              : undefined,
            content: (
              <SourceResources
                capacities={capacity.data?.capacities}
                deployments={deployments.data?.deployments}
                error={
                  resources.error ??
                  capacity.error ??
                  deployments.error ??
                  servers.error
                }
                resources={resources.data?.resources}
                servers={servers.data?.servers}
              />
            ),
          },
          {
            value: "manifest",
            label: "Manifest",
            group: "Repository information",
            icon: <HugeiconsIcon icon={SourceCodeIcon} />,
            content: <SourceEnvironmentManifest sourceId={sourceId} />,
          },
          {
            value: "sync-history",
            label: "Sync history",
            group: "Repository information",
            icon: <HugeiconsIcon icon={ReloadIcon} />,
            content: (
              <SourceSyncHistory
                columns={syncColumns}
                repositoryName={item.repositoryName}
                sourceId={sourceId}
                syncs={syncs.data.syncs}
              />
            ),
          },
          {
            value: "settings",
            label: "Settings",
            icon: <HugeiconsIcon icon={Settings01Icon} />,
            content: (
              <SourceSettings
                canManage={source.data.canManageSource}
                onDelete={() => router.push("/repositories")}
                sourceId={sourceId}
                source={item}
              />
            ),
          },
        ]}
      />
    </DashboardPage>
  );
}

function SourceSettings({
  canManage,
  onDelete,
  sourceId,
  source,
}: {
  source: Source;
  canManage: boolean;
  onDelete: () => void;
  sourceId: string;
}) {
  const { can } = useAccess();
  return (
    <SourceSubtabs
      ariaLabel="Repository settings"
      collapseOnMobile
      defaultSelectedKey="auto-deploy"
      tabs={[
        ...(canManage && source.provider === "github"
          ? [
              {
                value: "connection",
                label: "GitHub connection",
                content: <SourceGitHubConnection source={source} />,
              },
            ]
          : []),
        {
          value: "auto-deploy",
          label: "Auto-deploy",
          content: <AutoDeployControlEditor id={sourceId} type="source" />,
        },
        ...(can("sharedSecret.list")
          ? [
              {
                value: "secrets",
                label: "Repository Secrets",
                content: <RepositorySecrets sourceId={sourceId} />,
              },
            ]
          : []),
        ...(canManage
          ? [
              {
                value: "danger",
                label: "Delete repository",
                destructive: true,
                group: "Danger zone",
                content: (
                  <FormCard help={false} title="Danger zone">
                    <div className="content-grid">
                      <p className="max-w-3xl text-sm text-muted">
                        Disconnect all environments, then move or remove any
                        remaining workloads before deleting this repository.
                        Deployment history and ownership records are preserved.
                        Reconnecting the same repository restores its
                        connection.
                      </p>
                      <ActionButton
                        action={() =>
                          api.delete(`/v1/core/sources/${sourceId}`)
                        }
                        confirm={{
                          actionLabel: "Delete Repository",
                          description:
                            "Remove this disconnected repository from Towbar. Deployment and sync history, removed workload records, secrets, and backup metadata are preserved. You can reconnect the same repository later. This does not delete the Git repository.",
                          title: "Delete this Repository from Towbar?",
                        }}
                        onSuccess={onDelete}
                        pendingLabel="Deleting…"
                        success="Repository deleted"
                        variant="danger"
                      >
                        <HugeiconsIcon
                          aria-hidden="true"
                          icon={Delete02Icon}
                          className="size-4 shrink-0"
                        />
                        Delete Repository
                      </ActionButton>
                    </div>
                  </FormCard>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

function SourceSyncHistory({
  columns,
  repositoryName,
  sourceId,
  syncs,
}: {
  columns: ResourceTableColumn<SourceSync>[];
  repositoryName: string;
  sourceId: string;
  syncs: SourceSync[];
}) {
  const pagination = useTablePagination({
    pageSize: SOURCE_SYNC_PAGE_SIZE,
    total: syncs.length,
  });
  const visibleSyncs = syncs.slice(
    pagination.offset,
    pagination.offset + pagination.pageSize,
  );

  return (
    <div className="grid gap-4">
      <ResourceTable
        ariaLabel={`${repositoryName} sync history`}
        columns={columns}
        emptyDescription="Run the first sync to validate and import the deployment manifest."
        emptyTitle="No sync attempts yet"
        getRowHref={(sync) => `/repositories/${sourceId}/syncs/${sync.id}`}
        getRowKey={(sync) => sync.id}
        items={visibleSyncs}
      />
      {syncs.length > pagination.pageSize ? (
        <Pagination
          aria-label={`${repositoryName} sync history pages`}
          page={pagination.page}
          size="sm"
          totalPages={pagination.totalPages}
          onPageChange={pagination.setPage}
        />
      ) : null}
    </div>
  );
}

function SourceSubtabs({
  ariaLabel,
  collapseOnMobile = false,
  defaultSelectedKey,
  onSelectionChange,
  selectedKey,
  tabs,
}: {
  ariaLabel: string;
  collapseOnMobile?: boolean;
  defaultSelectedKey: string;
  onSelectionChange?: (key: Key) => void;
  selectedKey?: string;
  tabs: Array<{
    content: ReactNode;
    destructive?: boolean;
    disabledReason?: string;
    group?: string;
    icon?: ReactNode;
    isDisabled?: boolean;
    label: string;
    value: string;
  }>;
}) {
  return (
    <ResponsiveSubtabs
      ariaLabel={ariaLabel}
      collapseOnMobile={collapseOnMobile}
      defaultSelectedKey={defaultSelectedKey}
      selectedKey={selectedKey}
      sidebarWidth="wide"
      tabs={tabs}
      onSelectionChange={onSelectionChange}
    />
  );
}

function SyncStatusChip({ sync }: { sync?: SourceSync }) {
  return (
    <StatusBadge
      status={sync?.status ?? "unknown"}
      label={getSyncStatusLabel(sync)}
    />
  );
}

function getSyncStatusLabel(sync?: SourceSync) {
  if (!sync) return "Not synced";
  if (sync.status === "queued") return "Sync queued";
  if (sync.status === "running") return "Syncing";
  if (sync.status === "succeeded") return "Last sync succeeded";
  return "Sync failed";
}

function getSyncIssueMessage(issues: unknown[] | null) {
  const issue = issues?.[0];
  if (
    issue &&
    typeof issue === "object" &&
    "message" in issue &&
    typeof issue.message === "string"
  ) {
    return issue.message;
  }
  return undefined;
}
