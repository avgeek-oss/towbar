import { parsedLogFields } from "./log-fields.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  apps,
  deployments,
  logCollectors,
  logRetentionState,
  logSources,
  serverDeployableOwnership,
  servers,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { HttpError, unauthorized } from "../../http/errors.js";
import { retainLogCutoff, sourcePolicies } from "./policy.js";
import { getLogConfiguration } from "./configuration.js";
import { ensureLogSchema, logStorage } from "./storage.js";

export const sourceReportSchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            containerId: z.string().regex(/^[a-f0-9]{64}$/u),
            workloadId: z.uuid(),
            deploymentId: z.uuid().nullable(),
            previewId: z.uuid().nullable(),
            service: z.string().max(128).default(""),
            startAt: z.enum(["beginning", "end"]).default("end"),
          })
          .strict(),
      )
      .max(512),
    unsupportedContainers: z.number().int().min(0).max(100000),
    queueBytes: z
      .number()
      .int()
      .min(0)
      .max(1024 * 1024 * 1024),
    droppedRecords: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    version: z.string().max(64),
  })
  .strict();

export const hashLogCredential = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function authenticateLogCollector(
  serverId: string,
  token: string,
) {
  if (!getLogConfiguration()) throw unauthorized("Log collection is disabled");
  if (!/^twlg_[a-f0-9]{64}$/u.test(token))
    throw unauthorized("Invalid log collector credential");
  const [row] = await getTowbarDatabase()
    .select({
      collector: logCollectors,
      workspaceId: servers.workspaceId,
      serverConfig: servers.config,
    })
    .from(logCollectors)
    .innerJoin(servers, eq(servers.id, logCollectors.serverId))
    .where(and(eq(servers.id, serverId), isNull(servers.archivedAt)))
    .limit(1);
  const hash = row?.collector.tokenHash;
  if (
    !row ||
    row.collector.desiredState !== "enabled" ||
    !row.serverConfig.hostLogCollection ||
    !hash ||
    !timingSafeEqual(Buffer.from(hash), Buffer.from(hashLogCredential(token)))
  )
    throw unauthorized("Invalid or revoked log collector credential");
  return { ...row, serverId };
}
export type LogCollectorPrincipal = Awaited<
  ReturnType<typeof authenticateLogCollector>
>;

export async function registerLogSources(
  principal: LogCollectorPrincipal,
  report: z.infer<typeof sourceReportSchema>,
) {
  const db = getTowbarDatabase(),
    now = new Date();
  const ownership = await db
    .select({ id: serverDeployableOwnership.deployableId })
    .from(serverDeployableOwnership)
    .where(eq(serverDeployableOwnership.serverId, principal.serverId));
  const owned = new Set(ownership.map((v) => v.id));
  const workloads = await db
    .select({ id: apps.id, name: apps.name })
    .from(apps)
    .where(eq(apps.workspaceId, principal.workspaceId));
  const names = new Map(workloads.map((w) => [w.id, w.name]));
  const claimed = report.sources.flatMap((s) =>
    s.deploymentId ? [s.deploymentId] : [],
  );
  const deploymentRows = claimed.length
    ? await db
        .select({
          id: deployments.id,
          appId: deployments.appId,
          previewId: deployments.previewEnvironmentId,
        })
        .from(deployments)
        .where(
          and(
            eq(deployments.workspaceId, principal.workspaceId),
            inArray(deployments.id, claimed),
          ),
        )
    : [];
  const deploymentMap = new Map(deploymentRows.map((v) => [v.id, v]));
  const accepted = report.sources.flatMap((s) => {
    const deployment = s.deploymentId
      ? deploymentMap.get(s.deploymentId)
      : null;
    if (!owned.has(s.workloadId) || !names.has(s.workloadId)) return [];
    if (s.deploymentId && deployment?.appId !== s.workloadId) return [];
    if (s.previewId && s.previewId !== deployment?.previewId) return [];
    return [{ ...s, previewId: deployment?.previewId ?? null }];
  });
  await sourcePolicies(
    principal.workspaceId,
    accepted.map((s) => s.workloadId),
  );
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(logCollectors)
      .where(
        and(
          eq(logCollectors.serverId, principal.serverId),
          eq(logCollectors.generation, principal.collector.generation),
          eq(logCollectors.desiredState, "enabled"),
        ),
      )
      .for("update");
    if (!current) throw unauthorized("The collector registration changed");
    for (const source of accepted) {
      const values = {
        containerId: source.containerId,
        workloadId: source.workloadId,
        deploymentId: source.deploymentId,
        previewId: source.previewId,
        service: source.service,
        workspaceId: principal.workspaceId,
        serverId: principal.serverId,
        workloadName: names.get(source.workloadId)!,
        lastSeenAt: now,
      };
      await tx
        .insert(logSources)
        .values(values)
        .onConflictDoUpdate({
          target: [
            logSources.workspaceId,
            logSources.serverId,
            logSources.containerId,
          ],
          set: { lastSeenAt: now },
        });
    }
    await tx
      .update(logCollectors)
      .set({
        lastReportAt: now,
        supportedContainers: accepted.length,
        unsupportedContainers:
          report.unsupportedContainers +
          report.sources.length -
          accepted.length,
        installedVersion: report.version,
        queueBytes: report.queueBytes,
        droppedRecords: sql`greatest(${logCollectors.droppedRecords}, ${report.droppedRecords})`,
        updatedAt: now,
      })
      .where(eq(logCollectors.serverId, principal.serverId));
  });
  return { allowedContainerIds: accepted.map((s) => s.containerId) };
}

