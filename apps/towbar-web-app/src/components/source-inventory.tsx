"use client";

import {
  TableCellStack,
  TableCellDescription,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  App,
  Deployment,
  DeploymentState,
  Resource,
  RuntimeCapacity,
  Server,
} from "@workspace/towbar-web-client";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { type ResourceTableColumn } from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { DeployableInventoryTable } from "./deployable-inventory-table";
import { AppIdentity, ResourceIdentity } from "./deployable-identity";
import { InstanceEnvironmentLabel } from "./instance-environment-label";
import { ServerHardwareDescription } from "./server-hardware";
import { serviceTypeLabel } from "./service-type";
import { InlineLink } from "@/components/page-parts";
import {
  getActiveDeploymentStates,
  resolveInventoryStatus,
} from "@/lib/inventory-status";
import { LastSyncedTime } from "./last-synced-time";
import {
  DefinedCpuCapacity,
  DefinedMemoryCapacity,
  type RuntimeMetric,
} from "./server-capacity";

function appColumns(
  activeDeploymentStates: Map<string, DeploymentState>,
  deployments: Deployment[],
  runtimeById: Map<string, RuntimeMetric>,
  serversByIp: Map<string, Server>,
): ResourceTableColumn<App>[] {
  return [
    {
      cell: (app) => <AppIdentity app={app} />,
      wrapRowLink: false,
      className: "min-w-64",
      header: "Service",
      key: "name",
    },
    {
      cell: (app) => (
        <StatusBadge
          status={resolveInventoryStatus({
            activeDeploymentState: activeDeploymentStates.get(app.id),
            archived: Boolean(app.archivedAt),
            healthStatus: app.runtimeState.healthStatus,
            hasDeployment: deployments.some(
              (deployment) => deployment.appId === app.id,
            ),
            serverReady: app.serverReady,
          })}
        />
      ),
      className: "w-32",
      header: "Status",
      key: "status",
    },
    {
      cell: (app) => serviceTypeLabel(app),
      className: "min-w-28 whitespace-nowrap",
      header: "Type",
      key: "type",
    },
    {
      cell: (app) => <InstanceEnvironmentLabel environment={app.environment} />,
      className: "min-w-32",
      header: "Environment",
      key: "environment",
    },
    {
      cell: (app) => (
        <ServerIpLink
          ip={app.serverIp}
          name={serversByIp.get(app.serverIp)?.name}
          serverId={serversByIp.get(app.serverIp)?.id}
          hardware={serversByIp.get(app.serverIp)?.hardware}
        />
      ),
      className: "min-w-52 tabular-nums",
      header: "Server",
      key: "server",
    },
    {
      cell: (app) => (
        <DefinedCpuCapacity
          limits={app.config.container.resources}
          runtime={runtimeById.get(app.id)}
        />
      ),
      className: "min-w-44",
      header: "Allocated CPU",
      key: "cpu",
    },
    {
      cell: (app) => (
        <DefinedMemoryCapacity
          limits={app.config.container.resources}
          runtime={runtimeById.get(app.id)}
        />
      ),
      className: "min-w-44",
      header: "Allocated Memory",
      key: "memory",
    },
    {
      cell: (app) => <LastSyncedTime value={app.updatedAt} />,
      className: "min-w-48 whitespace-nowrap",
      header: "Last synced",
      key: "last-synced",
    },
  ];
}

function resourceColumns(
  activeDeploymentStates: Map<string, DeploymentState>,
  deployments: Deployment[],
  runtimeById: Map<string, RuntimeMetric>,
  serversByIp: Map<string, Server>,
): ResourceTableColumn<Resource>[] {
  return [
    {
      cell: (resource) => <ResourceIdentity resource={resource} />,
      className: "resource-identity-cell min-w-64 2xl:min-w-[22rem]",
      wrapRowLink: false,
      header: "Datastore",
      key: "name",
    },
    {
      cell: (resource) => (
        <StatusBadge
          status={resolveInventoryStatus({
            activeDeploymentState: activeDeploymentStates.get(resource.id),
            archived: Boolean(resource.archivedAt),
            healthStatus: resource.runtimeState.healthStatus,
            hasDeployment: deployments.some(
              (deployment) => deployment.appId === resource.id,
            ),
            serverReady: resource.serverReady,
          })}
        />
      ),
      className: "w-32",
      header: "Status",
      key: "status",
    },
    {
      cell: (resource) => (
        <InstanceEnvironmentLabel environment={resource.environment} />
      ),
      className: "min-w-32",
      header: "Environment",
      key: "environment",
    },
    {
      cell: (resource) => (
        <ServerIpLink
          ip={resource.serverIp}
          name={serversByIp.get(resource.serverIp)?.name}
          serverId={serversByIp.get(resource.serverIp)?.id}
          hardware={serversByIp.get(resource.serverIp)?.hardware}
        />
      ),
      className: "min-w-52 tabular-nums",
      header: "Server",
      key: "server",
    },
    {
      cell: (resource) => (
        <DefinedCpuCapacity
          limits={resource.config.container.resources}
          runtime={runtimeById.get(resource.id)}
        />
      ),
      className: "min-w-44",
      header: "Allocated CPU",
      key: "cpu",
    },
    {
      cell: (resource) => (
        <DefinedMemoryCapacity
          limits={resource.config.container.resources}
          runtime={runtimeById.get(resource.id)}
        />
      ),
      className: "min-w-44",
      header: "Allocated Memory",
      key: "memory",
    },
    {
      cell: (resource) => <LastSyncedTime value={resource.updatedAt} />,
      className: "min-w-48 whitespace-nowrap",
      header: "Last synced",
      key: "last-synced",
    },
  ];
}

