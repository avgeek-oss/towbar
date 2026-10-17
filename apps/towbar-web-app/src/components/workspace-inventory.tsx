"use client";
import { useAccess } from "./access-context";
import {
  InventorySidebar,
  inventoryFilterKeys,
  useInventoryQuery,
  type InventoryCounts,
} from "./inventory-sidebar";
import {
  Add01Icon,
  CloudIcon,
  DashboardCircleIcon,
  DatabaseIcon,
  ServerStack01Icon,
  Layers01Icon,
  LeftToRightListBulletIcon,
  FilterResetIcon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";

import {
  Tooltip,
  TooltipText,
} from "@avgeek-oss/design-system/overlays/tooltip";

import { HugeiconsIcon } from "@hugeicons/react";
import type {
  App,
  Deployment,
  Resource,
  Server,
  Source,
} from "@workspace/towbar-web-client";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { Button, ButtonLink } from "@avgeek-oss/design-system/buttons/button";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@avgeek-oss/design-system/buttons/toggle-button";

import { DashboardPage } from "@/components/page-parts";
import { useApiQuery } from "@/hooks/use-api-query";
import { usePageQuery, useQueryChoice } from "@/hooks/use-page-query";
import {
  getActiveDeploymentStates,
  resolveInventoryStatus,
} from "@/lib/inventory-status";
import {
  DefinedCpuCapacity,
  DefinedMemoryCapacity,
  ServerCapacityCell,
} from "./server-capacity";
import {
  InventoryRuntimeCapacity,
  useInventoryRuntimeCapacity,
  useInventoryServerCapacity,
} from "./inventory-runtime-capacity";
import { formatBytes } from "./runtime-operations";
import { LastSyncedTime, RelativeTime } from "./last-synced-time";
import { ScoutServerSummary } from "./scout-server-summary";
import { InstanceEnvironmentLabel } from "./instance-environment-label";
import { ServerIpLink } from "./source-inventory";
import { DeployableInventoryTable as GroupedDeployableTable } from "./deployable-inventory-table";
import { AppIdentity, ResourceIdentity } from "./deployable-identity";
import { ServiceType } from "./service-type";

const inventoryLayouts = [
  "grouped",
  "environment",
  "server",
  "unified",
] as const;

function isApp(item: App | Resource): item is App {
  return item.kind === "app" || item.kind === "compose";
}

function useInventoryLayout() {
  return useQueryChoice("layout", inventoryLayouts, "server");
}

function InventoryViewToggle({ kind }: { kind: "Services" | "Datastores" }) {
  const [layout, setLayout] = useInventoryLayout();
  return (
    <ToggleButtonGroup
      aria-label={`${kind} view`}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[layout]}
      onSelectionChange={(keys) => {
        const selected = inventoryLayouts.find((choice) => keys.has(choice));
        if (selected) setLayout(selected);
      }}
    >
      <Tooltip>
        <ToggleButton id="grouped" isIconOnly aria-label="Group by ID">
          <HugeiconsIcon icon={Layers01Icon} aria-hidden="true" />
        </ToggleButton>
        <Tooltip.Content>Group by ID</Tooltip.Content>
      </Tooltip>
      <Tooltip>
        <ToggleButton
          id="environment"
          isIconOnly
          aria-label="Group by environment"
        >
          <HugeiconsIcon icon={CloudIcon} aria-hidden="true" />
        </ToggleButton>
        <Tooltip.Content>Group by environment</Tooltip.Content>
      </Tooltip>
      <Tooltip>
        <ToggleButton id="server" isIconOnly aria-label="Group by server">
          <HugeiconsIcon icon={ServerStack01Icon} aria-hidden="true" />
        </ToggleButton>
        <Tooltip.Content>Group by server</Tooltip.Content>
      </Tooltip>
      <Tooltip>
        <ToggleButton id="unified" isIconOnly aria-label="Unified view">
          <HugeiconsIcon icon={LeftToRightListBulletIcon} aria-hidden="true" />
        </ToggleButton>
        <Tooltip.Content>Unified view</Tooltip.Content>
      </Tooltip>
    </ToggleButtonGroup>
  );
}

