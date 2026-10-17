import { displayDateTime } from "@/lib/date-time-display";
import { memo, useEffect, useState } from "react";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";
import type { MonitoringHistory } from "@workspace/towbar-web-client";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { useUrlTablePagination as useTablePagination } from "@/hooks/use-url-pagination";
import { Pagination } from "@avgeek-oss/design-system/navigation/pagination";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
const formatDate = displayDateTime;

type Event = MonitoringHistory["events"][number];
const eventLabels = {
  deployment: "Deployment",
  restart: "Container restart",
  "host-restart": "Host restart",
  "instance-change": "Machine type changed",
  "capacity-change": "Capacity changed",
};
const markerLabels = {
  deployment: "D",
  restart: "R",
  "host-restart": "H",
  "instance-change": "M",
  "capacity-change": "C",
};
const markerOffsets = {
  deployment: 9,
  restart: 53,
  "host-restart": 97,
  "instance-change": 141,
  "capacity-change": 141,
};
const statusLabel = (event: Event) =>
  event.type === "deployment"
    ? event.state
    : event.type.endsWith("change")
      ? "changed"
      : "restarted";
const columns: ResourceTableColumn<Event>[] = [
  {
    key: "event",
    header: "Event",
    cell: (event) => eventLabels[event.type],
  },
  {
    key: "status",
    header: "Status",
    cell: (event) => <StatusBadge status={statusLabel(event)} />,
  },
  {
    key: "reference",
    header: "Details",
    cell: (event) =>
      event.detail ?? <TypographyCode>{event.id.slice(0, 8)}</TypographyCode>,
  },
  {
    key: "time",
    header: "Time",
    cell: (event) => <time dateTime={event.at}>{formatDate(event.at)}</time>,
  },
];

export const MonitoringEvents = memo(function MonitoringEvents({
  events,
  limited,
}: {
  events: Event[];
  limited: boolean;
}) {
  const pagination = useTablePagination({ pageSize: 10, total: events.length });
  const visibleEvents = events.slice(
    pagination.offset,
    pagination.offset + pagination.pageSize,
  );
  return (
    <section
      className="mt-4 grid min-w-0 gap-3"
      aria-label="Performance events"
    >
      <h3 className="font-medium">Performance events</h3>
      <div className="overflow-x-auto">
        <ResourceTable
          ariaLabel="Performance events"
          columns={columns}
          items={visibleEvents}
          getRowKey={(event) => `${event.type}:${event.id}:${event.at}`}
          emptyTitle="No events in this range"
          emptyDescription="Deployments, container restarts, host restarts, and hardware changes will appear here."
          tableClassName="min-w-[580px]"
        />
      </div>
      {events.length > pagination.pageSize ? (
        <Pagination
          aria-label="Performance event pages"
          page={pagination.page}
          size="sm"
          totalPages={pagination.totalPages ?? 1}
          onPageChange={pagination.setPage}
        />
      ) : null}
      {limited ? (
        <p className="text-sm text-muted">
          Showing the latest {events.length} events in this duration. Choose a
          shorter duration to see more detail.
        </p>
      ) : null}
    </section>
  );
});

export const monitoringEventColor = (type: Event["type"]) =>
  type === "deployment"
    ? "var(--chart-accent)"
    : type.endsWith("change")
      ? "var(--accent)"
      : "var(--warning)";

export function MonitoringEventMarker({
  event,
  viewBox,
  onActiveChange,
}: {
  event: Event;
  onActiveChange?: (active: boolean) => void;
  viewBox?: { x?: number; y?: number };
}) {
  const [open, setOpen] = useState(false);
  const date = displayDateTime(event.at);
  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);
  const changeOpen = (active: boolean) => {
    setOpen(active);
    onActiveChange?.(active);
  };
  if (viewBox?.x === undefined || viewBox.y === undefined) return null;
  const offset = markerOffsets[event.type];
  const title = eventLabels[event.type];
  const label = `${title}${event.detail ? `: ${event.detail}` : ` ${event.id.slice(0, 8)}`} at ${date}`;
  return (
    <foreignObject
      x={viewBox.x - 22}
      y={viewBox.y + offset - 22}
      width={44}
      height={44}
      className="monitoring-event-marker"
      style={{ overflow: "visible" }}
    >
      <Tooltip isOpen={open} onOpenChange={changeOpen}>
        <Tooltip.Trigger
          aria-label={label}
          onMouseEnter={() => changeOpen(true)}
          onMouseLeave={() => changeOpen(false)}
          onFocus={() => changeOpen(true)}
          onBlur={() => changeOpen(false)}
          className="flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span
            className="flex size-3.5 items-center justify-center rounded-full text-[9px] font-semibold text-warning-foreground"
            style={{
              color: event.type.endsWith("change")
                ? "var(--accent-foreground)"
                : undefined,
              background:
                event.type === "deployment"
                  ? "var(--chart-requested)"
                  : monitoringEventColor(event.type),
            }}
          >
            {markerLabels[event.type]}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content
          className="max-w-64 whitespace-normal break-normal text-xs [overflow-wrap:normal] [word-break:normal]"
          placement="top"
          showArrow
        >
          <Tooltip.Arrow />
          <span className="grid gap-0.5">
            <span className="font-medium">{title}</span>
            <span>
              {event.detail ??
                (event.type === "deployment" ? event.state : "Restarted")}{" "}
              · {date}
            </span>
          </span>
        </Tooltip.Content>
      </Tooltip>
    </foreignObject>
  );
}
