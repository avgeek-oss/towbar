"use client";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { ElapsedTime } from "./elapsed-time";

import {
  DashboardCircleIcon,
  DatabaseIcon,
  GitCompareIcon,
  InformationSquareIcon,
  RefreshIcon,
  ServerStack01Icon,
  ValidationIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useParams } from "next/navigation";
import type { SourceSync } from "@workspace/towbar-web-client";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";

import { DashboardPage, PageTabs } from "@/components/page-parts";
import { formatDate } from "@/components/dashboard-overview";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDetailNavigation } from "@/hooks/use-detail-navigation";
import { useSourceBreadcrumbs } from "./source-breadcrumbs";
import { EnvironmentChip } from "./environment-chip";

export function SourceSyncDetail() {
  const detailNavigation = useDetailNavigation();
  const { sourceId, syncId } = useParams<{
    sourceId: string;
    syncId: string;
  }>();
  const query = useApiQuery<{ sync: SourceSync }>(
    `/v1/core/sources/${sourceId}/syncs/${syncId}`,
    5_000,
  );
  const breadcrumbAncestors = useSourceBreadcrumbs(sourceId, {
    href: `/repositories/${sourceId}/sync-history`,
    label: "Sync history",
  });

  if (query.error) {
    return (
      <DashboardPage
        icon={RefreshIcon}
        breadcrumbAncestors={breadcrumbAncestors}
        title="Repository sync"
      >
        <QueryError message={query.error} />
      </DashboardPage>
    );
  }

  if (!query.data) {
    return <QueryLoading variant="detail" />;
  }

  const sync = query.data.sync;
  const issueCount = Array.isArray(sync.issues) ? sync.issues.length : 0;
  const changes = readReconciliationChanges(sync.reconciliation);
  const legacyCounts = readLegacyReconciliationCounts(sync.reconciliation);
  const changeCount = legacyCounts
    ? legacyCounts.apps + legacyCounts.resources + legacyCounts.servers
    : changes.length;
  const hasLegacyScope = !sync.environment || !sync.mappingRevision;
  const defaultSection =
    sync.status === "failed" && issueCount ? "issues" : "overview";
  return (
    <DashboardPage
      icon={RefreshIcon}
      badge={
        (detailNavigation.section ?? defaultSection) === "overview" ? (
          <StatusBadge status={sync.status} />
        ) : undefined
      }
      breadcrumbAncestors={breadcrumbAncestors}
      title={`Sync ${sync.id.slice(0, 8)}`}
      breadcrumbSwitcher={{ id: syncId, kind: "syncs", sourceId }}
      titleContent={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span>Sync</span>
          <TypographyCode title={sync.id}>{sync.id.slice(0, 8)}</TypographyCode>
        </span>
      }
    >
      <PageTabs
        defaultValue={defaultSection}
        tabs={[
          {
            value: "overview",
            label: "Overview",
            icon: (
              <HugeiconsIcon aria-hidden="true" icon={InformationSquareIcon} />
            ),
            content: (
              <div className="content-grid">
                {hasLegacyScope ? (
                  <Alert status="warning">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>Legacy sync metadata</Alert.Title>
                      <Alert.Description>
                        This sync completed before environment mapping details
                        were recorded. Its imported inventory and revision
                        remain available below.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
                <div className="content-grid lg:grid-cols-2">
                  <Attributes columns={2} title="Sync" variant="card">
                    <Attributes.Item label="Environment">
                      {sync.environment ? (
                        <EnvironmentChip name={sync.environment.name} />
                      ) : (
                        "Legacy sync"
                      )}
                    </Attributes.Item>
                    <Attributes.Item label="Mapping revision">
                      {sync.mappingRevision ? (
                        <TypographyCode title={sync.mappingRevision}>
                          {sync.mappingRevision.slice(0, 8)}
                        </TypographyCode>
                      ) : (
                        "Legacy sync"
                      )}
                    </Attributes.Item>
                    <Attributes.Item label="Changes">
                      {changeCount}
                    </Attributes.Item>
                    <Attributes.Item label="Validation issues">
                      {issueCount}
                    </Attributes.Item>
                    <Attributes.Item label="Requested">
                      {formatDate(sync.createdAt)}
                    </Attributes.Item>
                    <Attributes.Item label="Started">
                      {sync.startedAt
                        ? formatDate(sync.startedAt)
                        : "Not started"}
                    </Attributes.Item>
                    <Attributes.Item label="Finished">
                      {sync.finishedAt
                        ? formatDate(sync.finishedAt)
                        : "Not finished"}
                    </Attributes.Item>
                    <Attributes.Item label="Duration">
                      <ElapsedTime {...sync} />
                    </Attributes.Item>
                  </Attributes>
                  <Attributes columns={2} title="Revision" variant="card">
                    <Attributes.Item label="Branch">
                      {sync.environment ? (
                        <TypographyCode>
                          {sync.environment.branch}
                        </TypographyCode>
                      ) : (
                        "Not recorded"
                      )}
                    </Attributes.Item>
                    <Attributes.Item label="Commit">
                      {sync.commitSha ? (
                        <TypographyCode title={sync.commitSha}>
                          {sync.commitSha.slice(0, 12)}
                        </TypographyCode>
                      ) : (
                        "Not recorded"
                      )}
                    </Attributes.Item>
                    <Attributes.Item label="Manifest digest">
                      {sync.manifestDigest ? (
                        <TypographyCode title={sync.manifestDigest}>
                          {sync.manifestDigest.slice(0, 12)}
                        </TypographyCode>
                      ) : (
                        "Not recorded"
                      )}
                    </Attributes.Item>
                    <Attributes.Item label="Sync ID">
                      <TypographyCode title={sync.id}>
                        {sync.id.slice(0, 8)}
                      </TypographyCode>
                    </Attributes.Item>
                  </Attributes>
                </div>
              </div>
            ),
          },
          {
            value: "changes",
            label: "Changes",
            icon: <HugeiconsIcon aria-hidden="true" icon={GitCompareIcon} />,
            indicator: changes.length
              ? { label: String(changes.length), variant: "secondary" }
              : undefined,
            content: (
              <SyncChanges changes={changes} value={sync.reconciliation} />
            ),
          },
          {
            value: "issues",
            label: "Validation issues",
            icon: <HugeiconsIcon aria-hidden="true" icon={ValidationIcon} />,
            indicator: issueCount
              ? { label: String(issueCount), variant: "destructive" }
              : undefined,
            content: <SyncIssues value={sync.issues} />,
          },
        ]}
      />
    </DashboardPage>
  );
}

type ReconciliationAction = "archive" | "create" | "restore" | "update";
type ReconciliationKind = "Service" | "Datastore" | "Server";
type ReconciliationChange = {
  action: ReconciliationAction;
  id: string;
  kind: ReconciliationKind;
};

const changeColumns: ResourceTableColumn<ReconciliationChange>[] = [
  {
    key: "item",
    header: "Item",
    cell: (change) => (
      <TypographyCode className="whitespace-nowrap">{change.id}</TypographyCode>
    ),
    className: "w-full min-w-64",
  },
  {
    key: "type",
    header: "Type",
    cell: (change) => (
      <span className="flex items-center gap-2 whitespace-nowrap">
        <HugeiconsIcon
          aria-hidden="true"
          className="size-5 shrink-0 text-muted"
          icon={reconciliationKindIcon(change.kind)}
        />
        {change.kind}
      </span>
    ),
    className: "min-w-40",
  },
  {
    key: "change",
    header: "Change",
    cell: (change) => <ChangeBadge action={change.action} />,
    className: "min-w-36",
  },
];

function SyncChanges({
  changes,
  value,
}: {
  changes: ReconciliationChange[];
  value: unknown;
}) {
  const legacyCounts = readLegacyReconciliationCounts(value);
  if (legacyCounts) {
    return (
      <Attributes columns={3} title="Imported inventory" variant="card">
        <Attributes.Item
          icon={<HugeiconsIcon aria-hidden="true" icon={DashboardCircleIcon} />}
          label="Services"
        >
          {legacyCounts.apps}
        </Attributes.Item>
        <Attributes.Item
          icon={<HugeiconsIcon aria-hidden="true" icon={DatabaseIcon} />}
          label="Datastores"
        >
          {legacyCounts.resources}
        </Attributes.Item>
        <Attributes.Item
          icon={<HugeiconsIcon aria-hidden="true" icon={ServerStack01Icon} />}
          label="Servers"
        >
          {legacyCounts.servers}
        </Attributes.Item>
      </Attributes>
    );
  }
  return (
    <ResourceTable
      ariaLabel="Repository sync changes"
      columns={changeColumns}
      emptyDescription="The manifest matched the current services, datastores, and servers."
      emptyTitle="No inventory changes"
      getRowKey={(change) => `${change.kind}:${change.id}:${change.action}`}
      items={changes}
      tableClassName="min-w-[640px]"
    />
  );
}

function ChangeBadge({ action }: { action: ReconciliationAction }) {
  const variant =
    action === "archive"
      ? "danger"
      : action === "update"
        ? "warning"
        : "success";
  const tooltip =
    action === "archive"
      ? "The item was absent from the synced manifest and moved to archived state."
      : action === "create"
        ? "The sync created this item from the manifest."
        : action === "restore"
          ? "The sync restored a previously archived item."
          : "The sync applied manifest changes to this item.";
  return (
    <TooltipText className="inline-flex" tooltip={tooltip}>
      <Chip color={variant}>
        <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
          {formatChangeAction(action)}
        </Chip.Label>
      </Chip>
    </TooltipText>
  );
}

function SyncIssues({ value }: { value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) {
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>No validation issues</EmptyState.Title>
          <EmptyState.Description>
            This manifest passed validation without any recorded issues.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-3">
      {value.map((issue, index) => (
        <Alert status="danger" key={`${readIssuePath(issue)}:${index}`}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              <TypographyCode>{readIssuePath(issue)}</TypographyCode>
            </Alert.Title>
            <Alert.Description>{readIssueMessage(issue)}</Alert.Description>
          </Alert.Content>
        </Alert>
      ))}
    </div>
  );
}

function readIssuePath(value: unknown) {
  if (value && typeof value === "object" && "path" in value) {
    const path = (value as { path?: unknown }).path;
    if (Array.isArray(path)) return path.join(".") || "Manifest";
    if (typeof path === "string") return path || "Manifest";
  }
  return "Manifest validation";
}

function readIssueMessage(value: unknown) {
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(value);
}

function readReconciliationChanges(value: unknown) {
  if (!isRecord(value)) return [];
  return (
    [
      ["apps", "Service"],
      ["resources", "Datastore"],
      ["servers", "Server"],
    ] as const
  ).flatMap(([key, kind]) => {
    const entries = value[key];
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry): ReconciliationChange[] => {
      if (!isRecord(entry)) return [];
      const action = entry.action;
      const id = entry.id;
      if (
        typeof id !== "string" ||
        !["archive", "create", "restore", "update"].includes(String(action))
      )
        return [];
      return [{ action: action as ReconciliationAction, id, kind }];
    });
  });
}

function readLegacyReconciliationCounts(value: unknown) {
  if (!isRecord(value)) return null;
  const { apps, resources, servers } = value;
  if (
    typeof apps !== "number" ||
    typeof resources !== "number" ||
    typeof servers !== "number"
  )
    return null;
  return { apps, resources, servers };
}

function reconciliationKindIcon(kind: ReconciliationKind) {
  if (kind === "Service") return DashboardCircleIcon;
  if (kind === "Datastore") return DatabaseIcon;
  return ServerStack01Icon;
}

function formatChangeAction(action: ReconciliationAction) {
  if (action === "archive") return "Archived";
  if (action === "create") return "Created";
  if (action === "restore") return "Restored";
  return "Updated";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