export function AppsIndex() {
  const apps = useApiQuery<{
    apps: App[];
    counts: InventoryCounts;
    environments: string[];
  }>(useInventoryQuery("apps"), 5_000);
  const deployments = useApiQuery<{ deployments: Deployment[] }>(
    "/v1/core/deployments",
    5_000,
  );
  const sources = useApiQuery<{ sources: Source[] }>("/v1/core/sources");
  const servers = useApiQuery<{ servers: Server[] }>("/v1/core/servers");
  const error =
    apps.error ?? deployments.error ?? sources.error ?? servers.error;

  return (
    <DashboardPage
      icon={DashboardCircleIcon}
      title="Services"
      actions={<InventoryViewToggle kind="Services" />}
    >
      <InventorySidebar
        kind="apps"
        counts={apps.data?.counts}
        environments={apps.data?.environments}
        sources={sources.data?.sources}
        servers={servers.data?.servers}
      />
      {error ? (
        <QueryError message={error} />
      ) : !apps.data || !deployments.data || !sources.data || !servers.data ? (
        <QueryLoading variant="table" />
      ) : (
        <DeployableInventory
          deployments={deployments.data.deployments}
          items={apps.data.apps}
          kind="app"
          servers={servers.data.servers}
        />
      )}
    </DashboardPage>
  );
}

export function ResourcesIndex() {
  const deployments = useApiQuery<{ deployments: Deployment[] }>(
    "/v1/core/deployments",
    5_000,
  );
  const resources = useApiQuery<{
    resources: Resource[];
    counts: InventoryCounts;
    environments: string[];
  }>(useInventoryQuery("resources"), 5_000);
  const sources = useApiQuery<{ sources: Source[] }>("/v1/core/sources");
  const servers = useApiQuery<{ servers: Server[] }>("/v1/core/servers");
  const error =
    deployments.error ?? resources.error ?? sources.error ?? servers.error;

  return (
    <DashboardPage
      icon={DatabaseIcon}
      title="Datastores"
      actions={<InventoryViewToggle kind="Datastores" />}
    >
      <InventorySidebar
        kind="resources"
        counts={resources.data?.counts}
        environments={resources.data?.environments}
        sources={sources.data?.sources}
        servers={servers.data?.servers}
      />
      {error ? (
        <QueryError message={error} />
      ) : !deployments.data ||
        !resources.data ||
        !sources.data ||
        !servers.data ? (
        <QueryLoading variant="table" />
      ) : (
        <DeployableInventory
          deployments={deployments.data.deployments}
          items={resources.data.resources}
          kind="resource"
          servers={servers.data.servers}
        />
      )}
    </DashboardPage>
  );
}

export function ServersIndex() {
  const { can } = useAccess();
  const apps = useApiQuery<{ apps: App[] }>("/v1/core/apps", 5_000);
  const resources = useApiQuery<{ resources: Resource[] }>(
    "/v1/core/resources",
    5_000,
  );
  const servers = useApiQuery<{ servers: Server[]; counts: InventoryCounts }>(
    useInventoryQuery("servers"),
    30_000,
  );
  const error = apps.error ?? resources.error ?? servers.error;

  return (
    <DashboardPage
      icon={ServerStack01Icon}
      actions={
        can("server.update") ? (
          <ButtonLink href="/servers/new">
            <HugeiconsIcon
              aria-hidden="true"
              icon={Add01Icon}
              className="size-4 shrink-0"
            />
            Add server
          </ButtonLink>
        ) : undefined
      }
      title="Servers"
    >
      <InventorySidebar kind="servers" counts={servers.data?.counts} />
      {error ? (
        <QueryError message={error} />
      ) : !apps.data || !resources.data || !servers.data ? (
        <QueryLoading variant="table" />
      ) : (
        <InventoryRuntimeCapacity
          serverIds={servers.data.servers.map((server) => server.id)}
        >
          <ServerInventory
            apps={apps.data.apps}
            resources={resources.data.resources}
            servers={servers.data.servers}
          />
        </InventoryRuntimeCapacity>
      )}
    </DashboardPage>
  );
}

function DeployableInventory(props: DeployableInventoryProps) {
  const serverIps = new Set(props.items.map((item) => item.serverIp));
  const serverIds = props.servers
    .filter((server) => serverIps.has(server.canonicalIp))
    .map((server) => server.id);
  return (
    <InventoryRuntimeCapacity serverIds={serverIds}>
      <DeployableInventoryTable {...props} />
    </InventoryRuntimeCapacity>
  );
}

type DeployableInventoryProps = {
  deployments: Deployment[];
  items: App[] | Resource[];
  kind: "app" | "resource";
  servers: Server[];
};