export function SourceApps({
  apps,
  capacities,
  deployments,
  error,
  servers,
}: {
  apps?: App[];
  capacities?: RuntimeCapacity[];
  deployments?: Deployment[];
  error?: string;
  servers?: Server[];
}) {
  if (error) return <QueryError message={error} />;
  if (!apps || !capacities || !deployments || !servers)
    return <QueryLoading variant="list" />;
  const activeDeploymentStates = getActiveDeploymentStates(deployments);
  const runtimeById = getRuntimeByDeployableId(capacities);
  const serversByIp = getServersByIp(servers);
  return (
    <DeployableInventoryTable
      ariaLabel="Repository services"
      columns={appColumns(
        activeDeploymentStates,
        deployments,
        runtimeById,
        serversByIp,
      )}
      emptyDescription="A successful manifest sync imports this Repository's services."
      emptyTitle="No services in this Repository"
      getRowHref={(app) => `/services/${app.id}`}
      getRowKey={(app) => app.id}
      items={apps}
      tableClassName="min-w-[640px] 2xl:min-w-[1040px]"
    />
  );
}

export function SourceResources({
  capacities,
  deployments,
  error,
  resources,
  servers,
}: {
  capacities?: RuntimeCapacity[];
  deployments?: Deployment[];
  error?: string;
  resources?: Resource[];
  servers?: Server[];
}) {
  if (error) return <QueryError message={error} />;
  if (!resources || !capacities || !deployments || !servers)
    return <QueryLoading variant="list" />;
  const activeDeploymentStates = getActiveDeploymentStates(deployments);
  const runtimeById = getRuntimeByDeployableId(capacities);
  const serversByIp = getServersByIp(servers);
  return (
    <DeployableInventoryTable
      ariaLabel="Repository datastores"
      columns={resourceColumns(
        activeDeploymentStates,
        deployments,
        runtimeById,
        serversByIp,
      )}
      emptyDescription="Declare a supported database or cache in this Repository's manifest."
      emptyTitle="No datastores in this Repository"
      getRowHref={(resource) => `/datastores/${resource.id}`}
      getRowKey={(resource) => resource.id}
      items={resources}
      tableClassName="min-w-[640px] 2xl:min-w-[1160px]"
    />
  );
}

export function ServerIpLink({
  ip,
  name,
  description,
  hardware,
  serverId,
}: {
  ip: string;
  name?: string | null;
  description?: string;
  hardware?: Server["hardware"];
  serverId?: string;
}) {
  const label = (
    <TableCellStack>
      <span className="inline-flex items-center gap-2 whitespace-nowrap tabular-nums">
        <HugeiconsIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted"
          icon={ServerStack01Icon}
        />
        <span>{name ?? ip}</span>
      </span>
      <TableCellDescription>
        {description ?? <ServerHardwareDescription hardware={hardware} />}
      </TableCellDescription>
    </TableCellStack>
  );
  return serverId ? (
    <InlineLink href={`/servers/${serverId}`}>{label}</InlineLink>
  ) : (
    label
  );
}

function getRuntimeByDeployableId(capacities: RuntimeCapacity[]) {
  return new Map(
    capacities.flatMap((capacity) =>
      capacity.runtimes.map((runtime) => [runtime.id, runtime] as const),
    ),
  );
}

function getServersByIp(servers: Server[]) {
  return new Map(servers.map((server) => [server.canonicalIp, server]));
}
