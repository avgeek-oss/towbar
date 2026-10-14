import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  type LogFilter,
  type LogQuery,
  type LogQueryResult,
  type LogRecord,
  logQuerySchema,
} from "@workspace/towbar-core";
import { getEnv } from "../../env.js";
import { HttpError, badRequest, notFound } from "../../http/errors.js";
import {
  currentLogSequence,
  logAccessRevision,
  logReadScope,
  retainLogCutoff,
} from "./policy.js";
import { type LogParameters, logStorage } from "./storage.js";

type ReadScope = Awaited<ReturnType<typeof logReadScope>>;
const cursorSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.uuid(),
    filterHash: z.string(),
    snapshotAt: z.iso.datetime(),
    issuedAt: z.number(),
    sequence: z.string().regex(/^\d+$/u).optional(),
    timestamp: z.string().min(1).max(64),
    eventId: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
type LogCursor = z.infer<typeof cursorSchema>;

export function encodeLogCursor(cursor: LogCursor, secret: string) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function decodeLogCursor(value: string, secret: string) {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw badRequest("Invalid log cursor");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(signature, "base64url");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    throw badRequest("Invalid log cursor");
  let cursor: LogCursor;
  try {
    cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    throw badRequest("Invalid log cursor");
  }
  if (
    Date.now() - cursor.issuedAt > 15 * 60000 ||
    cursor.issuedAt > Date.now() + 60000
  )
    throw new HttpError(
      409,
      "LOGS_CURSOR_EXPIRED",
      "The log cursor expired. Refresh the search to resume.",
    );
  return cursor;
}
const filterHash = (query: LogQuery) =>
  createHash("sha256")
    .update(
      JSON.stringify({ filters: query.filters, direction: query.direction }),
    )
    .digest("hex");

