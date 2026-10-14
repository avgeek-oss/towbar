import type { LogFilter, LogRecord } from "@workspace/towbar-web-client";
import {
  dateTimeLabel,
  displayDate,
  displayTime,
} from "../lib/date-time-display";

export const logLevels = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "unknown",
] as const;
export const logLevelColors: Record<LogRecord["severity"], string> = {
  trace: "var(--muted)",
  debug: "var(--color-violet-500)",
  info: "var(--color-blue-500)",
  warn: "var(--warning)",
  error: "var(--danger)",
  fatal: "var(--color-red-800)",
  unknown: "var(--muted)",
};
export const logColumns = [
  { id: "timestamp", title: "Time", width: 215 },
  { id: "severity", title: "Level", width: 100 },
  { id: "workloadName", title: "Workload", width: 200 },
  { id: "environment", title: "Environment", width: 120 },
  { id: "body", title: "Message", width: 800 },
  { id: "serverId", title: "Server", width: 190 },
  { id: "service", title: "Compose service", width: 170 },
  { id: "deploymentId", title: "Deployment", width: 220 },
  { id: "previewId", title: "Preview", width: 220 },
  { id: "containerId", title: "Container", width: 240 },
  { id: "stream", title: "Output stream", width: 125 },
  { id: "traceId", title: "Trace ID", width: 260 },
  { id: "spanId", title: "Span ID", width: 170 },
];
export const defaultLogColumns = logColumns.slice(0, 5).map(({ id }) => id);
export const builtInLogFields = logColumns.filter(
  ({ id }) =>
    ![
      "timestamp",
      "body",
      "workloadName",
      "environment",
      "severity",
      "spanId",
      "traceId",
      "serverId",
    ].includes(id),
);
export type LogCondition = {
  id: string;
  field: string;
  operator: "equals" | "contains";
  value: string;
};
export function conditionFilters(
  conditions: LogCondition[],
): Partial<LogFilter> {
  const attributes: LogFilter["attributes"] = [];
  const result: Partial<LogFilter> = { attributes };
  for (const condition of conditions) {
    if (condition.field.startsWith("attribute:")) {
      attributes.push({
        key: condition.field.slice(10),
        value: condition.value,
        operator: condition.operator,
      });
      continue;
    }
    switch (condition.field) {
      case "serverId":
        result.serverIds = [condition.value];
        break;
      case "deploymentId":
        result.deploymentIds = [condition.value];
        break;
      case "previewId":
        result.previewIds = [condition.value];
        break;
      case "containerId":
        result.containerIds = [condition.value];
        break;
      case "service":
        result.services = [condition.value];
        break;
      case "stream":
        result.stream = condition.value as LogFilter["stream"];
        break;
      case "traceId":
        result.traceId = condition.value;
        break;
    }
  }
  return result;
}
export function logTimeWithSeconds(value: string | number) {
  const time = displayTime(value);
  if (time === "—" || /\d:\d{2}:\d{2}/u.test(time)) return time;
  const seconds = new Date(value).getUTCSeconds().toString().padStart(2, "0");
  return time.replace(/(\d{1,2}:\d{2})/u, `$1:${seconds}`);
}
export function logDateTime(value: string | number) {
  const localized = dateTimeLabel(value);
  return localized?.dateTime && localized.time
    ? localized.dateTime.replace(localized.time, logTimeWithSeconds(value))
    : "—";
}
export function logRangeLabel(from: string, to: string) {
  return displayDate(from) === displayDate(to)
    ? `${displayDate(from)} · ${logTimeWithSeconds(from)} – ${logTimeWithSeconds(to)}`
    : `${logDateTime(from)} – ${logDateTime(to)}`;
}
