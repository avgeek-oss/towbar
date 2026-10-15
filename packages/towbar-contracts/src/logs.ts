import { z } from "zod";

export function validLogColumnPath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 256 &&
    path
      .split(".")
      .every(
        (part) =>
          /^(?:[A-Za-z_$][\w$-]*|\d+)$/u.test(part) &&
          !["__proto__", "prototype", "constructor"].includes(part),
      )
  );
}
const logTableColumnId = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (id) =>
      [
        "timestamp",
        "severity",
        "workloadName",
        "environment",
        "body",
        "serverId",
        "service",
        "deploymentId",
        "previewId",
        "containerId",
        "stream",
        "traceId",
        "spanId",
      ].includes(id) || /^(?:attribute|custom):[^\p{Cc}]+$/u.test(id),
  );
export const logColumnWidthSchema = z.number().int().min(64).max(2400);
export const customLogColumnSchema = z
  .object({
    id: logTableColumnId.refine((id) => id.startsWith("custom:")),
    title: z.string().trim().min(1).max(256),
    path: z.string().refine(validLogColumnPath, "Enter a valid field path"),
    width: logColumnWidthSchema,
  })
  .strict();
export const logTablePreferencesSchema = z
  .object({
    visibleColumns: z.array(logTableColumnId).min(1).max(100),
    columnWidths: z
      .record(logTableColumnId, logColumnWidthSchema)
      .refine(
        (widths) => Object.keys(widths).length <= 200,
        "Too many column widths",
      ),
    customColumns: z.array(customLogColumnSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const customIds = new Set(value.customColumns.map(({ id }) => id));
    if (
      customIds.size !== value.customColumns.length ||
      new Set(value.visibleColumns).size !== value.visibleColumns.length
    )
      context.addIssue({ code: "custom", message: "Columns must be unique" });
    for (const id of [
      ...value.visibleColumns,
      ...Object.keys(value.columnWidths),
    ])
      if (id.startsWith("custom:") && !customIds.has(id))
        context.addIssue({
          code: "custom",
          message: "Custom column definition is missing",
        });
  });
export type LogTablePreferences = z.infer<typeof logTablePreferencesSchema>;
export type CustomLogColumn = z.infer<typeof customLogColumnSchema>;

export const logPolicySchema = z
  .object({ restrict: z.literal("admin") })
  .strict();
export type LogPolicy = z.infer<typeof logPolicySchema>;

const identifier = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u);
export const logStorageConfigurationSchema = z
  .object({
    retentionDays: z.number().int().min(1).max(365).default(7),
    clickhouse: z
      .object({
        endpoint: z.url().refine((value) => {
          const url = new URL(value);
          return (
            ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === "/"
          );
        }, "Use an HTTP(S) origin without credentials, path, query, or fragment"),
        database: identifier,
        username: z.string().min(1).max(128),
        password: z.string().min(1).max(4096),
      })
      .strict(),
  })
  .strict();
export type LogStorageConfiguration = z.infer<
  typeof logStorageConfigurationSchema
>;

const conditionFields = [
  "serverId",
  "workloadId",
  "deploymentId",
  "previewId",
  "containerId",
  "service",
  "stream",
  "traceId",
  "spanId",
] as const;
const logConditionSchema = z
  .object({
    field: z.union([
      z.enum(conditionFields),
      z.string().regex(/^attribute:.{1,128}$/u),
    ]),
    operator: z.enum([
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "starts_with",
      "ends_with",
      "exists",
      "not_exists",
    ]),
    value: z.string().max(512),
  })
  .strict()
  .superRefine((condition, context) => {
    if (
      ["exists", "not_exists"].includes(condition.operator) ||
      condition.field.startsWith("attribute:")
    )
      return;
    const field = condition.field;
    const textMatch = [
      "contains",
      "not_contains",
      "starts_with",
      "ends_with",
    ].includes(condition.operator);
    if (
      textMatch &&
      ["service", "containerId", "traceId", "spanId"].includes(field)
    ) {
      const maximum =
        field === "containerId"
          ? 64
          : field === "traceId"
            ? 32
            : field === "spanId"
              ? 16
              : 128;
      if (
        condition.value.length > 0 &&
        condition.value.length <= maximum &&
        (field === "service" || /^[a-f0-9]+$/u.test(condition.value))
      )
        return;
    }
    const valid =
      field.endsWith("Id") &&
      !["containerId", "traceId", "spanId"].includes(field)
        ? z.uuid().safeParse(condition.value).success
        : field === "containerId"
          ? /^[a-f0-9]{64}$/u.test(condition.value)
          : field === "traceId"
            ? /^[a-f0-9]{32}$/u.test(condition.value)
            : field === "spanId"
              ? /^[a-f0-9]{16}$/u.test(condition.value)
              : field === "stream"
                ? ["stdout", "stderr"].includes(condition.value)
                : condition.value.length > 0 && condition.value.length <= 128;
    if (!valid || !["equals", "not_equals"].includes(condition.operator))
      context.addIssue({
        code: "custom",
        message: `Use a valid ${field} with Equals or Does not equal`,
        path: ["value"],
      });
  });