export function buildLogConditions(input: {
  workspaceId: string;
  filters: LogFilter;
  scope: ReadScope;
  retentionDays: number;
  snapshotAt: string;
  now: Date;
  retentionFloor?: Date;
  sequence?: string;
}) {
  const { workspaceId, filters, scope, retentionDays, snapshotAt, now } = input;
  const parameters: LogParameters = {
    workspaceId,
    from: filters.from,
    to: filters.to,
    snapshotAt,
    now: now.toISOString(),
    retentionFloor: (
      input.retentionFloor ?? new Date(now.getTime() - retentionDays * 86400000)
    ).toISOString(),
    knownIds: scope.knownIds,
    sequence: input.sequence ?? "18446744073709551615",
  };
  const conditions = [
    "workspaceId = {workspaceId:UUID}",
    "timestamp >= {from:DateTime64(9)}",
    "timestamp < {to:DateTime64(9)}",
    "timestamp >= {retentionFloor:DateTime64(9)}",
    "expiresAt > {now:DateTime64(3)}",
    "ingestedAt <= {snapshotAt:DateTime64(3)}",
    "ingestSequence <= {sequence:UInt64}",
    "workloadId IN {knownIds:Array(UUID)}",
  ];
  if (!scope.administrator) {
    parameters.restrictedIds = scope.restrictedIds;
    conditions.push(
      "visibility = 'all'",
      "workloadId NOT IN {restrictedIds:Array(UUID)}",
    );
  }
  const selections = [
    ["workloadIds", "workloadId", "UUID"],
    ["serverIds", "serverId", "UUID"],
    ["deploymentIds", "deploymentId", "UUID"],
    ["previewIds", "previewId", "UUID"],
    ["containerIds", "containerId", "String"],
    ["environments", "environment", "String"],
    ["services", "service", "String"],
    ["severities", "severity", "String"],
  ] as const;
  for (const [key, column, type] of selections)
    if (filters[key].length) {
      conditions.push(`${column} IN {${key}:Array(${type})}`);
      parameters[key] = filters[key];
    }
  if (filters.stream) {
    conditions.push("stream = {stream:String}");
    parameters.stream = filters.stream;
  }
  if (filters.traceId) {
    conditions.push("traceId = {traceId:String}");
    parameters.traceId = filters.traceId;
  }
  if (filters.search) {
    conditions.push(
      "(positionCaseInsensitiveUTF8(body, {search:String}) > 0 OR positionCaseInsensitiveUTF8(ifNull(traceId, ''), {search:String}) > 0 OR positionCaseInsensitiveUTF8(ifNull(spanId, ''), {search:String}) > 0)",
    );
    parameters.search = filters.search;
  }
  filters.attributes.forEach((filter, index) => {
    parameters[`key${index}`] = filter.key;
    parameters[`value${index}`] = filter.value;
    const value = `attributes[{key${index}:String}]`;
    conditions.push(
      filter.operator === "contains"
        ? `positionCaseInsensitiveUTF8(${value}, {value${index}:String}) > 0`
        : `mapContains(attributes, {key${index}:String}) AND ${value} = {value${index}:String}`,
    );
  });
  if (filters.conditionGroup) {
    const group = filters.conditionGroup.conditions.map((condition, index) => {
      const parameter = `conditionValue${index}`;
      parameters[parameter] = condition.value;
      if (condition.field.startsWith("attribute:")) {
        const key = `conditionKey${index}`;
        parameters[key] = condition.field.slice(10);
        const exists = `mapContains(attributes, {${key}:String})`;
        const value = `attributes[{${key}:String}]`;
        const query = `{${parameter}:String}`;
        switch (condition.operator) {
          case "exists":
            return exists;
          case "not_exists":
            return `NOT ${exists}`;
          case "equals":
            return `(${exists} AND ${value} = ${query})`;
          case "not_equals":
            return `(${exists} AND ${value} != ${query})`;
          case "contains":
            return `(${exists} AND positionCaseInsensitiveUTF8(${value}, ${query}) > 0)`;
          case "not_contains":
            return `(${exists} AND positionCaseInsensitiveUTF8(${value}, ${query}) = 0)`;
          case "starts_with":
            return `(${exists} AND startsWith(lowerUTF8(${value}), lowerUTF8(${query})))`;
          case "ends_with":
            return `(${exists} AND endsWith(lowerUTF8(${value}), lowerUTF8(${query})))`;
        }
      }
      const fields: Record<string, readonly [string, string]> = {
        serverId: ["serverId", "UUID"],
        workloadId: ["workloadId", "UUID"],
        deploymentId: ["deploymentId", "UUID"],
        previewId: ["previewId", "UUID"],
        containerId: ["containerId", "String"],
        service: ["service", "String"],
        stream: ["stream", "String"],
        traceId: ["traceId", "String"],
        spanId: ["spanId", "String"],
      };
      const field = fields[condition.field];
      if (!field) throw badRequest("Unknown log filter field");
      const exists =
        field[1] === "UUID"
          ? `isNotNull(${field[0]})`
          : `notEmpty(ifNull(${field[0]}, ''))`;
      if (condition.operator === "exists") return exists;
      if (condition.operator === "not_exists") return `NOT (${exists})`;
      const value = `ifNull(${field[0]}, '')`,
        query = `{${parameter}:String}`;
      switch (condition.operator) {
        case "contains":
          return `(${exists} AND positionCaseInsensitiveUTF8(${value}, ${query}) > 0)`;
        case "not_contains":
          return `(${exists} AND positionCaseInsensitiveUTF8(${value}, ${query}) = 0)`;
        case "starts_with":
          return `(${exists} AND startsWith(lowerUTF8(${value}), lowerUTF8(${query})))`;
        case "ends_with":
          return `(${exists} AND endsWith(lowerUTF8(${value}), lowerUTF8(${query})))`;
        default:
          return `${field[0]} ${condition.operator === "not_equals" ? "!=" : "="} {${parameter}:${field[1]}}`;
      }
    });
    conditions.push(
      `(${group.join(filters.conditionGroup.match === "or" ? " OR " : " AND ")})`,
    );
  }
  return { conditions, parameters };
}

