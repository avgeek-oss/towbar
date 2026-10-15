"use client";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import type { ReactNode } from "react";
import {
  TableCellDescription,
  tableCellStackClassName,
} from "@avgeek-oss/design-system/data-display/table-cell-text";
import { useSyncExternalStore } from "react";
import { usePageVisibilityInterval } from "@avgeek-oss/design-system/hooks/use-page-visibility-interval";
import { formatTableTime } from "@/lib/table-time";
import {
  subscribeLocalization,
  localizationRevision,
  serverLocalizationRevision,
} from "@/lib/date-time-display";

const listeners = new Set<() => void>();
let currentTime = Date.now();

export function RelativeTimeProvider({ children }: { children: ReactNode }) {
  usePageVisibilityInterval(updateClock, 30_000, {
    runImmediately: true,
    runOnVisible: true,
  });
  return children;
}

export function RelativeTime({
  display = "stacked",
  label,
  value,
}: {
  display?: "stacked" | "relative";
  label: string;
  value: string;
}) {
  useSyncExternalStore(
    subscribeLocalization,
    localizationRevision,
    serverLocalizationRevision,
  );
  const clockTick = useSyncExternalStore(
    subscribeToClock,
    getClockSnapshot,
    getServerClockSnapshot,
  );
  // A timestamp received between refresh ticks can be newer than the tick itself.
  const formatted = formatTableTime(value, clockTick ? Date.now() : 0);
  if (!formatted) return <span aria-label={`${label} unavailable`}>—</span>;

  if (display === "relative") {
    return (
      <time className="whitespace-nowrap tabular-nums" dateTime={value}>
        {formatted.relative ? `${label} ${formatted.relative}` : "—"}
      </time>
    );
  }

  return (
    <TooltipText
      as="time"
      tooltip={formatted.timezone}
      placement="left"
      aria-label={`${label}: ${formatted.absolute} ${formatted.timezone}${formatted.relative ? `, ${formatted.relative}` : ""}`}
      className={`${tableCellStackClassName} whitespace-nowrap tabular-nums`}
      dateTime={value}
    >
      <span aria-hidden={!formatted.relative}>
        {formatted.relative ?? "\u00a0"}
      </span>
      <TableCellDescription>{formatted.absolute}</TableCellDescription>
    </TooltipText>
  );
}

export function LastSyncedTime({ value }: { value: string }) {
  return <RelativeTime label="Last synced" value={value} />;
}

function subscribeToClock(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function updateClock() {
  currentTime = Date.now();
  for (const notify of listeners) notify();
}
function getClockSnapshot() {
  return currentTime;
}
function getServerClockSnapshot() {
  return 0;
}
