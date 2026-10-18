"use client";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  TableCellStack,
  TableCellDescription,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import { useState } from "react";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { useApiQuery } from "@/hooks/use-api-query";
import { RelativeTime } from "./last-synced-time";
import { ScoutIcon } from "./scout-icons";
type Delivery = {
  id: string;
  type: string;
  provider: "slack" | "smtp" | "discord" | "telegram" | "webhook";
  destination: string;
  state: string;
  createdAt: string;
  deliveredAt: string | null;
  attemptCount: number;
  errorCode: string | null;
};
export function ScoutIncidentNotifications({
  serverId,
  incidentId,
}: {
  serverId: string;
  incidentId: string;
}) {
  const [cursors, setCursors] = useState<string[]>([""]);
  const query = useApiQuery<{
    items: Delivery[];
    nextBefore: string | null;
    nextBeforeId: string | null;
  }>(
    `/v1/core/servers/${serverId}/scout-alerts/incidents/${incidentId}/notifications?limit=10${cursors.at(-1)}`,
    30_000,
    { keepPreviousData: true },
  );
  const columns: ResourceTableColumn<Delivery>[] = [
    {
      key: "destination",
      header: "Destination",
      cell: (d) => {
        const characters = Array.from(d.destination);
        return (
          <TableCellStack as="div" className="min-w-40">
            <TooltipText
              className="max-w-64 truncate sm:max-w-[64ch]"
              tooltip={d.destination}
            >
              {characters.length > 64
                ? `${characters.slice(0, 63).join("")}…`
                : d.destination}
            </TooltipText>
            <TableCellDescription>
              {providerLabel(d.provider)}
            </TableCellDescription>
          </TableCellStack>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      cell: (d) => (
        <TooltipText className="inline-flex" tooltip={deliveryTooltip(d)}>
          <Chip
            size="sm"
            color={
              d.state === "succeeded"
                ? "success"
                : d.state === "failed"
                  ? "danger"
                  : "default"
            }
          >
            <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
              {[
                "pending",
                "queued",
                "running",
                "delivering",
                "retrying",
              ].includes(d.state) ? (
                <Spinner
                  aria-hidden="true"
                  color="current"
                  size="sm"
                  className="size-3.5"
                />
              ) : (
                <ScoutIcon
                  name={
                    d.state === "succeeded"
                      ? "resolved"
                      : d.state === "failed"
                        ? "critical"
                        : "time"
                  }
                />
              )}
              {d.state === "succeeded"
                ? "Sent"
                : d.state[0]!.toUpperCase() + d.state.slice(1)}
            </Chip.Label>
          </Chip>
        </TooltipText>
      ),
    },
    {
      key: "time",
      header: "Sent",
      cell: (d) =>
        d.deliveredAt ? (
          <RelativeTime label="Sent" value={d.deliveredAt} />
        ) : (
          <span className="text-sm text-muted">Not sent</span>
        ),
    },
    {
      key: "queued",
      header: "Queued",
      cell: (d) => <RelativeTime label="Queued" value={d.createdAt} />,
    },
  ];
  return (
    <div className="grid min-w-0 gap-4">
      {query.error ? <QueryError message={query.error} /> : null}
      {query.data ? (
        <ResourceTable
          ariaLabel="Incident notifications"
          columns={columns}
          items={query.data.items}
          getRowKey={(d) => d.id}
          emptyTitle="No notifications sent"
          emptyDescription="Notification deliveries for this incident will appear here."
        />
      ) : !query.error ? (
        <QueryLoading />
      ) : null}
      {cursors.length > 1 || query.data?.nextBefore ? (
        <div className="flex items-center justify-end gap-2">
          <span className="text-sm text-muted">Page {cursors.length}</span>
          <Button
            variant="secondary"
            isDisabled={cursors.length === 1 || query.isPreviousData}
            onPress={() => setCursors((old) => old.slice(0, -1))}
          >
            <ScoutIcon name="previous" />
            Previous
          </Button>
          <Button
            variant="secondary"
            isDisabled={!query.data?.nextBefore || query.isPreviousData}
            onPress={() =>
              setCursors((old) => [
                ...old,
                `&before=${encodeURIComponent(query.data!.nextBefore!)}&beforeId=${query.data!.nextBeforeId}`,
              ])
            }
          >
            Next
            <ScoutIcon name="next" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function providerLabel(provider: Delivery["provider"]) {
  if (provider === "smtp") return "Email";
  if (provider === "webhook") return "Webhook push";
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

function deliveryTooltip(delivery: Delivery) {
  if (delivery.state === "succeeded") {
    return delivery.deliveredAt
      ? `Delivered after ${delivery.attemptCount} ${delivery.attemptCount === 1 ? "attempt" : "attempts"}.`
      : "The provider accepted this notification.";
  }
  if (delivery.state === "failed") {
    return delivery.errorCode
      ? `Delivery failed with ${delivery.errorCode} after ${delivery.attemptCount} ${delivery.attemptCount === 1 ? "attempt" : "attempts"}.`
      : `Delivery failed after ${delivery.attemptCount} ${delivery.attemptCount === 1 ? "attempt" : "attempts"}.`;
  }
  return "This notification is waiting to be delivered.";
}
