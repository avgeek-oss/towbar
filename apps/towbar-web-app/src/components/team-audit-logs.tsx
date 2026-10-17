"use client";

import {
  TableCellStack,
  TableCellDescription,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import { useState } from "react";
import type { AuditEventIcon as AuditEventIconName } from "@workspace/towbar-web-client";
import { AuditEventIcon } from "./audit-event-icon";
import { UserAvatar as Avatar } from "@avgeek-oss/design-system/patterns/user-avatar";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { QueryError } from "@workspace/towbar-web-ui/query-state";
import type { ResourceTableColumn } from "@avgeek-oss/design-system/patterns/resource-table";
import { useApiQuery } from "@/hooks/use-api-query";
import { RelativeTime } from "./last-synced-time";
import {
  EventDetail,
  EventDetails,
  HistoryFilter,
  HistorySearch,
  HistoryTable,
  useEventHistory,
} from "./event-history";

type AuditEvent = {
  id: string;
  slug: string;
  label: string;
  icon: AuditEventIconName | null;
  targetType: string;
  targetId: string | null;
  actorKind: "session" | "personal-key" | "team-key" | "system" | null;
  actorUserId: string | null;
  actorKeyId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  metadata: Record<string, string | number | boolean | null>;
  requestId: string | null;
  createdAt: string;
};
const actorLabels = {
  session: "Session",
  "personal-key": "Personal API key",
  "team-key": "Team API key",
  system: "System",
};
function actorName(event: AuditEvent) {
  return (
    event.actorName ??
    (event.actorKind === "system"
      ? "System"
      : event.actorKind === "team-key"
        ? "Team API key"
        : "Deleted or unavailable user")
  );
}
export function TeamAuditLogs() {
  const history = useEventHistory<AuditEvent>("/v1/core/team/audit-logs");
  const filters = useApiQuery<{
    events: { slug: string; label: string; icon: AuditEventIconName }[];
    users: { id: string; name: string; email: string }[];
  }>("/v1/core/team/audit-logs/filters", 30_000);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [open, setOpen] = useState(false);
  const columns: ResourceTableColumn<AuditEvent>[] = [
    {
      key: "event",
      header: "Event",
      cell: (event) => (
        <div className="flex min-w-40 max-w-72 items-start gap-2 whitespace-normal">
          <span className="mt-0.5 shrink-0">
            <AuditEventIcon icon={event.icon} />
          </span>
          <TableCellStack as="div">
            <button
              type="button"
              className="cursor-pointer text-left underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-focus"
              aria-label={`View ${event.label.toLowerCase()} details`}
              onClick={() => {
                setSelected(event);
                setOpen(true);
              }}
            >
              {event.label}
            </button>
            <TableCellDescription className="[overflow-wrap:anywhere]">
              {event.slug}
            </TableCellDescription>
          </TableCellStack>
        </div>
      ),
    },
    {
      key: "target",
      header: "Target",
      cell: (event) => (
        <TableCellStack as="div" className="min-w-72">
          <span className="capitalize">
            {event.targetType === "source" ? "Repository" : event.targetType}
          </span>
          <TableCellDescription className="truncate font-mono">
            <TooltipText tooltip={event.targetId ?? undefined}>
              {event.targetId ?? "—"}
            </TooltipText>
          </TableCellDescription>
        </TableCellStack>
      ),
    },
    {
      key: "actor",
      header: "User",
      cell: (event) => (
        <div className="flex min-w-32 max-w-48 items-center gap-2 whitespace-normal">
          <Avatar
            email={event.actorEmail ?? ""}
            name={actorName(event)}
            size="sm"
            className="shrink-0"
            aria-hidden="true"
          />
          <TableCellStack as="div">
            <span className="break-words">{actorName(event)}</span>
            <TableCellDescription>
              {event.actorKind
                ? actorLabels[event.actorKind]
                : "Unrecorded actor"}
            </TableCellDescription>
          </TableCellStack>
        </div>
      ),
    },
    {
      key: "time",
      header: "Time",
      cell: (event) => (
        <RelativeTime value={event.createdAt} label="Recorded" />
      ),
    },
  ];
  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid items-end gap-4 xl:grid-cols-2">
        <div className="grid min-w-0 items-end gap-4 sm:grid-cols-2">
          <HistoryFilter
            label="Event types"
            searchPlaceholder="Search name or event slug"
            value={history.filters.event}
            options={(filters.data?.events ?? []).map((event) => ({
              id: event.slug,
              label: event.label,
              searchText: `${event.label} ${event.slug}`,
              icon: <AuditEventIcon icon={event.icon} />,
            }))}
            onChange={(value) => history.setFilter("event", value)}
          />
          <HistoryFilter
            label="Users"
            searchPlaceholder="Search name or email"
            value={history.filters.userId}
            options={(filters.data?.users ?? []).map((user) => ({
              id: user.id,
              label: `${user.name} (${user.email})`,
            }))}
            onChange={(value) => history.setFilter("userId", value)}
          />
        </div>
        <HistorySearch
          value={history.filters.search ?? ""}
          label="Search audit logs"
          placeholder="Event, user or ID"
          onSearch={(value) => history.setFilter("search", value)}
        />
      </div>
      {filters.error ? <QueryError message={filters.error} /> : null}
      <HistoryTable
        history={history}
        columns={columns}
        label="Audit logs"
        emptyDescription="Captured team activity will appear here."
      />
      <EventDetails
        open={open}
        onOpenChange={setOpen}
        title={selected?.label ?? "Audit event"}
      >
        {selected ? (
          <>
            <EventDetail label="Event slug" value={selected.slug} />
            <EventDetail label="Event ID" value={selected.id} copy />
            <EventDetail label="User" value={actorName(selected)} />
            <EventDetail label="Email" value={selected.actorEmail} />
            <EventDetail
              label="Actor type"
              value={
                selected.actorKind
                  ? actorLabels[selected.actorKind]
                  : "Unrecorded"
              }
            />
            <EventDetail label="User ID" value={selected.actorUserId} copy />
            {selected.actorKeyId ? (
              <EventDetail
                label="API key ID"
                value={selected.actorKeyId}
                copy
              />
            ) : null}
            <EventDetail label="Target type" value={selected.targetType} />
            <EventDetail label="Target ID" value={selected.targetId} copy />
            <EventDetail
              label="Recorded"
              value={
                <RelativeTime value={selected.createdAt} label="Recorded" />
              }
            />
            {selected.requestId ? (
              <EventDetail label="Request ID" value={selected.requestId} copy />
            ) : null}
            {Object.entries(selected.metadata).map(([key, value]) => (
              <EventDetail
                key={key}
                label={key
                  .replace(/([A-Z])/g, " $1")
                  .replace(/^./, (letter) => letter.toUpperCase())}
                value={
                  value === null
                    ? "—"
                    : typeof value === "boolean"
                      ? value
                        ? "Yes"
                        : "No"
                      : String(value)
                }
              />
            ))}
          </>
        ) : null}
      </EventDetails>
    </div>
  );
}
