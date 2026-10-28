"use client";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  TableCellStack,
  TableCellDescription,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import { useMemo, useState } from "react";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { App, Resource, Server } from "@workspace/towbar-web-client";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  notificationCategoryPresentation,
  notificationHistoryCategories,
} from "./notification-categories";
import { NotificationProviderIcon } from "./notification-provider-icon";
import { ResourceLogo, ServiceLogo } from "./deployable-identity";
import { CloudProviderLogo } from "./cloud-provider-logo";
import { EnvironmentChip } from "./environment-chip";
import { resourceImageBrand } from "./resource-image-brand";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import type { ResourceTableColumn } from "@avgeek-oss/design-system/patterns/resource-table";
import { RelativeTime } from "./last-synced-time";
import { ScoutIcon } from "./scout-icons";
import {
  EventDetail,
  EventDetails,
  HistoryFilter,
  HistorySearch,
  HistoryTable,
  useEventHistory,
} from "./event-history";
const providerLabels = {
  slack: "Slack",
  smtp: "Email",
  webhook: "Webhook push",
};
const stateLabels = {
  pending: "Pending",
  delivering: "Sending",
  retrying: "Retrying",
  succeeded: "Sent",
  failed: "Failed",
};
type Delivery = {
  id: string;
  eventId: string;
  destinationId: string;
  provider: keyof typeof providerLabels;
  destination: string;
  destinationDeleted: string | null;
  type: string;
  category: string;
  title: string;
  entityId: string;
  entityName: string;
  targetId: string | null;
  sourceId: string | null;
  serverId: string | null;
  state: keyof typeof stateLabels;
  attemptCount: number;
  cycle: number;
  errorCode: string | null;
  nextAttemptAt: string | null;
  lastAttemptedAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
};
function deliveryStatusIcon(state: Delivery["state"]) {
  if (["pending", "delivering", "retrying"].includes(state))
    return (
      <Spinner
        aria-hidden="true"
        color="current"
        size="sm"
        className="size-3.5"
      />
    );
  return (
    <span className={state === "succeeded" ? "text-success" : undefined}>
      <ScoutIcon
        name={
          state === "succeeded"
            ? "resolved"
            : state === "failed"
              ? "critical"
              : "time"
        }
      />
    </span>
  );
}
function deliveryStatus(item: Delivery) {
  return (
    <TooltipText
      className="inline-flex"
      tooltip={
        item.state === "succeeded"
          ? "The provider accepted this notification."
          : (item.errorCode ?? undefined)
      }
    >
      <Chip
        size="sm"
        color={
          item.state === "succeeded"
            ? "success"
            : item.state === "failed"
              ? "danger"
              : "default"
        }
      >
        <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
          {deliveryStatusIcon(item.state)}
          {stateLabels[item.state]}
        </Chip.Label>
      </Chip>
    </TooltipText>
  );
}
export function NotificationDeliveries() {
  const history = useEventHistory<Delivery>(
    "/v1/core/notifications/deliveries",
  );
  const apps = useApiQuery<{ apps: App[] }>("/v1/core/apps", 30_000);
  const resources = useApiQuery<{ resources: Resource[] }>(
    "/v1/core/resources",
    30_000,
  );
  const servers = useApiQuery<{ servers: Server[] }>(
    "/v1/core/servers",
    30_000,
  );
  const entities = useMemo(
    () => [
      ...(apps.data?.apps ?? []).map((app) => ({
        id: app.id,
        name: app.name,
        kind: "Service",
        environment: app.environment?.name,
        detail: undefined,
        icon: <ServiceLogo app={app} size="compact" />,
      })),
      ...(resources.data?.resources ?? []).map((resource) => ({
        id: resource.id,
        name: resource.name,
        kind: "Datastore",
        environment: resource.environment?.name,
        detail: undefined,
        icon: (
          <ResourceLogo
            brand={resourceImageBrand(resource.kind, resource.config.image)}
            size="compact"
          />
        ),
      })),
      ...(servers.data?.servers ?? []).map((server) => ({
        id: server.id,
        name: server.name ?? server.canonicalIp,
        kind: "Server",
        environment: null,
        detail: server.name ? server.canonicalIp : undefined,
        icon: server.hardware?.instance ? (
          <CloudProviderLogo
            provider={server.hardware.instance.provider}
            className="size-4"
            size={16}
          />
        ) : (
          <HugeiconsIcon
            aria-hidden="true"
            icon={ServerStack01Icon}
            className="size-4"
          />
        ),
      })),
    ],
    [apps.data, resources.data, servers.data],
  );
  const entityById = useMemo(
    () => new Map(entities.map((entity) => [entity.id, entity])),
    [entities],
  );
  const [selected, setSelected] = useState<Delivery | null>(null);
  const [open, setOpen] = useState(false);
  const columns: ResourceTableColumn<Delivery>[] = [
    {
      key: "event",
      header: "Notification",
      cell: (item) => (
        <TableCellStack
          as="div"
          className="min-w-36 max-w-64 whitespace-normal"
        >
          <button
            type="button"
            className="cursor-pointer text-left underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-focus"
            aria-label={`View delivery details for ${item.title}`}
            onClick={() => {
              setSelected(item);
              setOpen(true);
            }}
          >
            {item.title}
          </button>
        </TableCellStack>
      ),
    },
    { key: "status", header: "Status", cell: deliveryStatus },
    {
      key: "entity",
      header: "Entity",
      cell: (item) => {
        const entity = item.targetId ? entityById.get(item.targetId) : null;
        return (
          <span className="inline-flex min-w-28 max-w-48 items-center gap-2 whitespace-normal">
            {entity?.icon ? (
              <span
                className="inline-flex size-4 shrink-0 items-center justify-center [&>span]:size-4 [&_img]:size-4 [&_svg]:size-4"
                aria-hidden="true"
              >
                {entity.icon}
              </span>
            ) : null}
            <TableCellStack>
              <span className="break-words">
                {entity?.name ?? item.entityName}
              </span>
              {entity?.environment || entity?.detail ? (
                <TableCellDescription>
                  {entity.environment ?? entity.detail}
                </TableCellDescription>
              ) : null}
            </TableCellStack>
          </span>
        );
      },
    },
    {
      key: "destination",
      header: "Destination",
      cell: (item) => (
        <TableCellStack
          as="div"
          className="min-w-28 max-w-48 whitespace-normal"
        >
          <span className="break-words [overflow-wrap:anywhere]">
            {item.destination}
          </span>
          <TableCellDescription className="flex items-center gap-1.5">
            <NotificationProviderIcon
              provider={item.provider}
              className="size-3 shrink-0"
            />
            {providerLabels[item.provider] ?? item.provider}
            {item.destinationDeleted ? " · Removed" : ""}
          </TableCellDescription>
        </TableCellStack>
      ),
    },
    {
      key: "category",
      header: "Category",
      cell: (item) => (
        <DeliveryCategory category={item.category} type={item.type} />
      ),
    },
    {
      key: "queued",
      header: "Queued",
      cell: (item) => <RelativeTime value={item.createdAt} label="Queued" />,
    },
  ];
  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid items-end gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)]">
        <div className="grid min-w-0 items-end gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <HistoryFilter
            label="States"
            value={history.filters.state}
            options={Object.entries(stateLabels).map(([id, label]) => ({
              id,
              label,
            }))}
            onChange={(value) => history.setFilter("state", value)}
          />
          <HistoryFilter
            label="Providers"
            value={history.filters.provider}
            allIcon={<ScoutIcon name="all" />}
            options={(
              Object.keys(providerLabels) as Delivery["provider"][]
            ).map((id) => ({
              id,
              label: providerLabels[id],
              icon: <NotificationProviderIcon provider={id} />,
            }))}
            onChange={(value) => history.setFilter("provider", value)}
          />
          <HistoryFilter
            label="Categories"
            value={history.filters.category}
            allIcon={<ScoutIcon name="all" />}
            options={notificationHistoryCategories.map((category) => ({
              id: category.key,
              label: category.label,
              icon: (
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={category.icon}
                  className="size-4 shrink-0"
                />
              ),
            }))}
            onChange={(value) => history.setFilter("category", value)}
          />
          <HistoryFilter
            label="Entities"
            value={history.filters.entityId}
            allIcon={<ScoutIcon name="all" />}
            options={entities.map((entity) => ({
              id: entity.id,
              label: entity.name,
              ariaLabel: [
                entity.name,
                entity.kind,
                entity.environment,
                entity.detail,
              ]
                .filter(Boolean)
                .join(", "),
              searchText: [
                entity.name,
                entity.kind,
                entity.environment,
                entity.detail,
              ]
                .filter(Boolean)
                .join(" "),
              icon: entity.icon,
              trailing: entity.environment ? (
                <EnvironmentChip
                  name={entity.environment}
                  showIcon={false}
                  showTooltip={false}
                />
              ) : entity.detail ? (
                <span className="shrink-0 text-xs text-muted">
                  {entity.detail}
                </span>
              ) : undefined,
            }))}
            searchPlaceholder="Search services, datastores or servers"
            onChange={(value) => history.setFilter("entityId", value)}
          />
        </div>
        <HistorySearch
          value={history.filters.search ?? ""}
          label="Search deliveries"
          placeholder="Notification, entity or delivery ID"
          onSearch={(value) => history.setFilter("search", value)}
        />
      </div>
      <HistoryTable
        history={history}
        columns={columns}
        label="Deliveries"
        emptyDescription="Notification deliveries will appear here when an event is routed to a configured provider."
      />
      <EventDetails open={open} onOpenChange={setOpen} title="Delivery details">
        {selected ? (
          <>
            <EventDetail label="Notification" value={selected.title} />
            <EventDetail label="Status" value={deliveryStatus(selected)} />
            <EventDetail
              label="Provider"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <NotificationProviderIcon provider={selected.provider} />
                  {providerLabels[selected.provider] ?? selected.provider}
                </span>
              }
            />
            <EventDetail label="Destination" value={selected.destination} />
            <EventDetail
              label="Category"
              value={
                <DeliveryCategory
                  category={selected.category}
                  type={selected.type}
                />
              }
            />
            <EventDetail label="Event type" value={selected.type} />
            <EventDetail
              label="Entity"
              value={
                (selected.targetId &&
                  entityById.get(selected.targetId)?.name) ||
                selected.entityName
              }
            />
            <EventDetail
              label="Queued"
              value={<RelativeTime value={selected.createdAt} label="Queued" />}
            />
            <EventDetail
              label="Sent"
              value={
                selected.deliveredAt ? (
                  <RelativeTime value={selected.deliveredAt} label="Sent" />
                ) : (
                  "Not sent"
                )
              }
            />
            <EventDetail label="Attempts" value={selected.attemptCount} />
            {selected.errorCode ? (
              <EventDetail label="Last error code" value={selected.errorCode} />
            ) : null}
            {selected.lastAttemptedAt ? (
              <EventDetail
                label="Last attempt"
                value={
                  <RelativeTime
                    value={selected.lastAttemptedAt}
                    label="Last attempt"
                  />
                }
              />
            ) : null}
            {selected.state === "retrying" && selected.nextAttemptAt ? (
              <EventDetail
                label="Next attempt"
                value={
                  <RelativeTime
                    value={selected.nextAttemptAt}
                    label="Next attempt"
                  />
                }
              />
            ) : null}
            <EventDetail label="Delivery ID" value={selected.id} copy />
            <EventDetail label="Event ID" value={selected.eventId} copy />
            <EventDetail
              label="Destination ID"
              value={selected.destinationId}
              copy
            />
            <EventDetail label="Entity ID" value={selected.entityId} copy />
          </>
        ) : null}
      </EventDetails>
    </div>
  );
}

function DeliveryCategory({
  category,
  type,
}: {
  category: string;
  type: string;
}) {
  const presentation = notificationCategoryPresentation(category, type);
  return (
    <span className="inline-flex min-w-24 max-w-40 items-center gap-1.5 whitespace-normal">
      {presentation ? (
        <HugeiconsIcon
          icon={presentation.icon}
          className="size-4 shrink-0 text-muted"
          aria-hidden="true"
        />
      ) : null}
      {presentation?.label ?? category}
    </span>
  );
}