const anyValue = z.object({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  boolValue: z.boolean().optional(),
  kvlistValue: z.unknown().optional(),
  arrayValue: z.unknown().optional(),
  bytesValue: z.string().optional(),
});
const attributes = z
  .array(z.object({ key: z.string().max(128), value: anyValue }))
  .max(100);
const otlpRecord = z.object({
  timeUnixNano: z.string().regex(/^\d{1,20}$/u),
  body: anyValue,
  attributes: attributes.default([]),
  severityText: z.string().max(64).optional(),
  severityNumber: z.number().int().min(0).max(24).optional(),
  traceId: z.string().max(32).optional(),
  spanId: z.string().max(16).optional(),
  observedTimeUnixNano: z.string().optional(),
});
export const logExportSchema = z
  .object({
    resourceLogs: z
      .array(
        z.object({
          resource: z.object({ attributes: attributes.default([]) }).optional(),
          scopeLogs: z
            .array(z.object({ logRecords: z.array(otlpRecord).max(512) }))
            .max(16),
        }),
      )
      .max(512),
  })
  .refine(
    (v) =>
      v.resourceLogs.reduce(
        (sum, r) =>
          sum + r.scopeLogs.reduce((n, s) => n + s.logRecords.length, 0),
        0,
      ) <= 2048,
    "Export at most 2048 records at a time",
  );
type Attributes = z.infer<typeof attributes>;
const values = (list: Attributes) =>
  Object.fromEntries(
    list.map(({ key, value }) => [
      key,
      value.stringValue ??
        String(value.intValue ?? value.doubleValue ?? value.boolValue ?? ""),
    ]),
  );

export function nanosecondsToIso(raw: string) {
  const ns = BigInt(raw),
    ms = ns / 1000000n;
  if (ms > BigInt(8640000000000000)) throw new Error("Invalid timestamp");
  return new Date(Number(ms))
    .toISOString()
    .replace(/Z$/u, `${String(ns % 1000000n).padStart(6, "0")}Z`);
}
export function logEventIdentity(
  containerId: string,
  timestamp: string,
  stream: string,
  offset: string,
) {
  return createHash("sha256")
    .update(JSON.stringify([containerId, timestamp, stream, offset]))
    .digest("hex");
}
export function logSeverity(
  value: string | number | undefined,
  otelNumber?: number,
) {
  const pino = {
    10: "trace",
    20: "debug",
    30: "info",
    40: "warn",
    50: "error",
    60: "fatal",
  } as const;
  if (typeof value === "number" && value in pino)
    return pino[value as keyof typeof pino];
  if (!value && otelNumber && otelNumber >= 1 && otelNumber <= 24)
    return ["trace", "debug", "info", "warn", "error", "fatal"][
      Math.floor((otelNumber - 1) / 4)
    ]!;
  const key = value?.toString().toLowerCase();
  if (key === "warning") return "warn";
  if (key === "critical" || key === "panic") return "fatal";
  return ["trace", "debug", "info", "warn", "error", "fatal"].includes(
    key ?? "",
  )
    ? key!
    : "unknown";
}

function parseLogMessage(record: z.infer<typeof otlpRecord>) {
  const raw = record.body.stringValue ?? "";
  let body = raw,
    severity = logSeverity(record.severityText, record.severityNumber),
    appAttributes: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const object = parsed as Record<string, unknown>;
      body =
        typeof object.message === "string"
          ? object.message
          : typeof object.msg === "string"
            ? object.msg
            : raw;
      const level = object.level ?? object.severity;
      severity = logSeverity(
        typeof level === "number" || typeof level === "string"
          ? level
          : record.severityText,
        record.severityNumber,
      );
      appAttributes = parsedLogFields(object);
    }
  } catch {
    /* Plain text is a supported record format. */
  }
  return { body, severity, appAttributes };
}

