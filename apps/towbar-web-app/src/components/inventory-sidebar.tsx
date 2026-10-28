"use client";
import { useEffect, useState } from "react";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { managedResourceTypes } from "@workspace/towbar-contracts";
import { PageSelectionTitle } from "./page-selection-title";
import {
  Cancel01Icon,
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
export const inventoryFilterKeys: Record<Kind, string[]> = {
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
  for (const key of inventoryFilterKeys[kind]) {
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
              options: managedResourceTypes.map((id) => ({
                id,
                label: {
                  postgres: "PostgreSQL",
                  mysql: "MySQL",
                  mariadb: "MariaDB",
                  mongodb: "MongoDB",
                  redis: "Redis",
                  dragonfly: "Dragonfly",
                  keydb: "KeyDB",
                  clickhouse: "ClickHouse",
                }[id],
              })),
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
            aria-hidden="true"
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
            icon: <HugeiconsIcon aria-hidden="true" icon={kindIcons[kind]} />,
          },
          {
            id: "attention",
            label: "Needs attention",
            badge: counts?.attention?.toString(),
            icon: <HugeiconsIcon aria-hidden="true" icon={AlertCircleIcon} />,
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
        </div>
      </SecondarySection>
      <InventorySearch kind={kind} controls={controls} />
    </>
  );
}

function InventorySearch({
  kind,
  controls,
}: {
  kind: Kind;
  controls: Array<{
    key: string;
    label: string;
    options: Array<{ id: string; label: string }>;
  }>;
}) {
  const { search, update } = usePageQuery();
  const kindLabel = kindLabels[kind];
  const queryText = search.get("q") ?? "";
  const [text, setText] = useState(queryText);
  useEffect(() => setText(queryText), [queryText]);
  useEffect(() => {
    if (text === queryText) return;
    const timer = setTimeout(
      () => update({ q: text || null, page: null }, true),
      text ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [text, queryText, update]);
  return (
    <div className="grid min-w-0 gap-3">
      <Input
        className="w-full max-w-sm"
        aria-label={`Search ${kindLabel}`}
        placeholder={
          kind === "servers"
            ? "Search server name or IP…"
            : `Search ${kindLabel}…`
        }
        value={text}
        maxLength={200}
        onChange={(event) => setText(event.target.value)}
      />
      {inventoryFilterKeys[kind].some((key) => search.has(key)) ? (
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="Active filters"
        >
          {inventoryFilterKeys[kind]
            .filter((key) => search.has(key))
            .map((key) => {
              const value = search.get(key)!;
              const control = controls.find((item) => item.key === key);
              const label =
                key === "q"
                  ? `Search: ${value}`
                  : key === "view"
                    ? "Needs attention"
                    : `${control?.label ?? key}: ${control?.options.find((item) => item.id === value)?.label ?? value}`;
              return (
                <button
                  type="button"
                  key={key}
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    if (key === "q") setText("");
                    update({ [key]: null, page: null });
                  }}
                  className="min-w-0 max-w-full cursor-pointer rounded-full focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <Chip size="sm">
                    <Chip.Label className="inline-flex min-w-0 max-w-64 items-center gap-1.5">
                      <span className="truncate">{label}</span>
                      <HugeiconsIcon
                        aria-hidden="true"
                        icon={Cancel01Icon}
                        className="size-3.5 shrink-0"
                      />
                    </Chip.Label>
                  </Chip>
                </button>
              );
            })}
          <Button
            variant="secondary"
            className="h-7! text-xs"
            onPress={() => {
              setText("");
              update(
                Object.fromEntries(
                  [...inventoryFilterKeys[kind], "page"].map((key) => [
                    key,
                    null,
                  ]),
                ),
              );
            }}
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={FilterResetIcon}
              className="size-3.5"
            />
            Clear filters
          </Button>
        </div>
      ) : null}
    </div>
  );
}