export const logConditionGroupSchema = z
  .object({
    match: z.enum(["and", "or"]),
    conditions: z.array(logConditionSchema).min(1).max(8),
  })
  .strict();

const ids = z.array(z.uuid()).max(50).default([]);
export const logFilterSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    workloadIds: ids,
    serverIds: ids,
    deploymentIds: ids,
    previewIds: ids,
    containerIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .max(50)
      .default([]),
    environments: z
      .array(z.enum(["production", "preview"]))
      .max(2)
      .default([]),
    services: z.array(z.string().min(1).max(128)).max(50).default([]),
    severities: z
      .array(
        z.enum(["trace", "debug", "info", "warn", "error", "fatal", "unknown"]),
      )
      .max(7)
      .default([]),
    stream: z.enum(["stdout", "stderr"]).optional(),
    search: z.string().max(512).default(""),
    traceId: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .optional(),
    conditionGroup: logConditionGroupSchema.optional(),
    attributes: z
      .array(
        z
          .object({
            key: z.string().min(1).max(128),
            value: z.string().max(512),
            operator: z.enum(["equals", "contains"]).default("equals"),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict()
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), {
    message: "The start must precede the end",
    path: ["to"],
  })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= 31 * 86400000, {
    message: "Query at most 31 days at once",
    path: ["from"],
  });
export type LogFilter = z.infer<typeof logFilterSchema>;
export const logQuerySchema = z
  .object({
    filters: logFilterSchema,
    limit: z.number().int().min(1).max(500).default(50),
    cursor: z.string().max(8192).optional(),
    direction: z.enum(["older", "newer"]).default("older"),
  })
  .strict();
export type LogQuery = z.infer<typeof logQuerySchema>;
export const logTailSchema = z
  .object({
    filters: logFilterSchema,
    cursor: z.string().max(8192).optional(),
  })
  .strict();
export const logContextSchema = z
  .object({
    eventId: z.string().regex(/^[a-f0-9]{64}$/u),
    timestamp: z.iso.datetime(),
    workloadId: z.uuid(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export const logCollectionRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const logRecordSchema = z.object({
  eventId: z.string().regex(/^[a-f0-9]{64}$/u),
  timestamp: z.string(),
  ingestedAt: z.string(),
  serverId: z.uuid(),
  workloadId: z.uuid(),
  workloadName: z.string(),
  deploymentId: z.uuid().nullable(),
  previewId: z.uuid().nullable(),
  environment: z.enum(["production", "preview"]),
  containerId: z.string(),
  service: z.string(),
  severity: z.enum([
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
    "unknown",
  ]),
  stream: z.enum(["stdout", "stderr"]),
  body: z.string(),
  attributes: z.record(z.string(), z.string()),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  truncated: z.boolean(),
});
export type LogRecord = z.infer<typeof logRecordSchema>;

export const logQueryResultSchema = z.object({
  accessRevision: z.string(),
  followCursor: z.string(),
  records: z.array(logRecordSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  partial: z.boolean(),
  snapshotAt: z.string(),
});
export type LogQueryResult = z.infer<typeof logQueryResultSchema>;
export const logStorageStatusSchema = z.object({
  state: z.enum(["not_configured", "ready", "unavailable"]),
  reason: z.string().nullable(),
  code: z.string().nullable(),
  retentionDays: z.number().nullable(),
  checkedAt: z.string(),
  documentationUrl: z.string(),
});
export const logCollectionStatusSchema = z.object({
  serverId: z.uuid(),
  desiredState: z.enum(["enabled", "disabled"]),
  status: z.enum([
    "disabled",
    "queued",
    "installing",
    "waiting",
    "collecting",
    "offline",
    "backlogged",
    "failed",
  ]),
  generation: z.uuid().nullable(),
  version: z.string().nullable(),
  lastReportAt: z.string().nullable(),
  lastIngestedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  supportedContainers: z.number(),
  unsupportedContainers: z.number(),
  queueBytes: z.number(),
  droppedRecords: z.number(),
});

export type LogStorageStatus = z.infer<typeof logStorageStatusSchema>;
export type LogCollectionStatus = z.infer<typeof logCollectionStatusSchema>;
export function logBucketSeconds(from: string, to: string) {
  const duration = Date.parse(to) - Date.parse(from);
  return duration <= 3600000
    ? 30
    : Math.max(60, Math.ceil(duration / 1000 / 500));
}

export type LogSummary = {
  attributeKeys?: string[];
  buckets: { at: string; severity: string; count: number }[];
  facets: Record<string, { id: string; name: string; count: number }[]>;
  partial: boolean;
};