function isoTimestamp(value: string) {
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}
export function normalizeLogRecord(row: LogRecord): LogRecord {
  return {
    ...row,
    timestamp: isoTimestamp(row.timestamp),
    ingestedAt: isoTimestamp(row.ingestedAt),
  };
}
const columns =
  "eventId, timestamp, ingestedAt, serverId, workloadId, workloadName, deploymentId, previewId, environment, containerId, service, severity, stream, body, attributes, traceId, spanId, truncated";

export async function queryLogs(
  workspaceId: string,
  input: LogQuery,
  signal?: AbortSignal,
): Promise<LogQueryResult> {
  const query = logQuerySchema.parse(input),
    now = new Date();
  const scope = await logReadScope(workspaceId),
    storage = logStorage();
  const hash = filterHash(query),
    secret = getEnv().TOWBAR_INTERNAL_HMAC_SECRET;
  const cursor = query.cursor ? decodeLogCursor(query.cursor, secret) : null;
  if (
    cursor &&
    (cursor.workspaceId !== workspaceId || cursor.filterHash !== hash)
  )
    throw badRequest("This log cursor belongs to a different search");
  const snapshotAt = cursor?.snapshotAt ?? now.toISOString();
  const sequence = cursor?.sequence ?? (await currentLogSequence(workspaceId));
  const { conditions, parameters } = buildLogConditions({
    workspaceId,
    filters: query.filters,
    scope,
    snapshotAt,
    sequence,
    now,
    retentionDays: storage.configuration.retentionDays,
    retentionFloor: await retainLogCutoff(
      workspaceId,
      storage.configuration.retentionDays,
      now,
    ),
  });
  if (cursor) {
    conditions.push(
      `(timestamp, eventId) ${query.direction === "older" ? "<" : ">"} ({cursorTimestamp:DateTime64(9)}, {cursorId:String})`,
    );
    parameters.cursorTimestamp = cursor.timestamp;
    parameters.cursorId = cursor.eventId;
  }
  parameters.limit = query.limit + 1;
  const order = query.direction === "older" ? "DESC" : "ASC";
  const rows = await storage.execute<LogRecord>(
    `SELECT ${columns} FROM log_records FINAL WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp ${order}, eventId ${order} LIMIT {limit:UInt32} FORMAT JSONEachRow`,
    parameters,
    { signal, readOnly: true },
  );
  let bytes = 0,
    partial = false;
  const records: LogRecord[] = [];
  for (const row of rows.slice(0, query.limit)) {
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > 1024 * 1024 && records.length) {
      partial = true;
      break;
    }
    records.push(normalizeLogRecord(row));
  }
  const hasMore = rows.length > records.length,
    last = records.at(-1);
  return {
    records,
    accessRevision: logAccessRevision(scope),
    followCursor: encodeLogCursor(
      {
        version: 1,
        workspaceId,
        filterHash: createHash("sha256")
          .update(JSON.stringify(query.filters))
          .digest("hex"),
        snapshotAt,
        sequence,
        issuedAt: now.getTime(),
        timestamp: snapshotAt,
        eventId: "f".repeat(64),
      },
      secret,
    ),
    hasMore,
    partial,
    snapshotAt,
    nextCursor:
      hasMore && last
        ? encodeLogCursor(
            {
              version: 1,
              workspaceId,
              filterHash: hash,
              snapshotAt,
              sequence,
              issuedAt: cursor?.issuedAt ?? now.getTime(),
              timestamp: last.timestamp,
              eventId: last.eventId,
            },
            secret,
          )
        : null,
  };
}

