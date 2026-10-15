"use client";

import {
  DashboardCircleIcon,
  DatabaseIcon,
  ServerStack01Icon,
  SourceCodeIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "next/navigation";

import type {
  App,
  Resource,
  Server,
  Source,
  SourceSync,
} from "@workspace/towbar-web-client";
import { Header } from "@avgeek-oss/design-system/collections/list-box";
import { ListBox } from "@avgeek-oss/design-system/forms/select";
import { BreadcrumbSelect as Select } from "@avgeek-oss/design-system/navigation/breadcrumbs";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";

import { useApiQuery } from "@/hooks/use-api-query";
import { groupDeployableInstances } from "@/lib/deployable-groups";
import { ResourceLogo, ServiceLogo } from "./deployable-identity";
import { CloudProviderLogo, type CloudProviderId } from "./cloud-provider-logo";
import { resourceImageBrand, type ResourceBrand } from "./resource-image-brand";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { displayDateTime } from "@/lib/date-time-display";

export type BreadcrumbEntityKind =
  "apps" | "resources" | "servers" | "sources" | "syncs";

const entityLabels = {
  apps: "services",
  resources: "datastores",
  servers: "servers",
  sources: "repositories",
  syncs: "syncs",
} as const;

const entityRoutes = {
  apps: "services",
  resources: "datastores",
  servers: "servers",
  sources: "repositories",
  syncs: "syncs",
} as const;

const entityIcons = {
  apps: DashboardCircleIcon,
  resources: DatabaseIcon,
  servers: ServerStack01Icon,
  sources: SourceCodeIcon,
  syncs: RefreshIcon,
} as const;

type SwitchOption = {
  archived: boolean;
  detail?: string;
  id: string;
  identity?:
    | { kind: "app"; app: App }
    | { kind: "resource"; brand: ResourceBrand }
    | { kind: "server"; provider: CloudProviderId }
    | { kind: "source"; provider: Source["provider"] };
  instanceIds: string[];
  label: string;
  sourceId?: string;
  status?: SourceSync["status"];
};

function deployableOptions<T extends App | Resource>(
  items: T[],
  identity: (item: T) => SwitchOption["identity"],
): SwitchOption[] {
  return groupDeployableInstances(items).map((group) => {
    const preferred =
      group.items.find(
        (item) => item.environment?.name.toLowerCase() === "production",
      ) ??
      group.items.find((item) => !item.archivedAt) ??
      group.items[0]!;
    return {
      archived: group.items.every((item) => Boolean(item.archivedAt)),
      id: preferred.id,
      identity: identity(preferred),
      instanceIds: group.items.map((item) => item.id),
      label: preferred.name,
      sourceId: preferred.sourceId,
    };
  });
}

export function BreadcrumbEntitySwitcher({
  currentId,
  kind,
  label,
  sourceId,
}: {
  currentId: string;
  kind: BreadcrumbEntityKind;
  label: string;
  sourceId?: string;
}) {
  const router = useRouter();
  const query = useApiQuery<{
    apps?: App[];
    resources?: Resource[];
    servers?: Server[];
    sources?: Source[];
    syncs?: SourceSync[];
  }>(
    kind === "syncs"
      ? sourceId
        ? `/v1/core/sources/${sourceId}/syncs`
        : null
      : `/v1/core/${kind}`,
    30_000,
  );
  const sources = useApiQuery<{ sources: Source[] }>(
    kind === "apps" || kind === "resources" ? "/v1/core/sources" : null,
    30_000,
  );
  const options: SwitchOption[] =
    kind === "sources"
      ? (query.data?.sources ?? []).map((source) => ({
          archived: false,
          id: source.id,
          identity: { kind: "source" as const, provider: source.provider },
          instanceIds: [source.id],
          label: source.repositoryName,
          detail: `${source.repositoryOwner}/${source.repositoryName}`,
        }))
      : kind === "syncs"
        ? (query.data?.syncs ?? []).map((sync) => ({
            archived: false,
            id: sync.id,
            instanceIds: [sync.id],
            label: `Sync ${sync.id.slice(0, 8)}`,
            detail: [
              sync.environment?.name ?? "Legacy sync",
              sync.environment?.branch,
              displayDateTime(sync.createdAt),
            ]
              .filter(Boolean)
              .join(" / "),
            status: sync.status,
          }))
        : kind === "servers"
          ? (query.data?.servers ?? []).map((server) => ({
              archived: Boolean(server.archivedAt),
              id: server.id,
              identity: server.hardware?.instance
                ? {
                    kind: "server" as const,
                    provider: server.hardware.instance.provider,
                  }
                : undefined,
              instanceIds: [server.id],
              label: server.name ?? server.canonicalIp,
              detail: server.name ? server.canonicalIp : undefined,
            }))
          : kind === "apps"
            ? deployableOptions(query.data?.apps ?? [], (app) => ({
                kind: "app",
                app,
              }))
            : deployableOptions(query.data?.resources ?? [], (resource) => ({
                kind: "resource",
                brand: resourceImageBrand(resource.kind, resource.config.image),
              }));
  if (kind !== "syncs")
    options.sort((left, right) => left.label.localeCompare(right.label));
  if (!options.some((option) => option.instanceIds.includes(currentId))) {
    options.unshift({
      id: currentId,
      instanceIds: [currentId],
      label,
      archived: false,
    });
  }
  const entityLabel = entityLabels[kind];
  const icon = entityIcons[kind];
  const repositories = new Map(
    sources.data?.sources.map((source) => [source.id, source]),
  );
  const sections = new Map<
    string,
    { id: string; label: string; options: SwitchOption[] }
  >();
  for (const option of options) {
    const source = option.sourceId
      ? repositories.get(option.sourceId)
      : undefined;
    const id = source?.id ?? "other";
    const section = sections.get(id) ?? {
      id,
      label: source
        ? `${source.repositoryOwner}/${source.repositoryName}`
        : `Other ${entityLabel}`,
      options: [],
    };
    section.options.push(option);
    sections.set(id, section);
  }
  const sortedSections = [...sections.values()].sort((left, right) => {
    if (left.id === "other") return 1;
    if (right.id === "other") return -1;
    return left.label.localeCompare(right.label);
  });

  function renderOption(option: SwitchOption, repository?: string) {
    return (
      <ListBox.Item
        id={option.id}
        key={option.id}
        textValue={[option.label, option.id, option.detail, repository]
          .filter(Boolean)
          .join(" ")}
      >
        {option.identity?.kind === "app" ? (
          <ServiceLogo app={option.identity.app} size="compact" />
        ) : option.identity?.kind === "resource" ? (
          <ResourceLogo brand={option.identity.brand} size="compact" />
        ) : option.identity?.kind === "server" ? (
          <CloudProviderLogo
            provider={option.identity.provider}
            className="size-4"
            size={16}
          />
        ) : option.identity?.kind === "source" ? (
          <IntegrationProviderLogo
            provider={option.identity.provider}
            className="size-4"
            size={16}
          />
        ) : (
          <HugeiconsIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted"
            icon={icon}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.status ? <StatusBadge status={option.status} /> : null}
          </span>
          {option.detail ? (
            <span className="block truncate text-xs text-muted">
              {option.detail}
            </span>
          ) : null}
        </span>
        {option.archived ? (
          <span className="text-xs text-muted">Archived</span>
        ) : null}
        <ListBox.ItemIndicator />
      </ListBox.Item>
    );
  }

  return (
    <Select.Root
      aria-label={`Switch ${kind === "sources" ? "repository" : entityLabel.slice(0, -1)}`}
      selectedKey={currentId}
      onSelectionChange={(key) => {
        const id = String(key ?? "");
        if (id !== currentId && options.some((option) => option.id === id)) {
          router.push(
            kind === "syncs"
              ? `/repositories/${sourceId}/syncs/${id}/overview`
              : `/${entityRoutes[kind]}/${id}/${kind === "sources" ? "environments" : "overview"}`,
          );
        }
      }}
    >
      <Select.Trigger>
        <Select.Value className="min-w-0 truncate">{label}</Select.Value>
      </Select.Trigger>
      <Select.Popover
        className={`${kind === "syncs" ? "w-96" : "w-72"} max-w-[calc(100vw-2rem)] overflow-hidden`}
      >
        <Autocomplete.Filter
          filter={(text, search) =>
            text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
          }
        >
          <SearchField
            aria-label={`Search ${entityLabel}`}
            className="px-2 pt-2"
            variant="secondary"
          >
            <SearchField.Group className="rounded-md">
              <SearchField.SearchIcon />
              <SearchField.Input
                className="text-base sm:text-sm"
                placeholder={`Search ${entityLabel}…`}
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                autoFocus={
                  typeof window !== "undefined" &&
                  window.matchMedia("(pointer: fine)").matches
                }
              />
              <SearchField.ClearButton
                aria-label={`Clear ${entityLabel} search`}
              />
            </SearchField.Group>
          </SearchField>
          {query.error ? (
            <p className="px-3 py-2 text-sm text-danger">{query.error}</p>
          ) : !query.data ? (
            <p className="px-3 py-2 text-sm text-muted">
              Loading {entityLabel}…
            </p>
          ) : null}
          <ListBox
            className="max-h-80 overflow-y-auto"
            renderEmptyState={() => (
              <p className="px-3 py-4 text-sm text-muted">
                {query.error ?? `No matching ${entityLabel}.`}
              </p>
            )}
          >
            {kind === "servers" || !sources.data
              ? options.map((option) => renderOption(option))
              : sortedSections.map((section) => (
                  <ListBox.Section id={section.id} key={section.id}>
                    <Header className="truncate text-xs" title={section.label}>
                      {section.label}
                    </Header>
                    {section.options.map((option) =>
                      renderOption(option, section.label),
                    )}
                  </ListBox.Section>
                ))}
          </ListBox>
        </Autocomplete.Filter>
      </Select.Popover>
    </Select.Root>
  );
}
