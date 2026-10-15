"use client";

import { LogCollectorSettings } from "./log-collector-settings";
import {
  ServerCleanupHistory,
  type ServerCleanupPage,
} from "./server-cleanup-history";
import { ServerTerminal } from "./server-terminal";
import { CleanupObjectType } from "./cleanup-object-type";
import { useAccess } from "./access-context";
import { useDetailNavigation } from "@/hooks/use-detail-navigation";
import {
  CleanIcon,
  CommandLineIcon,
  Activity01Icon,
  SquareActivityIcon,
  Alert02Icon,
  AlertCircleIcon,
  ComputerActivityIcon,
  DashboardCircleIcon,
  DatabaseIcon,
  Delete02Icon,
  ServerOffIcon,
  ServerStack01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";

import { MonitoringAgentSettings } from "./monitoring-agent-settings";
import { ScoutMascot } from "./scout-mascot";
import {
  ScoutAlertRules,
  ScoutIncidents,
  ScoutPerformance,
} from "./scout-panel";
import { ElapsedTime } from "./elapsed-time";

import {
  PrepareServerButton,
  ServerPreparationChecklist,
  ServerPreparationOverview,
} from "./server-preparation";

import { ServerEditor } from "./server-editor";
import { CloudProviderLogo } from "./cloud-provider-logo";
import { ServerHardwareDescription } from "./server-hardware";

import { HugeiconsIcon } from "@hugeicons/react";
import Image from "next/image";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type {
  App,
  MonitoringAgentStatus,
  LogCollectionStatus,
  OrphanItem,
  Resource,
  ResourceOperation,
  RuntimeCapacity,
  SecretMetadata,
  Server,
  ServerCheck,
  ServerChecksPage,
  ServerPreparation,
} from "@workspace/towbar-web-client";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { useTablePagination } from "@avgeek-oss/design-system/hooks/use-table-pagination";
import { Pagination } from "@avgeek-oss/design-system/navigation/pagination";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceName,
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
  serversBreadcrumb,
} from "@/components/page-parts";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { serverPreparationIndicator } from "@/lib/server-preparation-visibility";
import { reconcileServerSetupStatus } from "@/lib/server-preparation-status";
import { hasScheduledPostSetupCheck } from "@/lib/server-preparation-redirect";
import { RelativeTime } from "./last-synced-time";
import { formatDate } from "./dashboard-overview";
import { ServerHostCapacity, ServerDeployableTable } from "./server-capacity";
import { ResponsiveSubtabs } from "./responsive-subtabs";

const SERVER_CHECK_PAGE_SIZE = 10;

