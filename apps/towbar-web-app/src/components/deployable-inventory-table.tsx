"use client";

import {
  DatabaseIcon,
  DashboardCircleIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { App, Resource, Server } from "@workspace/towbar-web-client";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  groupDeployableInstances,
  groupDeployablesByEnvironment,
  groupDeployablesByServer,
} from "@/lib/deployable-groups";
import { EnvironmentIcon } from "./environment-icon";
import { CloudProviderLogo } from "./cloud-provider-logo";

export function DeployableInventoryTable<T extends App | Resource>({
  items,
  groupBy = "manifest",
  servers = [],
  columns,
  ...props
}: Parameters<typeof ResourceTable<T>>[0] & {
  groupBy?: "manifest" | "environment" | "server";
  servers?: Server[];
}) {
  const visibleColumns =
    groupBy === "server"
      ? columns.filter((column) => column.key !== "server")
      : columns;
  if (items.length === 0)
    return <ResourceTable {...props} columns={visibleColumns} items={items} />;
  if (groupBy === "environment" || groupBy === "server") {
    const groups =
      groupBy === "server"
        ? groupDeployablesByServer(items, servers)
        : groupDeployablesByEnvironment(items);
    return (
      <div className="grid gap-6">
        {groups.map((group) => {
          const server =
            groupBy === "server"
              ? servers.find((server) => server.canonicalIp === group.key)
              : undefined;
          const instance = server?.hardware?.instance;
          return (
            <section
              className="grid min-w-0 gap-3"
              key={group.key}
              aria-label={group.name ?? "No environment"}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {groupBy === "server" && instance ? (
                  <CloudProviderLogo provider={instance.provider} />
                ) : groupBy === "server" ? (
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="size-4 shrink-0"
                    icon={ServerStack01Icon}
                  />
                ) : (
                  <EnvironmentIcon
                    name={group.name ?? undefined}
                    className="size-4"
                  />
                )}
                <span className="min-w-0 break-words text-sm font-medium">
                  {group.name ?? "No environment"}
                  {groupBy === "server" ? (
                    <span className="font-normal text-muted">
                      {" "}
                      ({group.key}
                      {instance?.type ? ` / ${instance.type}` : ""})
                    </span>
                  ) : null}
                </span>
              </div>
              <ResourceTable
                {...props}
                columns={visibleColumns.map((column) =>
                  column.key === "name"
                    ? {
                        ...column,
                        header: `${["app", "compose"].includes(group.items[0]!.kind) ? "Services" : "Datastores"} (${group.items.length})`,
                      }
                    : column,
                )}
                ariaLabel={`${props.ariaLabel}: ${group.name ?? "No environment"}`}
                items={group.items}
              />
            </section>
          );
        })}
      </div>
    );
  }
  return (
    <div className="grid gap-6">
      {groupDeployableInstances(items).map((group) => (
        <section
          className="grid min-w-0 gap-3"
          key={group.key}
          aria-label={group.manifestId}
        >
          <div className="flex min-w-0 items-center gap-2">
            <HugeiconsIcon
              aria-hidden="true"
              className="size-4 shrink-0"
              icon={
                group.items[0]!.kind === "app"
                  ? DashboardCircleIcon
                  : DatabaseIcon
              }
            />
            <span className="truncate text-sm font-medium">
              <TooltipText tooltip={group.manifestId} tabIndex={-1}>
                {group.manifestId}
              </TooltipText>
            </span>
          </div>
          <ResourceTable
            {...props}
            columns={visibleColumns}
            ariaLabel={`${props.ariaLabel}: ${group.manifestId}`}
            items={group.items}
          />
        </section>
      ))}
    </div>
  );
}
