"use client";

import {
  DatabaseIcon,
  DashboardCircleIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { App, Resource, Server } from "@workspace/towbar-web-client";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  groupDeployableInstances,
  groupDeployablesByEnvironment,
  groupDeployablesByServer,
} from "@/lib/deployable-groups";
import { EnvironmentIcon } from "./environment-icon";

export function DeployableInventoryTable<T extends App | Resource>({
  items,
  groupBy = "manifest",
  servers = [],
  ...props
}: Parameters<typeof ResourceTable<T>>[0] & {
  groupBy?: "manifest" | "environment" | "server";
  servers?: Server[];
}) {
  if (items.length === 0) return <ResourceTable {...props} items={items} />;
  if (groupBy === "environment" || groupBy === "server") {
    const groups =
      groupBy === "server"
        ? groupDeployablesByServer(items, servers)
        : groupDeployablesByEnvironment(items);
    return (
      <div className="grid gap-6">
        {groups.map((group) => (
          <section
            className="grid min-w-0 gap-3"
            key={group.key}
            aria-label={group.name ?? "No environment"}
          >
            <div className="flex min-w-0 items-center gap-2">
              {groupBy === "server" ? (
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
              <span className="truncate text-sm font-medium">
                {groupBy === "server" ? (
                  <TooltipText tooltip={group.key} tabIndex={-1}>
                    {group.name}
                  </TooltipText>
                ) : (
                  (group.name ?? "No environment")
                )}
              </span>
              <Chip className="shrink-0" size="sm" color="default">
                <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                  {group.items.length}{" "}
                  {["app", "compose"].includes(group.items[0]!.kind)
                    ? "service"
                    : "datastore"}
                  {group.items.length === 1 ? "" : "s"}
                </Chip.Label>
              </Chip>
            </div>
            <ResourceTable
              {...props}
              ariaLabel={`${props.ariaLabel}: ${group.name ?? "No environment"}`}
              items={group.items}
            />
          </section>
        ))}
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
            <TooltipText
              className="inline-flex"
              tooltip={`This manifest has ${group.items.length} connected environment instance${group.items.length === 1 ? "" : "s"}.`}
            >
              <Chip className="shrink-0" size="sm" color="default">
                <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                  {group.items.length}{" "}
                  {group.items.length === 1 ? "environment" : "environments"}
                </Chip.Label>
              </Chip>
            </TooltipText>
          </div>
          <ResourceTable
            {...props}
            ariaLabel={`${props.ariaLabel}: ${group.manifestId}`}
            items={group.items}
          />
        </section>
      ))}
    </div>
  );
}