export function ServerDetail() {
  const detailNavigation = useDetailNavigation();
  const requestedSettings = detailNavigation.settings;
  const requestedSettingsTab = [
    "logs-collection",
    "monitoring",
    "cleanup",
    "danger",
  ].includes(requestedSettings ?? "")
    ? requestedSettings!
    : "configuration";
  const { serverId } = useParams<{
    serverId: string;
  }>();
  const router = useRouter();
  const { can } = useAccess();
  const server = useApiQuery<{
    canCleanupOrphans: boolean;
    canManageServer: boolean;
    canRemoveServer: boolean;
    server: Server;
  }>(`/v1/core/servers/${serverId}`, 5_000);
  const checks = useApiQuery<ServerChecksPage>(
    `/v1/core/servers/${serverId}/checks?page=1&limit=${SERVER_CHECK_PAGE_SIZE}`,
    5_000,
  );
  const capacity = useApiQuery<{ capacity: RuntimeCapacity }>(
    `/v1/core/servers/${serverId}/capacity`,
    5_000,
  );
  const apps = useApiQuery<{ apps: App[] }>("/v1/core/apps", 5_000);
  const resources = useApiQuery<{ resources: Resource[] }>(
    "/v1/core/resources",
    5_000,
  );
  const monitoring = useApiQuery<{ agent: MonitoringAgentStatus }>(
    `/v1/core/servers/${serverId}/monitoring`,
    5_000,
  );
  const collector = useApiQuery<LogCollectionStatus>(
    `/v1/core/servers/${serverId}/log-collection`,
    5_000,
  );
  const keys = useApiQuery<{ hostKeys: { id: string }[] }>(
    can("server.credentials") ? `/v1/core/servers/${serverId}/host-keys` : null,
  );
  const credentials = useApiQuery<{
    credential: SecretMetadata;
    selectedPrivateKeyId: string | null;
  }>(
    can("server.credentials")
      ? `/v1/core/servers/${serverId}/credentials`
      : null,
  );
  const preparations = useApiQuery<{ preparations: ServerPreparation[] }>(
    `/v1/core/servers/${serverId}/preparations`,
    3_000,
  );
  const latestPreparation = preparations.data?.preparations[0];
  const latestPreparationId = latestPreparation?.id;
  const latestPreparationStatus = latestPreparation?.status;
  const [activePreparationId, setActivePreparationId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (
      detailNavigation.section === "preparation" &&
      (latestPreparationStatus === "queued" ||
        latestPreparationStatus === "running") &&
      latestPreparationId
    )
      setActivePreparationId(latestPreparationId);
  }, [detailNavigation.section, latestPreparationId, latestPreparationStatus]);
  const redirectingToOverview =
    detailNavigation.section === "preparation" &&
    activePreparationId === latestPreparationId &&
    hasScheduledPostSetupCheck(latestPreparation, checks.data?.latestCheck);
  useEffect(() => {
    if (!redirectingToOverview) return;
    const timer = window.setTimeout(
      () => router.replace(`/servers/${serverId}/overview`),
      5_000,
    );
    return () => window.clearTimeout(timer);
  }, [redirectingToOverview, router, serverId]);
  const refreshServer = server.refresh;
  useEffect(() => {
    if (
      latestPreparationStatus === "failed" ||
      latestPreparationStatus === "succeeded"
    ) {
      refreshServer();
    }
  }, [latestPreparationStatus, refreshServer]);
  const orphans = useApiQuery<{ orphans: OrphanItem[] }>(
    can("server.remove") ? `/v1/core/servers/${serverId}/orphans` : null,
    5_000,
  );
  const cleanup = useApiQuery<ServerCleanupPage>(
    requestedSettingsTab === "cleanup"
      ? `/v1/core/servers/${serverId}/cleanup`
      : null,
    5_000,
  );
  const error =
    server.error ??
    checks.error ??
    capacity.error ??
    keys.error ??
    credentials.error ??
    preparations.error ??
    orphans.error;
  if (error)
    return (
      <DashboardPage
        icon={ServerStack01Icon}
        breadcrumbAncestors={serversBreadcrumb}
        title="Server"
      >
        <QueryError message={error} />
      </DashboardPage>
    );
  if (
    !server.data ||
    !checks.data ||
    !capacity.data ||
    (can("server.credentials") && (!keys.data || !credentials.data)) ||
    !preparations.data ||
    (can("server.remove") && !orphans.data)
  )
    return <QueryLoading variant="detail" />;

  const item = server.data.server;
  const providerIcon = item.hardware?.instance ? (
    <CloudProviderLogo
      provider={item.hardware.instance.provider}
      className="size-6"
      size={24}
    />
  ) : undefined;
  const appCount = apps.data?.apps.filter(
    (app) => app.serverIp === item.canonicalIp && !app.archivedAt,
  ).length;
  const resourceCount = resources.data?.resources.filter(
    (resource) =>
      resource.serverIp === item.canonicalIp && !resource.archivedAt,
  ).length;
  const orphanItems = orphans.data?.orphans ?? [];
  const latestCheck = checks.data.latestCheck;
  const setupStatus = reconcileServerSetupStatus(
    item.setupStatus,
    latestPreparation?.status,
  );
  const credentialsPending =
    !credentials.data?.credential.keys.includes("privateKey") ||
    !keys.data?.hostKeys.length;
  const preparationProps = {
    credentialsPending,
    item,
    latestPreparation,
    serverId,
    setupStatus,
  };
  const preparationIndicator = serverPreparationIndicator(preparationProps);
  const operatingSystem = readCheckResult(latestCheck, "operatingSystem");
  const dockerVersion = readCheckResult(latestCheck, "dockerVersion");
  const checkColumns: ResourceTableColumn<ServerCheck>[] = [
    {
      key: "check",
      header: "Check ID",
      cell: (check) => (
        <TypographyCode title={check.id}>{check.id.slice(0, 8)}</TypographyCode>
      ),
      className: "min-w-36",
    },
    {
      key: "status",
      header: "Status",
      cell: (check) => (
        <StatusBadge
          status={check.status}
          tooltip={
            check.finishedAt
              ? `Server check ${check.status}. Finished ${formatDate(check.finishedAt)}.`
              : `Server check ${check.status} is still in progress.`
          }
        />
      ),
    },
    {
      key: "category",
      header: "Category",
      cell: (check) =>
        check.errorCode === "HOST_KEY_NOT_TRUSTED" ? (
          <InlineLink href={`/servers/${serverId}/settings/configuration`}>
            Configuration
          </InlineLink>
        ) : check.errorCode === "TEMPORAL_UNAVAILABLE" ? (
          "Control plane"
        ) : check.errorMessage ? (
          <InlineLink href={`/servers/${serverId}/settings/configuration`}>
            Configuration
          </InlineLink>
        ) : (
          "Environment"
        ),
      className: "min-w-40 whitespace-nowrap",
    },
    {
      key: "result",
      header: "Result",
      cell: (check) =>
        check.errorMessage ? (
          check.errorMessage
        ) : (
          <span className="whitespace-nowrap">
            {summarizeCheck(check.result)}
          </span>
        ),
      className: "w-full min-w-72",
    },
    {
      key: "duration",
      header: "Duration",
      cell: (check) => <ElapsedTime {...check} />,
    },
    {
      key: "finished",
      header: "Finished",
      cell: (check) =>
        check.finishedAt ? (
          <RelativeTime label="Finished" value={check.finishedAt} />
        ) : (
          "In progress"
        ),
      className: "whitespace-nowrap",
    },
  ];
  const orphanColumns: ResourceTableColumn<OrphanItem>[] = [
    {
      key: "object",
      header: "Pending objects for cleanup",
      cell: (orphan) => (
        <ResourceName description={orphan.reason} name={orphan.name} />
      ),
      className: "w-full min-w-72",
    },
    {
      key: "type",
      header: "Type",
      cell: (orphan) => <CleanupObjectType kind={orphan.kind} />,
    },
  ];

  return (
    <DashboardPage
      icon={ServerStack01Icon}
      actions={
        detailNavigation.section === "preparation" ? (
          <PrepareServerButton
            {...preparationProps}
            onQueued={setActivePreparationId}
          />
        ) : detailNavigation.section === "checks" &&
          can("server.credentials") ? (
          <ActionButton
            confirm={{
              title: "Check this server?",
              description:
                "Towbar will connect over SSH, inspect the server and its containers, and record a fresh check result.",
              actionLabel: "Check server",
            }}
            action={() =>
              api.post(`/v1/core/servers/${serverId}/actions/check`)
            }
            pendingLabel="Checking…"
            success="Server check queued"
            variant="primary"
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={ComputerActivityIcon}
              className="size-4 shrink-0"
            />
            Check server
          </ActionButton>
        ) : undefined
      }
      badge={
        (detailNavigation.section ?? "overview") === "overview" ? (
          <TooltipText
            className="inline-flex"
            tooltip={
              !item.archivedAt && setupStatus === "pending"
                ? "Server setup has not been completed yet."
                : undefined
            }
          >
            <StatusBadge status={item.archivedAt ? "archived" : setupStatus} />
          </TooltipText>
        ) : undefined
      }
      breadcrumbAncestors={serversBreadcrumb}
      breadcrumbSwitcher={{ id: serverId, kind: "servers" }}
      title={item.name ?? item.canonicalIp}
      titleIcon={providerIcon}
    >
      <div className="content-grid">
        <PageTabs
          aliases={{ "apps-resources": "apps" }}
          defaultValue="overview"
          tabs={[
            {
              value: "overview",
              label: "Overview",
              icon: <HugeiconsIcon icon={ServerStack01Icon} />,
              content: (
                <div className="content-grid">
                  <ServerPreparationOverview {...preparationProps} />
                  <ServerHostCapacity capacity={capacity.data.capacity} />
                  <div className="content-grid lg:grid-cols-2">
                    <Attributes columns={2} title="Connection" variant="card">
                      <Attributes.Item label="IP address">
                        {item.canonicalIp}
                      </Attributes.Item>
                      <Attributes.Item label="SSH host">
                        {item.config.ssh.host ?? item.canonicalIp}
                      </Attributes.Item>
                      {item.hardware?.instance ? (
                        <Attributes.Item
                          label={
                            item.hardware.instance.type
                              ? "Instance type"
                              : "Cloud provider"
                          }
                        >
                          <ServerHardwareDescription hardware={item.hardware} />
                        </Attributes.Item>
                      ) : null}
                      <Attributes.Item label="SSH user">
                        {item.config.ssh.username}
                      </Attributes.Item>
                      <Attributes.Item label="SSH port">
                        {item.config.ssh.port}
                      </Attributes.Item>
                      <Attributes.Item label="Updated">
                        {formatDate(item.updatedAt)}
                      </Attributes.Item>
                    </Attributes>
                    <Attributes columns={2} title="Operations" variant="card">
                      <Attributes.Item label="Server setup">
                        <StatusBadge status={setupStatus} />
                      </Attributes.Item>
                      <Attributes.Item label="Prepared">
                        {item.preparedAt
                          ? formatDate(item.preparedAt)
                          : "Not prepared"}
                      </Attributes.Item>
                      <Attributes.Item label="Latest check">
                        {latestCheck ? (
                          <StatusBadge status={latestCheck.status} />
                        ) : (
                          "Not checked"
                        )}
                      </Attributes.Item>
                      <Attributes.Item label="Last checked">
                        {latestCheck?.finishedAt
                          ? formatDate(latestCheck.finishedAt)
                          : "Not checked"}
                      </Attributes.Item>
                      <Attributes.Item label="Operating system">
                        {operatingSystem ?? "Unknown"}
                      </Attributes.Item>
                      <Attributes.Item label="Docker">
                        {dockerVersion ?? "Unknown"}
                      </Attributes.Item>
                      <Attributes.Item label="Concurrent builds">
                        {item.config.buildConcurrency ?? 1}
                      </Attributes.Item>
                      <Attributes.Item label="Concurrent preview builds">
                        {item.config.previewBuildConcurrency ?? 1}
                      </Attributes.Item>
                    </Attributes>
                  </div>
                </div>
              ),
            },
            {
              value: "preparation",
              label: "Server Setup",
              badge:
                preparationIndicator === "busy" ? (
                  <Spinner
                    color="current"
                    size="sm"
                    className="text-warning-soft-foreground"
                    aria-label="Server setup in progress"
                  />
                ) : preparationIndicator === "warning" ? (
                  <span
                    aria-label="Server setup required"
                    role="img"
                    className="inline-flex text-warning-soft-foreground [&_svg]:size-4"
                  >
                    <HugeiconsIcon aria-hidden="true" icon={Alert02Icon} />
                  </span>
                ) : undefined,
              icon: <HugeiconsIcon icon={Settings01Icon} />,
              content: (
                <ServerPreparationChecklist
                  {...preparationProps}
                  redirectingToOverview={redirectingToOverview}
                />
              ),
            },
            ...(can("server.terminal")
              ? [
                  {
                    value: "terminal",
                    label: "Terminal",
                    icon: <HugeiconsIcon icon={CommandLineIcon} />,
                    content: (
                      <ServerTerminal
                        serverId={serverId}
                        host={item.config.ssh.host ?? item.canonicalIp}
                        credentialsPending={credentialsPending}
                      />
                    ),
                  },
                ]
              : []),
            {
              value: "performance",
              label: "Performance",
              contentOwnsTitle: true,
              group: "Monitor",
              icon: <HugeiconsIcon icon={SquareActivityIcon} />,
              content: (
                <ScoutPerformance
                  path={`/v1/core/servers/${serverId}/metrics`}
                  serverId={serverId}
                />
              ),
            },
            {
              value: "alerts",
              label: "Alerts",
              contentOwnsTitle: true,
              group: "Monitor",
              icon: <HugeiconsIcon icon={Alert02Icon} />,
              content: <ScoutAlertRules serverId={serverId} />,
            },
            {
              value: "incidents",
              label: "Incidents",
              contentOwnsTitle: true,
              group: "Monitor",
              icon: <HugeiconsIcon icon={AlertCircleIcon} />,
              content: <ScoutIncidents serverId={serverId} />,
            },
            {
              value: "services",
              label: "Services",
              badge:
                appCount !== undefined ? (
                  <span className="text-muted">{appCount}</span>
                ) : undefined,
              icon: <HugeiconsIcon icon={DashboardCircleIcon} />,
              content: (
                <ServerDeployableTable
                  capacity={capacity.data.capacity}
                  kind="app"
                />
              ),
            },
            {
              value: "datastores",
              label: "Datastores",
              badge:
                resourceCount !== undefined ? (
                  <span className="text-muted">{resourceCount}</span>
                ) : undefined,
              icon: <HugeiconsIcon icon={DatabaseIcon} />,
              content: (
                <ServerDeployableTable
                  capacity={capacity.data.capacity}
                  kind="resource"
                />
              ),
            },
            {
              value: "checks",
              label: "Checks",
              icon: <HugeiconsIcon icon={Activity01Icon} />,
              content: (
                <ServerCheckHistory
                  columns={checkColumns}
                  firstPage={checks.data}
                  serverId={serverId}
                  serverIp={item.canonicalIp}
                />
              ),
            },
            {
              value: "settings",
              label: "Settings",
              icon: <HugeiconsIcon icon={Settings01Icon} />,
              indicator: orphanItems.length
                ? { label: String(orphanItems.length), variant: "warning" }
                : undefined,
              content: (
                <ResponsiveSubtabs
                  ariaLabel="Server settings"
                  defaultSelectedKey={requestedSettingsTab}
                  key={requestedSettingsTab}
                  tabs={[
                    {
                      value: "configuration",
                      label: "Configuration",
                      badge: credentialsPending ? (
                        <span
                          aria-label="Configuration requires attention"
                          className="inline-flex text-warning-soft-foreground [&_svg]:size-4"
                          role="img"
                        >
                          <HugeiconsIcon
                            aria-hidden="true"
                            icon={Alert02Icon}
                          />
                        </span>
                      ) : undefined,
                      content: (
                        <ServerEditor
                          canManage={server.data.canManageServer}
                          server={item}
                        />
                      ),
                    },
                    {
                      value: "logs-collection",
                      label: "OTEL Logs Collector",
                      badge:
                        collector.data?.status === "collecting" ? (
                          <span
                            role="img"
                            aria-label="OTEL Logs Collector connected"
                            title="OTEL Logs Collector connected"
                            className="block size-1.5 rounded-full bg-success-soft-foreground"
                          />
                        ) : undefined,
                      icon: (
                        <Image
                          alt=""
                          src="/resource-logos/opentelemetry.svg"
                          width={24}
                          height={24}
                          className="size-6 shrink-0 object-contain"
                        />
                      ),
                      content: (
                        <LogCollectorSettings
                          serverId={serverId}
                          canManage={can("server.collectLogs")}
                          ready={setupStatus === "ready"}
                        />
                      ),
                    },
                    {
                      value: "monitoring",
                      label: "Scout Agent",
                      badge:
                        monitoring.data?.agent.desiredState === "enabled" ? (
                          <span
                            role="img"
                            aria-label="Scout Agent enabled"
                            title="Scout Agent enabled"
                            className="block size-1.5 rounded-full bg-success-soft-foreground"
                          />
                        ) : undefined,
                      icon: <ScoutMascot size={24} variant="icon" />,
                      content: (
                        <div className="content-grid">
                          <MonitoringAgentSettings
                            serverId={serverId}
                            canManage={can("scout.configure")}
                            ready={setupStatus === "ready"}
                          />
                        </div>
                      ),
                    },
                    {
                      value: "cleanup",
                      label: "Docker cleanup",
                      badge: cleanup.data?.inProgress ? (
                        <Spinner
                          color="current"
                          size="sm"
                          className="text-warning-soft-foreground"
                          aria-label="Docker cleanup in progress"
                        />
                      ) : undefined,
                      titleBadge: cleanup.data?.inProgress ? (
                        <Chip size="sm" color="warning">
                          <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                            <Spinner
                              aria-hidden="true"
                              color="current"
                              size="sm"
                              className="size-3.5"
                            />
                            In progress
                          </Chip.Label>
                        </Chip>
                      ) : undefined,
                      actions: server.data.canCleanupOrphans ? (
                        <CleanupButton
                          onQueued={cleanup.refresh}
                          serverId={serverId}
                        />
                      ) : undefined,
                      content: (
                        <div className="content-grid">
                          <ResourceTable
                            ariaLabel={`Unused Docker objects on ${item.canonicalIp}`}
                            columns={orphanColumns}
                            emptyDescription="The latest server check found no unused Docker containers, images, or volumes. Request Cleanup also retires removed workloads’ routes and configuration; these are not listed here."
                            emptyTitle="No unused Docker objects"
                            getRowKey={(orphan) =>
                              `${orphan.kind}:${orphan.name}`
                            }
                            items={orphanItems}
                          />
                          {cleanup.error ? (
                            <QueryError message={cleanup.error} />
                          ) : cleanup.data ? (
                            <ServerCleanupHistory
                              firstPage={cleanup.data}
                              serverId={serverId}
                            />
                          ) : (
                            <QueryLoading />
                          )}
                        </div>
                      ),
                    },
                    ...(server.data.canRemoveServer
                      ? [
                          {
                            value: "danger",
                            label: "Remove server",
                            destructive: true,
                            group: "Danger zone",
                            icon: <HugeiconsIcon icon={ServerOffIcon} />,
                            content: (
                              <FormCard help={false} title="Danger zone">
                                <div className="content-grid">
                                  <p className="max-w-3xl text-sm text-muted">
                                    Remove this server and forget its stored
                                    credentials and trusted host keys. Towbar
                                    will attempt to remove existing app
                                    containers when the server is added and
                                    prepared again. A later Repository sync
                                    restores the server automatically when a
                                    manifest still references its IP address.
                                  </p>
                                  <ActionButton
                                    action={() =>
                                      api.delete(`/v1/core/servers/${serverId}`)
                                    }
                                    confirm={{
                                      actionLabel: "Remove server",
                                      description:
                                        "Towbar will stop managing this server and forget its stored credentials and trusted host keys. Existing inventory is archived. Running services and data may remain on the machine. If a manifest still uses this IP address, the next Repository sync restores the server in Server Setup Pending and preparation attempts to remove its existing app containers.",
                                      title: `Remove ${item.canonicalIp} from Towbar?`,
                                    }}
                                    onSuccess={() => router.push("/servers")}
                                    pendingLabel="Removing…"
                                    success="Server removal requested"
                                    variant="danger"
                                  >
                                    <HugeiconsIcon
                                      aria-hidden="true"
                                      icon={Delete02Icon}
                                      className="size-4 shrink-0"
                                    />
                                    Remove server
                                  </ActionButton>
                                </div>
                              </FormCard>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              ),
            },
          ]}
        />
      </div>
    </DashboardPage>
  );
}

function ServerCheckHistory({
  columns,
  firstPage,
  serverId,
  serverIp,
}: {
  columns: ResourceTableColumn<ServerCheck>[];
  firstPage: ServerChecksPage;
  serverId: string;
  serverIp: string;
}) {
  const pagination = useTablePagination({
    pageSize: firstPage.pagination.limit,
    total: firstPage.pagination.total,
  });
  const requestedPage = useApiQuery<ServerChecksPage>(
    pagination.page === 1
      ? null
      : `/v1/core/servers/${serverId}/checks?page=${pagination.page}&limit=${pagination.pageSize}`,
    5_000,
  );
  const page = pagination.page === 1 ? firstPage : requestedPage.data;

  return (
    <div className="grid gap-4">
      {requestedPage.error ? (
        <QueryError message={requestedPage.error} />
      ) : page ? (
        <ResourceTable
          ariaLabel={`${serverIp} checks`}
          columns={columns}
          emptyDescription="Run a server check to validate SSH, Docker, and the host environment."
          emptyTitle="No checks yet"
          getRowKey={(check) => check.id}
          items={page.checks}
          tableClassName="min-w-[1040px]"
        />
      ) : (
        <QueryLoading />
      )}
      {firstPage.pagination.total > pagination.pageSize ? (
        <Pagination
          aria-label={`${serverIp} check history pages`}
          page={pagination.page}
          size="sm"
          totalPages={pagination.totalPages ?? 1}
          onPageChange={pagination.setPage}
        />
      ) : null}
    </div>
  );
}

function CleanupButton({
  onQueued,
  serverId,
}: {
  onQueued: () => void;
  serverId: string;
}) {
  return (
    <ActionButton<{ operation: ResourceOperation }>
      action={() =>
        api.post<{ operation: ResourceOperation }>(
          `/v1/core/servers/${serverId}/actions/cleanup-orphans`,
          {},
          { "Idempotency-Key": crypto.randomUUID() },
        )
      }
      confirm={{
        actionLabel: "Request Cleanup",
        title: "Request server cleanup?",
        description:
          "Remove unused Towbar objects and retired workloads on this server, including their owned persistent volumes and data. Current workloads, rollback artifacts and shared resources still in use are preserved.",
      }}
      onSuccess={onQueued}
      success="Server cleanup requested"
      variant="danger"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={CleanIcon}
        className="size-4 shrink-0"
      />
      Request Cleanup
    </ActionButton>
  );
}

function summarizeCheck(result: Record<string, unknown> | null) {
  if (!result) return "Waiting for the worker";
  const os =
    typeof result.operatingSystem === "string"
      ? result.operatingSystem
      : "Server reachable";
  const docker =
    typeof result.dockerVersion === "string"
      ? ` · Docker ${result.dockerVersion}`
      : "";
  return `${os}${docker}`;
}

function readCheckResult(
  check: ServerCheck | null | undefined,
  key: "dockerVersion" | "operatingSystem",
) {
  const value = check?.result?.[key];
  return typeof value === "string" ? value : null;
}
