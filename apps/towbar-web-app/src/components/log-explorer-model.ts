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
  debug: "var(--log-debug)",
  info: "var(--log-info)",
  warn: "var(--log-warn)",
  error: "var(--log-error)",
  fatal: "var(--log-fatal)",
  unknown: "var(--muted)",
};
export const logLevelBackgrounds = {
  warn: "var(--log-warn-row)",
  error: "var(--log-error-row)",
  fatal: "var(--log-fatal-row)",
};
export const logColumns = [
  { id: "timestamp", title: "Time", width: 215 },
  { id: "severity", title: "Level", width: 88 },
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
  operator: NonNullable<
    LogFilter["conditionGroup"]
  >["conditions"][number]["operator"];
  value: string;
};
export const logMatchOptions: {
  id: LogCondition["operator"];
  label: string;
}[] = [
  { id: "equals", label: "Equals" },
  { id: "not_equals", label: "Does not equal" },
  { id: "contains", label: "Contains" },
  { id: "not_contains", label: "Does not contain" },
  { id: "starts_with", label: "Starts with" },
  { id: "ends_with", label: "Ends with" },
  { id: "exists", label: "Exists" },
  { id: "not_exists", label: "Does not exist" },
];
export function logMatchNeedsValue(operator: LogCondition["operator"]) {
  return operator !== "exists" && operator !== "not_exists";
}
export function conditionFilters(
  conditions: LogCondition[],
  match: "and" | "or" = "and",
): Partial<LogFilter> {
  return conditions.length
    ? {
        conditionGroup: {
          match,
          conditions: conditions.map(({ field, operator, value }) => ({
            field,
            operator,
            value,
          })),
        },
      }
    : {};
}
export type CustomLogColumn = {
  id: string;
  title: string;
  path: string;
  width: number;
};
export function validLogColumnPath(path: string) {
  const parts = path.split(".");
  return (
    path.length > 0 &&
    path.length <= 256 &&
    parts.every(
      (part) =>
        /^(?:[A-Za-z_$][\w$-]*|\d+)$/u.test(part) &&
        !["__proto__", "prototype", "constructor"].includes(part),
    )
  );
}
function parsedValue(value: unknown): unknown {
  if (
    typeof value !== "string" ||
    !(value.trim().startsWith("{") || value.trim().startsWith("["))
  )
    return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function readPath(value: unknown, parts: string[]): unknown {
  let current = parsedValue(value);
  for (let index = 0; index < parts.length; index++) {
    current = parsedValue(current);
    if (current === null || typeof current !== "object") return undefined;
    const remaining = parts.slice(index).join(".");
    if (Object.hasOwn(current, remaining))
      return Reflect.get(current, remaining);
    const part = parts[index]!;
    if (!Object.hasOwn(current, part)) return undefined;
    current = Reflect.get(current, part);
  }
  return current;
}
export function logColumnPaths(records: readonly LogRecord[]): string[] {
  const paths = new Set(logColumns.map(({ id }) => id));
  const visit = (value: unknown, prefix = "", depth = 0) => {
    if (depth >= 8 || paths.size >= 1000) return;
    const parsed = parsedValue(value);
    if (parsed === null || typeof parsed !== "object") return;
    for (const [key, child] of Object.entries(parsed)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!validLogColumnPath(path)) continue;
      paths.add(path);
      visit(child, path, depth + 1);
      if (paths.size >= 1000) break;
    }
  };
  for (const record of records) {
    visit(record);
    visit(record.attributes);
    visit(record.body);
  }
  return [...paths].sort();
}
export function logColumnValue(record: LogRecord, path: string): string {
  if (!validLogColumnPath(path)) return "";
  const parts = path.split(".");
  const value =
    readPath(record, parts) ??
    readPath(record.attributes, parts) ??
    readPath(record.body, parts);
  return value === undefined || value === null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
export function reorderLogColumns(order: string[], from: string, to: string) {
  const next = [...order],
    start = next.indexOf(from),
    end = next.indexOf(to);
  if (start < 0 || end < 0 || start === end) return order;
  next.splice(start, 1);
  next.splice(end, 0, from);
  return next;
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
  return (
    displayDate(from) === displayDate(to)
      ? `${displayDate(from)} · ${logTimeWithSeconds(from)} – ${logTimeWithSeconds(to)}`
      : `${logDateTime(from)} – ${logDateTime(to)}`
  ).replace(/(\d{1,2}:\d{2}):\d{2}/gu, "$1");
}
export function logAxisLabel(value: string | number, from: string, to: string) {
  const duration = Date.parse(to) - Date.parse(from);
  const label =
    duration > 86400000 ? logDateTime(value) : logTimeWithSeconds(value);
  return duration < 1800000
    ? label
    : label.replace(/(\d{1,2}:\d{2}):\d{2}/gu, "$1");
}