function DeployableInventoryTable({
  deployments,
  items,
  kind,
  servers,
}: DeployableInventoryProps) {
  const [layout] = useInventoryLayout();
  const { update } = usePageQuery();
  const inventoryKind = kind === "app" ? "apps" : "resources";
  const filtered = useInventoryQuery(inventoryKind).includes("?");
  const runtimeById = useInventoryRuntimeCapacity();
  const activeDeploymentStates = getActiveDeploymentStates(deployments);
  const serversByIp = new Map(
    servers.map((server) => [server.canonicalIp, server]),
  );
  const columns: ResourceTableColumn<App | Resource>[] = [
    {
      cell: (item) =>
        isApp(item) ? (
          <AppIdentity app={item} runtime={runtimeById.get(item.id)} />
        ) : (
          <ResourceIdentity
            resource={item}
            runtime={runtimeById.get(item.id)}
          />
        ),
      className:
        kind === "resource"
          ? "resource-identity-cell w-full min-w-80 2xl:min-w-[22rem]"
          : "w-full min-w-80",
      wrapRowLink: false,
      header: kind === "app" ? "Service" : "Datastore",
      key: "name",
    },
    {
      cell: (item) => (
        <StatusBadge
          status={resolveInventoryStatus({
            activeDeploymentState: activeDeploymentStates.get(item.id),
            archived: Boolean(item.archivedAt),
            healthStatus: item.runtimeState.healthStatus,
            hasDeployment: deployments.some(
              (deployment) => deployment.appId === item.id,
            ),
            serverReady: item.serverReady,
          })}
        />
      ),
      className: "w-32",
      header: "Status",
      key: "status",
    },
    ...(kind === "app"
      ? [
          {
            cell: (item: App | Resource) =>
              isApp(item) ? <ServiceType app={item} /> : null,
            className: "min-w-36 whitespace-nowrap",
            header: "Type",
            key: "type",
          },
        ]
      : []),
    {
      cell: (item) => (
        <InstanceEnvironmentLabel environment={item.environment} />
      ),
      className: "min-w-32",
      header: "Environment",
      key: "environment",
    },
    {
      cell: (item) => (
        <ServerIpLink
          ip={item.serverIp}
          showIp
          name={serversByIp.get(item.serverIp)?.name}
          serverId={serversByIp.get(item.serverIp)?.id}
          hardware={serversByIp.get(item.serverIp)?.hardware}
        />
      ),
      className: "min-w-52 tabular-nums",
      header: "Server",
      key: "server",
    },
    {
      cell: (item) => (
        <DefinedCpuCapacity
          limits={item.config.container.resources}
          runtime={runtimeById.get(item.id)}
        />
      ),
      className: "min-w-44 whitespace-nowrap",
      header: "CPU cap",
      key: "defined-cpu",
    },
    {
      cell: (item) => (
        <DefinedMemoryCapacity
          limits={item.config.container.resources}
          runtime={runtimeById.get(item.id)}
        />
      ),
      className: "min-w-44 whitespace-nowrap",
      header: "Memory cap",
      key: "defined-memory",
    },
    {
      cell: (item) => <LastSyncedTime value={item.updatedAt} />,
      className: "min-w-48 whitespace-nowrap",
      header: "Last synced",
      key: "last-synced",
    },
  ];

  const InventoryTable =
    layout === "unified" ? ResourceTable : GroupedDeployableTable;
  return (
    <InventoryTable
      groupBy={
        layout === "environment" || layout === "server" ? layout : "manifest"
      }
      servers={servers}
      ariaLabel={kind === "app" ? "Services" : "Datastores"}
      columns={columns}
      emptyMedia={
        <HugeiconsIcon
          aria-hidden="true"
          icon={kind === "app" ? DashboardCircleIcon : DatabaseIcon}
          className="size-8"
        />
      }
      emptyAction={
        filtered ? (
          <Button
            variant="secondary"
            onPress={() =>
              update(
                Object.fromEntries(
                  inventoryFilterKeys[inventoryKind].map((key) => [key, null]),
                ),
              )
            }
          >
            <HugeiconsIcon aria-hidden="true" icon={FilterResetIcon} />
            Clear filters
          </Button>
        ) : (
          <ButtonLink href="/repositories" variant="secondary">
            <HugeiconsIcon aria-hidden="true" icon={GitBranchIcon} />
            View repositories
          </ButtonLink>
        )
      }
      emptyDescription={
        filtered
          ? "Try changing or clearing the filters."
          : kind === "app"
            ? "Add a service to a repository's Towbar manifest, then sync it."
            : "Add a datastore to a repository's Towbar manifest, then sync it."
      }
      emptyTitle={
        filtered
          ? kind === "app"
            ? "No matching services"
            : "No matching datastores"
          : kind === "app"
            ? "No services yet"
            : "No datastores yet"
      }
      getRowHref={(item) =>
        `/${kind === "app" ? "services" : "datastores"}/${item.id}`
      }
      getRowKey={(item) => item.id}
      items={items}
      tableClassName="min-w-[680px]"
    />
  );
}

