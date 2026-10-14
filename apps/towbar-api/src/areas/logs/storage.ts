import { createHash } from "node:crypto";
import type { LogStorageConfiguration } from "@workspace/towbar-core";
import { HttpError } from "../../http/errors.js";
import { requireLogConfiguration } from "./configuration.js";

type Parameter = string | number | boolean | readonly string[];
export type LogParameters = Record<string, Parameter>;
const timestampParameters = new Set([
  "from",
  "to",
  "snapshotAt",
  "now",
  "retentionFloor",
  "cursorTimestamp",
  "contextTimestamp",
]);

export class LogStorage {
  constructor(readonly configuration: LogStorageConfiguration) {}

  async execute<T = Record<string, unknown>>(
    statement: string,
    parameters: LogParameters = {},
    options: {
      signal?: AbortSignal;
      data?: string;
      readOnly?: boolean;
    } = {},
  ): Promise<T[]> {
    const url = new URL(this.configuration.clickhouse.endpoint);
    url.searchParams.set("default_format", "JSONEachRow");
    url.searchParams.set("database", this.configuration.clickhouse.database);
    url.searchParams.set("max_execution_time", "10");
    url.searchParams.set("max_memory_usage", "268435456");
    url.searchParams.set("max_result_bytes", "8388608");
    url.searchParams.set("result_overflow_mode", "throw");
    url.searchParams.set("date_time_input_format", "best_effort");
    if (options.readOnly) url.searchParams.set("readonly", "1");
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(
        `param_${key}`,
        Array.isArray(value)
          ? `[${value.map((v) => `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(",")}]`
          : timestampParameters.has(key)
            ? String(value).replace("T", " ").replace(/Z$/u, "")
            : String(value),
      );
    }
    const { username, password } = this.configuration.clickhouse;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "X-ClickHouse-User": username,
          "X-ClickHouse-Key": password,
        },
        body: options.data ? `${statement}\n${options.data}` : statement,
        signal: AbortSignal.any([
          AbortSignal.timeout(12000),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new HttpError(
        503,
        "LOGS_CONNECTION_FAILED",
        "Could not reach ClickHouse. Check the endpoint, DNS, TLS certificate, and network access.",
      );
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader)
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new HttpError(
            422,
            "LOGS_QUERY_LIMIT",
            "This log query exceeded its result budget. Narrow the filters or time range.",
          );
        }
        chunks.push(chunk.value);
      }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!response.ok) throw logStorageError(response.status, text);
    if (!text.trim()) return [];
    try {
      return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as T);
    } catch {
      throw new HttpError(
        503,
        "LOGS_STORAGE_RESPONSE",
        "ClickHouse returned an invalid logging response.",
      );
    }
  }
}

export function logStorage() {
  return new LogStorage(requireLogConfiguration());
}

export const logTableSchema = `CREATE TABLE IF NOT EXISTS log_records (
  workspaceId UUID,
  eventId FixedString(64),
  timestamp DateTime64(9, 'UTC'),
  observedAt DateTime64(3, 'UTC'),
  ingestedAt DateTime64(3, 'UTC'),
  expiresAt DateTime64(3, 'UTC'),
  serverId UUID,
  workloadId UUID,
  workloadName String,
  deploymentId Nullable(UUID),
  previewId Nullable(UUID),
  environment LowCardinality(String),
  containerId FixedString(64),
  service LowCardinality(String),
  stream LowCardinality(String),
  severity LowCardinality(String),
  body String CODEC(ZSTD(3)),
  attributes Map(String, String),
  traceId Nullable(String),
  spanId Nullable(String),
  visibility Enum8('all' = 0, 'admin' = 1),
  truncated Bool,
  schemaVersion UInt16 DEFAULT 1,
  ingestSequence UInt64 DEFAULT 0,
  dedupVersion UInt64 DEFAULT 18446744073709551615,
  INDEX body_tokens body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4
) ENGINE = ReplacingMergeTree(dedupVersion)
PARTITION BY toDate(timestamp)
ORDER BY (workspaceId, workloadId, timestamp, eventId)
TTL expiresAt DELETE
SETTINGS index_granularity = 8192`;

let schemaCache:
  { key: string; until: number; promise: Promise<void> } | undefined;
export async function ensureLogSchema(storage = logStorage()) {
  const key = createHash("sha256")
    .update(JSON.stringify(storage.configuration))
    .digest("hex");
  if (
    !schemaCache ||
    schemaCache.key !== key ||
    schemaCache.until < Date.now()
  ) {
    const promise = storage.execute(logTableSchema).then(async () => {
      const [grant] = await storage.execute<{ result: number }>(
        `CHECK GRANT SELECT, INSERT, CREATE TABLE, ALTER ON ${storage.configuration.clickhouse.database}.log_records`,
      );
      if (Number(grant?.result) !== 1)
        throw new HttpError(
          503,
          "LOGS_PERMISSION_DENIED",
          "The ClickHouse account needs SELECT, INSERT, CREATE TABLE, and ALTER privileges in the configured database.",
        );
      const description = await storage.execute<{
        name: string;
        type: string;
        default_expression: string;
      }>(
        "DESCRIBE TABLE log_records FORMAT JSONEachRow",
        {},
        { readOnly: true },
      );
      const [definition] = await storage.execute<{ statement: string }>(
        "SHOW CREATE TABLE log_records FORMAT JSONEachRow",
        {},
        { readOnly: true },
      );
      assertLogSchema(description, definition?.statement ?? "");
    });
    const current = { key, until: Date.now() + 60000, promise };
    schemaCache = current;
    promise.catch(() => {
      if (schemaCache === current) schemaCache = undefined;
    });
  }
  await schemaCache.promise;
}

function logStorageError(status: number, text: string) {
  const code = /Code:\s*(\d+)/u.exec(text)?.[1];
  if (status === 401 || code === "516")
    return new HttpError(
      503,
      "LOGS_AUTHENTICATION_FAILED",
      "ClickHouse rejected the configured username or password.",
    );
  if (status === 403 || code === "497")
    return new HttpError(
      503,
      "LOGS_PERMISSION_DENIED",
      "The ClickHouse account needs SELECT, INSERT, CREATE TABLE, and ALTER privileges in the configured database.",
    );
  if (code === "81")
    return new HttpError(
      503,
      "LOGS_DATABASE_MISSING",
      "The configured ClickHouse database does not exist.",
    );
  if (["159", "241", "396"].includes(code ?? ""))
    return new HttpError(
      422,
      "LOGS_QUERY_LIMIT",
      "ClickHouse reached the query time or memory limit. Narrow the filters or time range.",
    );
  return new HttpError(
    503,
    "LOGS_STORAGE_ERROR",
    "ClickHouse could not complete the logging operation. Check database compatibility and schema permissions.",
  );
}

export function assertLogSchema(
  columns: { name: string; type: string; default_expression: string }[],
  statement: string,
) {
  const expected: Record<string, string> = {
    workspaceId: "UUID",
    eventId: "FixedString(64)",
    timestamp: "DateTime64(9, 'UTC')",
    observedAt: "DateTime64(3, 'UTC')",
    ingestedAt: "DateTime64(3, 'UTC')",
    expiresAt: "DateTime64(3, 'UTC')",
    serverId: "UUID",
    workloadId: "UUID",
    workloadName: "String",
    deploymentId: "Nullable(UUID)",
    previewId: "Nullable(UUID)",
    environment: "LowCardinality(String)",
    containerId: "FixedString(64)",
    service: "LowCardinality(String)",
    stream: "LowCardinality(String)",
    severity: "LowCardinality(String)",
    body: "String",
    attributes: "Map(String, String)",
    traceId: "Nullable(String)",
    spanId: "Nullable(String)",
    visibility: "Enum8('all' = 0, 'admin' = 1)",
    truncated: "Bool",
    schemaVersion: "UInt16",
    ingestSequence: "UInt64",
    dedupVersion: "UInt64",
  };
  const table = new Map(columns.map((column) => [column.name, column]));
  const compatible =
    Object.entries(expected).every(
      ([name, type]) => table.get(name)?.type === type,
    ) &&
    table.get("schemaVersion")?.default_expression === "1" &&
    /ENGINE = ReplacingMergeTree\(dedupVersion\)/u.test(statement) &&
    /ORDER BY \(workspaceId, workloadId, timestamp, eventId\)/u.test(
      statement,
    ) &&
    /PARTITION BY toDate\(timestamp\)/u.test(statement) &&
    /TTL expiresAt(?: DELETE)?(?:\r?\n|$)/u.test(statement);
  if (!compatible)
    throw new HttpError(
      503,
      "LOGS_SCHEMA_INCOMPATIBLE",
      "The ClickHouse logging table is incompatible with this Towbar version. Use a dedicated logging database with the matching schema; existing data will not be reset.",
    );
}