export async function ingestLogExport(
  principal: LogCollectorPrincipal,
  batch: z.infer<typeof logExportSchema>,
  bytes: number,
) {
  const storage = logStorage(),
    now = new Date(),
    db = getTowbarDatabase();
  const sources = await db
    .select()
    .from(logSources)
    .where(
      and(
        eq(logSources.workspaceId, principal.workspaceId),
        eq(logSources.serverId, principal.serverId),
      ),
    );
  const sourceMap = new Map(sources.map((s) => [s.containerId, s]));
  const restricted = await sourcePolicies(principal.workspaceId, [
    ...new Set(sources.map((s) => s.workloadId)),
  ]);
  const records: Record<string, unknown>[] = [];
  let rejected = 0;
  const retentionFloor = await retainLogCutoff(
    principal.workspaceId,
    storage.configuration.retentionDays,
    now,
  );
  for (const resource of batch.resourceLogs) {
    const resourceValues = values(resource.resource?.attributes ?? []);
    for (const scope of resource.scopeLogs)
      for (const record of scope.logRecords) {
        const attrs = { ...resourceValues, ...values(record.attributes) };
        const source = sourceMap.get(attrs["container.id"] ?? "");
        const offset = attrs["log.file.record_offset"];
        const at = Number(BigInt(record.timeUnixNano) / 1000000n);
        const age = now.getTime() - at;
        if (
          !source ||
          !offset ||
          !/^\d+$/u.test(offset) ||
          !Number.isFinite(at) ||
          at < retentionFloor.getTime() ||
          age < -120000 ||
          age >
            Math.min(86400000, storage.configuration.retentionDays * 86400000)
        ) {
          rejected++;
          continue;
        }
        const parsed = parseLogMessage(record);
        let body = parsed.body;
        const { severity, appAttributes } = parsed;
        const stream = attrs["log.iostream"] === "stderr" ? "stderr" : "stdout";
        const timestamp = nanosecondsToIso(record.timeUnixNano);
        const truncated = Buffer.byteLength(body) > 262144;
        if (truncated) {
          const bytes = Buffer.from(body);
          let end = 262144;
          while ((bytes[end]! & 0xc0) === 0x80) end--;
          body = bytes.subarray(0, end).toString("utf8");
        }
        records.push({
          workspaceId: principal.workspaceId,
          eventId: logEventIdentity(
            source.containerId,
            record.timeUnixNano,
            stream,
            offset,
          ),
          timestamp,
          observedAt: now.toISOString(),
          ingestedAt: now.toISOString(),
          expiresAt: new Date(
            at + storage.configuration.retentionDays * 86400000,
          ).toISOString(),
          serverId: source.serverId,
          workloadId: source.workloadId,
          workloadName: source.workloadName,
          deploymentId: source.deploymentId,
          previewId: source.previewId,
          environment: source.previewId ? "preview" : "production",
          containerId: source.containerId,
          service: source.service,
          stream,
          severity,
          body,
          attributes: appAttributes,
          traceId: traceIdentifier(
            record.traceId ?? appAttributes.trace_id,
            32,
          ),
          spanId: traceIdentifier(record.spanId ?? appAttributes.span_id, 16),
          visibility: restricted.has(source.workloadId) ? "admin" : "all",
          truncated,
          schemaVersion: 1,
        });
      }
  }
  await ensureLogSchema(storage);
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(logCollectors)
      .where(
        and(
          eq(logCollectors.serverId, principal.serverId),
          eq(logCollectors.generation, principal.collector.generation),
          eq(logCollectors.desiredState, "enabled"),
        ),
      )
      .for("update");
    if (!current) throw unauthorized("The collector registration changed");
    const window = new Date(Math.floor(now.getTime() / 60000) * 60000);
    const used =
      current.ingestWindow?.getTime() === window.getTime()
        ? current.ingestBytes
        : 0;
    if (used + bytes > 64 * 1024 * 1024)
      throw new HttpError(
        429,
        "LOGS_RATE_LIMITED",
        "Log ingestion budget exceeded.",
        { responseHeaders: { "Retry-After": "30" } },
      );
    if (records.length) {
      const [sequence] = await tx
        .update(logRetentionState)
        .set({
          committedSequence: sql`${logRetentionState.committedSequence} + 1`,
        })
        .where(eq(logRetentionState.workspaceId, principal.workspaceId))
        .returning({ value: logRetentionState.committedSequence });
      if (!sequence) throw new Error("Log ingestion sequence is unavailable");
      const ingestedAt = new Date().toISOString();
      for (const record of records) {
        record.ingestedAt = ingestedAt;
        record.ingestSequence = String(sequence.value);
        record.dedupVersion = String(
          18446744073709551615n - BigInt(sequence.value),
        );
      }
      await storage.execute(
        "INSERT INTO log_records FORMAT JSONEachRow",
        {},
        { data: records.map((record) => JSON.stringify(record)).join("\n") },
      );
    }
    await tx
      .update(logCollectors)
      .set({
        lastIngestedAt: records.length ? now : current.lastIngestedAt,
        status: sql`case when ${logCollectors.status} in ('waiting','collecting') then 'collecting' else ${logCollectors.status} end`,
        ingestWindow: window,
        ingestBytes: used + bytes,
        droppedRecords: sql`${logCollectors.droppedRecords} + ${rejected}`,
        updatedAt: now,
      })
      .where(eq(logCollectors.serverId, principal.serverId));
  });
  return rejected
    ? {
        partialSuccess: {
          rejectedLogRecords: String(rejected),
          errorMessage:
            "Records with unknown sources, invalid positions, or expired timestamps were rejected.",
        },
      }
    : {};
}

function traceIdentifier(value: string | undefined, length: number) {
  return value && value.length === length && /^[a-f0-9]+$/u.test(value)
    ? value
    : null;
}