function ServerInventory({
  apps,
  resources,
  servers,
}: {
  apps: App[];
  resources: Resource[];
  servers: Server[];
}) {
  const filtered = useInventoryQuery("servers").includes("?");
  const appCounts = countBy(apps, (app) => app.serverIp);
  const resourceCounts = countBy(resources, (resource) => resource.serverIp);
  const capacityByServer = useInventoryServerCapacity();
  const columns: ResourceTableColumn<Server>[] = [
    {
      cell: (server) => (
        <ServerIpLink
          ip={server.canonicalIp}
          name={server.name}
          description={
            server.setupStatus === "pending" ? "Pending Setup" : undefined
          }
          hardware={server.hardware}
        />
      ),
      className: "w-full min-w-52",
      header: "Server",
      key: "server",
    },
    {
      cell: (server) => (
        <TypographyCode className="whitespace-nowrap">
          {server.canonicalIp}
        </TypographyCode>
      ),
      className: "min-w-40",
      header: "IP",
      key: "ip",
    },
    {
      cell: (server) => (
        <StatusBadge
          status={server.archivedAt ? "archived" : server.setupStatus}
        />
      ),
      className: "w-32 whitespace-nowrap",
      header: "Status",
      key: "status",
    },
    {
      cell: (server) => <ScoutServerSummary server={server} />,
      className: "min-w-40",
      header: "Scout Agent (30m)",
      key: "scout",
    },
    {
      cell: (server) => (
        <ServerCapacityCell
          label={`${server.name ?? server.canonicalIp} CPU used`}
          value={
            server.hardware?.cpuCount
              ? `${server.hardware.cpuCount} vCPU`
              : null
          }
          usedPercent={capacityByServer.get(server.id)?.cpu?.usagePercent}
          checkedAt={capacityByServer.get(server.id)?.checkedAt}
        />
      ),
      className: "min-w-44 whitespace-nowrap tabular-nums",
      header: "CPU capacity",
      key: "max-cpu",
    },
    {
      cell: (server) => (
        <ServerCapacityCell
          label={`${server.name ?? server.canonicalIp} memory used`}
          value={
            server.hardware?.memoryBytes
              ? formatBytes(server.hardware.memoryBytes)
              : null
          }
          usedPercent={capacityByServer.get(server.id)?.memory?.usedPercent}
          checkedAt={capacityByServer.get(server.id)?.checkedAt}
        />
      ),
      className: "min-w-44 whitespace-nowrap tabular-nums",
      header: "Memory capacity",
      key: "max-memory",
    },
    {
      cell: (server) => {
        const appCount = appCounts.get(server.canonicalIp) ?? 0;
        const resourceCount = resourceCounts.get(server.canonicalIp) ?? 0;
        return (
          <span className="inline-flex items-center gap-5 whitespace-nowrap">
            <TooltipText
              aria-label={formatCount(appCount, "service")}
              className="inline-flex items-center gap-1.5"
              tooltip={formatCount(appCount, "service")}
            >
              <HugeiconsIcon
                aria-hidden="true"
                className="text-muted-foreground size-4"
                icon={DashboardCircleIcon}
              />
              <span className="tabular-nums">{appCount}</span>
            </TooltipText>
            <TooltipText
              aria-label={formatCount(resourceCount, "datastore")}
              className="inline-flex items-center gap-1.5"
              tooltip={formatCount(resourceCount, "datastore")}
            >
              <HugeiconsIcon
                aria-hidden="true"
                className="text-muted-foreground size-4"
                icon={DatabaseIcon}
              />
              <span className="tabular-nums">{resourceCount}</span>
            </TooltipText>
          </span>
        );
      },
      className: "min-w-36",
      header: "Workloads",
      key: "workloads",
    },
    {
      cell: (server) => (
        <RelativeTime label="Updated" value={server.updatedAt} />
      ),
      className: "min-w-48 whitespace-nowrap",
      header: "Updated",
      key: "updated",
    },
  ];

  return (
    <ResourceTable
      ariaLabel="Servers"
      columns={columns}
      emptyDescription={
        filtered
          ? "Try changing or clearing the filters."
          : "Add a server before syncing a Repository that targets its IP address."
      }
      emptyTitle={filtered ? "No matching servers" : "No servers yet"}
      getRowHref={(server) => `/servers/${server.id}`}
      getRowKey={(server) => server.id}
      items={servers}
      tableClassName="min-w-[680px] 2xl:min-w-[1120px]"
    />
  );
}

function countBy<T>(items: T[], getKey: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatCount(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
