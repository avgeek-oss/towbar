"use client";

import { CheckmarkCircle01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ManifestNotifications } from "@workspace/towbar-contracts";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";

import { NotificationProviderIcon } from "./notification-provider-icon";

type Subscription = {
  deployments: boolean;
  deploymentFailures?: boolean;
  backupsAndRestores: boolean;
  alertsAndIncidents: boolean;
};
type Provider = "smtp" | "slack";
type Destination = Subscription & {
  label: string;
  key: string;
  provider: Provider;
};

const providerLabels: Record<Provider, string> = {
  smtp: "Email",
  slack: "Slack",
};

const subscriptionColumns = [
  { key: "backupsAndRestores", label: "Backup & Restore" },
  { key: "alertsAndIncidents", label: "Incidents" },
] as const;

const columns: ResourceTableColumn<Destination>[] = [
  {
    key: "provider",
    header: "Provider",
    className: "min-w-28",
    cell: (row) => (
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        <NotificationProviderIcon provider={row.provider} />
        {providerLabels[row.provider]}
      </span>
    ),
  },
  {
    key: "destination",
    header: "Destination",
    className: "min-w-44",
    cell: (row) => row.label,
  },
  {
    key: "deployments",
    header: "Deployments",
    className: "min-w-32",
    cell: (row) =>
      row.deployments ? (
        "All"
      ) : row.deploymentFailures ? (
        "Failures only"
      ) : (
        <span className="text-muted" aria-label="Not enabled">
          —
        </span>
      ),
  },
  ...subscriptionColumns.map(({ key, label }) => ({
    key,
    header: label,
    headerClassName: "text-left",
    className: "min-w-32 text-left",
    cell: (row: Destination) =>
      row[key] ? (
        <span className="inline-flex items-center gap-1.5 text-success">
          <HugeiconsIcon
            aria-hidden="true"
            icon={CheckmarkCircle01Icon}
            className="size-4"
          />
          <span className="sr-only">Enabled</span>
        </span>
      ) : (
        <span className="text-muted" aria-label="Not enabled">
          —
        </span>
      ),
  })),
];

export function DeployableNotifications({
  notifications,
}: {
  notifications?: ManifestNotifications;
}) {
  const destinations: Destination[] = [
    ...(notifications?.email ?? []).map((row) => ({
      ...row,
      key: `smtp:${row.address}`,
      label: row.address,
      provider: "smtp" as const,
    })),
    ...(notifications?.slack ?? []).map((row) => ({
      ...row,
      key: `slack:${row.channelId}`,
      label: row.channelId,
      provider: "slack" as const,
    })),
  ];

  if (!destinations.length)
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>No notification destinations</EmptyState.Title>
          <EmptyState.Description>
            Add destinations to this service or datastore manifest, then sync
            the repository to receive its notifications here.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );

  return (
    <ResourceTable
      ariaLabel="Notification destinations"
      columns={columns}
      items={destinations}
      getRowKey={(row) => row.key}
      emptyTitle="No destinations"
      emptyDescription="No notification destinations are configured."
      tableClassName="[&_.table__column]:py-2"
    />
  );
}
