import {
  logConditionGroupSchema,
  type LogRecord,
} from "@workspace/towbar-contracts";
import { type LogCondition, validLogColumnPath } from "./log-explorer-model";

export type LogJsonField = { path: string[]; value: unknown };

export function logJsonLines(value: unknown) {
  const code = JSON.stringify(value, null, 2);
  const fields = new Map<number, LogJsonField>();
  let line = 0;
  const visit = (value: unknown, path: string[]) => {
    if (path.length) fields.set(line, { path, value });
    line++;
    if (value === null || typeof value !== "object") return;
    const entries = Object.entries(value);
    if (!entries.length) return;
    for (const [key, child] of entries) visit(child, [...path, key]);
    line++;
  };
  visit(value, []);
  return { code, fields };
}

export function logJsonValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function logJsonCondition(
  record: LogRecord,
  field: LogJsonField,
  exclude = false,
): Omit<LogCondition, "id"> | null {
  let key = field.path[0];
  let value = field.value;
  if (key === "attributes" && field.path.length === 2) {
    key = `attribute:${field.path[1]}`;
  } else if (field.path.length !== 1) return null;
  if (key === "workloadName") {
    key = "workloadId";
    value = record.workloadId;
  }
  const absent =
    value === null || (value === "" && !key?.startsWith("attribute:"));
  const condition = {
    field: key,
    operator: absent
      ? exclude
        ? "exists"
        : "not_exists"
      : exclude
        ? "not_equals"
        : "equals",
    value: absent ? "" : value,
  };
  const parsed = logConditionGroupSchema.safeParse({
    match: "and",
    conditions: [condition],
  });
  return parsed.success ? (parsed.data.conditions[0] ?? null) : null;
}

export function logJsonColumnPath(field: LogJsonField) {
  const path = field.path.join(".");
  return validLogColumnPath(path) ? path : null;
}