export async function summarizeLogs(
  workspaceId: string,
  filters: LogFilter,
  signal?: AbortSignal,
) {
  const scope = await logReadScope(workspaceId),
    storage = logStorage(),
    now = new Date();
  const { conditions, parameters } = buildLogConditions({
    workspaceId,
    filters,
    scope,
    snapshotAt: now.toISOString(),
    sequence: await currentLogSequence(workspaceId),
    now,
    retentionDays: storage.configuration.retentionDays,
    retentionFloor: await retainLogCutoff(
      workspaceId,
      storage.configuration.retentionDays,
      now,
    ),
  });
  const buckets = await storage.execute<{
    at: string;
    severity: string;
    count: string;
  }>(
    `SELECT toStartOfInterval(timestamp, INTERVAL {bucket:UInt32} SECOND) AS at, severity, count() AS count
     FROM log_records FINAL WHERE ${conditions.join(" AND ")}
     GROUP BY at, severity ORDER BY at LIMIT 3500 FORMAT JSONEachRow`,
    {
      ...parameters,
      bucket: Math.max(
        60,
        Math.ceil(
          (Date.parse(filters.to) - Date.parse(filters.from)) / 1000 / 500,
        ),
      ),
    },
    { signal, readOnly: true },
  );
  const facetColumns = [
    "workloadId",
    "serverId",
    "deploymentId",
    "previewId",
    "containerId",
    "service",
  ] as const;
  const facetRows = await Promise.all(
    facetColumns.map(async (field) => {
      const rows = await storage.execute<{
        id: string;
        name: string;
        count: string;
      }>(
        `SELECT toString(${field}) AS id, ${field === "workloadId" ? "any(workloadName)" : `toString(${field})`} AS name, count() AS count
       FROM log_records FINAL WHERE ${conditions.join(" AND ")} AND ${field} IS NOT NULL AND toString(${field}) != ''
       GROUP BY ${field} ORDER BY count DESC LIMIT 100 FORMAT JSONEachRow`,
        parameters,
        { signal, readOnly: true },
      );
      return [
        field,
        rows.map((row) => ({ ...row, count: Number(row.count) })),
      ] as const;
    }),
  );
  const keys = await storage.execute<{ key: string }>(
    `SELECT DISTINCT arrayJoin(mapKeys(attributes)) AS key FROM log_records FINAL WHERE ${conditions.join(" AND ")} ORDER BY key LIMIT 256 FORMAT JSONEachRow`,
    parameters,
    { signal, readOnly: true },
  );
  return {
    attributeKeys: keys.map(({ key }) => key),
    facets: Object.fromEntries(facetRows),
    buckets: buckets.map((b) => ({
      at: isoTimestamp(b.at),
      severity: b.severity,
      count: Number(b.count),
    })),
    partial: buckets.length === 3500 || keys.length === 256,
  };
}

export async function logContext(
  workspaceId: string,
  input: {
    workloadId: string;
    timestamp: string;
    eventId: string;
    limit: number;
  },
  signal?: AbortSignal,
) {
  const at = Date.parse(input.timestamp),
    now = new Date(),
    storage = logStorage();
  const scope = await logReadScope(workspaceId);
  const filters = logQuerySchema.parse({
    filters: {
      from: new Date(at - 5 * 60000).toISOString(),
      to: new Date(at + 5 * 60000).toISOString(),
      workloadIds: [input.workloadId],
    },
  }).filters;
  const { conditions, parameters } = buildLogConditions({
    workspaceId,
    filters,
    scope,
    retentionDays: storage.configuration.retentionDays,
    snapshotAt: now.toISOString(),
    now,
    sequence: await currentLogSequence(workspaceId),
    retentionFloor: await retainLogCutoff(
      workspaceId,
      storage.configuration.retentionDays,
      now,
    ),
  });
  const [anchor] = await storage.execute<LogRecord>(
    `SELECT ${columns} FROM log_records FINAL WHERE ${conditions.join(" AND ")}
    AND eventId = {eventId:String} AND timestamp = {contextTimestamp:DateTime64(9)} LIMIT 1 FORMAT JSONEachRow`,
    {
      ...parameters,
      eventId: input.eventId,
      contextTimestamp: input.timestamp,
    },
    { signal, readOnly: true },
  );
  if (!anchor) throw notFound("Log record");
  const neighbors = await Promise.all(
    ["before", "after"].map((side) =>
      storage.execute<LogRecord>(
        `SELECT ${columns} FROM log_records FINAL WHERE ${conditions.join(" AND ")}
      AND containerId = {containerId:String}
      AND (timestamp, eventId) ${side === "before" ? "<" : ">"} ({contextTimestamp:DateTime64(9)}, {eventId:String})
      ORDER BY timestamp ${side === "before" ? "DESC" : "ASC"}, eventId ${side === "before" ? "DESC" : "ASC"}
      LIMIT {limit:UInt32} FORMAT JSONEachRow`,
        {
          ...parameters,
          containerId: anchor.containerId,
          contextTimestamp: input.timestamp,
          eventId: input.eventId,
          limit: input.limit,
        },
        { signal, readOnly: true },
      ),
    ),
  );
  return {
    records: [...neighbors[0]!.reverse(), anchor, ...neighbors[1]!].map(
      normalizeLogRecord,
    ),
    partial: false,
  };
}

