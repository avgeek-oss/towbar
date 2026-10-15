"use client";
import { PageSelectionTitle } from "./page-selection-title";
import {
  AlertCircleIcon,
  DatabaseIcon,
  DashboardCircleIcon,
  FilterResetIcon,
  GitBranchIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Server, Source } from "@workspace/towbar-web-client";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { usePageQuery } from "@/hooks/use-page-query";
import { SecondaryItems, SecondarySection } from "./secondary-sidebar";
import { ScoutSelect } from "./scout-controls";

type Kind = "apps" | "resources" | "servers" | "sources";
export type InventoryCounts = { all: number; attention: number };
const kindIcons = {
  apps: DashboardCircleIcon,
  resources: DatabaseIcon,
  servers: ServerStack01Icon,
  sources: GitBranchIcon,
} as const;
const kindLabels = {
  apps: "services",
  resources: "datastores",
  servers: "servers",
  sources: "repositories",
} as const;
const keys: Record<Kind, string[]> = {
  apps: [
    "q",
    "view",
    "sourceId",
    "environment",
    "serverIp",
    "running",
    "health",
  ],
  resources: [
    "q",
    "view",
    "sourceId",
    "environment",
    "serverIp",
    "resourceType",
    "running",
    "health",
  ],
  servers: ["q", "view", "setup", "health", "scout"],
  sources: ["q", "view", "sync", "autoDeploy"],
};
export function useInventoryQuery(kind: Kind) {
  const { search } = usePageQuery();
  const params = new URLSearchParams();
  for (const key of keys[kind]) {
    const value = search.get(key);
    if (value) params.set(key, value);
  }
  return `/v1/core/${kind}${params.size ? `?${params}` : ""}`;
}
export function InventorySidebar({
  kind,
  counts,
  sources = [],
  servers = [],
  environments = [],
}: {
  kind: Kind;
  counts?: InventoryCounts;
  sources?: Source[];
  servers?: Server[];
  environments?: string[];
}) {
  const { search, update } = usePageQuery();
  const kindLabel = kindLabels[kind];
  const workload = kind === "apps" || kind === "resources";
  const controls: Array<{
    key: string;
    label: string;
    options: Array<{ id: string; label: string; detail?: string }>;
  }> = [];
  const options = (values: string[]) =>
    values.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
  if (workload)
    controls.push(
      {
        key: "sourceId",
        label: "Repository",
        options: sources.map((s) => ({
          id: s.id,
          label: `${s.repositoryOwner}/${s.repositoryName}`,
        })),
      },
      {
        key: "environment",
        label: "Environment",
        options: environments.map((name) => ({ id: name, label: name })),
      },
      {
        key: "serverIp",
        label: "Server",
        options: servers.map((s) => ({
          id: s.canonicalIp,
          label: s.name ?? s.canonicalIp,
          detail: s.name ? s.canonicalIp : undefined,
        })),
      },
      ...(kind === "resources"
        ? [
            {
              key: "resourceType",
              label: "Datastore type",
              options: [
                { id: "postgres", label: "PostgreSQL" },
                { id: "redis", label: "Redis" },
              ],
            },
          ]
        : []),
      {
        key: "running",
        label: "Running state",
        options: options(["running", "stopped", "missing", "unknown"]),
      },
      {
        key: "health",
        label: "Health",
        options: options([
          "healthy",
          "unhealthy",
          "starting",
          "none",
          "unknown",
        ]),
      },
    );
  if (kind === "servers")
    controls.push(
      {
        key: "setup",
        label: "Setup status",
        options: options(["ready", "pending", "preparing", "failed"]),
      },
      {
        key: "health",
        label: "Health",
        options: options(["healthy", "unhealthy", "unknown"]),
      },
      {
        key: "scout",
        label: "Scout Agent",
        options: options([
          "online",
          "offline",
          "disabled",
          "queued",
          "installing",
          "uninstalling",
          "waiting",
          "failed",
        ]),
      },
    );
  if (kind === "sources")
    controls.push(
      {
        key: "sync",
        label: "Sync status",
        options: [
          { id: "never", label: "Not synced" },
          ...options(["queued", "running", "succeeded", "failed"]),
        ],
      },
      {
        key: "autoDeploy",
        label: "Auto-deploy",
        options: options(["enabled", "paused"]),
      },
    );
  return (
    <>
      <PageSelectionTitle
        icon={
          <HugeiconsIcon
            icon={
              search.get("view") === "attention"
                ? AlertCircleIcon
                : kindIcons[kind]
            }
          />
        }
        label={
          search.get("view") === "attention"
            ? `${kindLabel[0]!.toUpperCase()}${kindLabel.slice(1)} needing attention`
            : `All ${kindLabel}`
        }
      />
      <SecondaryItems
        title="Views"
        selected={search.get("view") ?? "all"}
        onSelect={(value) => update({ view: value === "all" ? null : value })}
        items={[
          {
            id: "all",
            label: `All ${kindLabel}`,
            badge: counts?.all?.toString(),
            icon: <HugeiconsIcon icon={kindIcons[kind]} />,
          },
          {
            id: "attention",
            label: "Needs attention",
            badge: counts?.attention?.toString(),
            icon: <HugeiconsIcon icon={AlertCircleIcon} />,
          },
        ]}
      />
      <SecondarySection title={`Filter ${kindLabel}`}>
        <div className="grid gap-4">
          {controls.map((control) => (
            <ScoutSelect
              key={control.key}
              label={control.label}
              value={search.get(control.key) ?? "all"}
              onChange={(value) =>
                update({ [control.key]: value === "all" ? null : value })
              }
              options={[{ id: "all", label: "All" }, ...control.options]}
            />
          ))}
          {keys[kind].some((key) => search.has(key)) ? (
            <Button
              variant="secondary"
              onPress={() =>
                update(Object.fromEntries(keys[kind].map((key) => [key, null])))
              }
            >
              <HugeiconsIcon icon={FilterResetIcon} className="size-4" />
              Clear filters
            </Button>
          ) : null}
        </div>
      </SecondarySection>
      <Input
        className="w-full max-w-sm"
        aria-label={`Search ${kindLabel}`}
        placeholder={
          kind === "servers"
            ? "Search server name or IP…"
            : `Search ${kindLabel}…`
        }
        value={search.get("q") ?? ""}
        maxLength={200}
        onChange={(event) => update({ q: event.target.value }, true)}
      />
    </>
  );
}