export async function tailLogPage(
  workspaceId: string,
  filters: LogFilter,
  value: string | undefined,
  signal?: AbortSignal,
) {
  const now = new Date(),
    storage = logStorage(),
    scope = await logReadScope(workspaceId);
  const secret = getEnv().TOWBAR_INTERNAL_HMAC_SECRET;
  const hash = createHash("sha256")
    .update(JSON.stringify(filters))
    .digest("hex");
  const previous = value ? decodeLogCursor(value, secret) : null;
  if (
    previous &&
    (previous.workspaceId !== workspaceId || previous.filterHash !== hash)
  )
    throw badRequest("This tail cursor belongs to another search");
  const committed = await currentLogSequence(workspaceId);
  const lastSequence = previous?.sequence ?? committed,
    lastId = previous?.eventId ?? "f".repeat(64);
  const { conditions, parameters } = buildLogConditions({
    workspaceId,
    filters: {
      ...filters,
      to: new Date(
        Math.max(Date.parse(filters.to), now.getTime() + 120000),
      ).toISOString(),
    },
    scope,
    retentionDays: storage.configuration.retentionDays,
    snapshotAt: now.toISOString(),
    now,
    sequence: committed,
    retentionFloor: await retainLogCutoff(
      workspaceId,
      storage.configuration.retentionDays,
      now,
    ),
  });
  const rows = await storage.execute<LogRecord & { ingestSequence: string }>(
    `SELECT ${columns}, ingestSequence FROM log_records FINAL
    WHERE ${conditions.join(" AND ")} AND (ingestSequence, eventId) > ({lastSequence:UInt64}, {lastId:String})
    ORDER BY ingestSequence, eventId LIMIT 201 FORMAT JSONEachRow`,
    { ...parameters, lastSequence, lastId },
    { signal, readOnly: true },
  );
  const selected: typeof rows = [];
  let bytes = 0;
  for (const row of rows.slice(0, 200)) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (selected.length && bytes + size > 1024 * 1024) break;
    bytes += size;
    selected.push(row);
  }
  const last = selected.at(-1);
  const nextCursor = encodeLogCursor(
    {
      version: 1,
      workspaceId,
      filterHash: hash,
      snapshotAt: now.toISOString(),
      issuedAt: previous?.issuedAt ?? now.getTime(),
      timestamp: now.toISOString(),
      sequence: last ? String(last.ingestSequence) : committed,
      eventId: last?.eventId ?? "f".repeat(64),
    },
    secret,
  );
  return {
    records: selected.map(({ ingestSequence: _sequence, ...record }) =>
      normalizeLogRecord(record),
    ),
    nextCursor,
    accessRevision: logAccessRevision(scope),
    hasMore: rows.length > selected.length,
    partial: selected.length < Math.min(rows.length, 200),
  };
}
