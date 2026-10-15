import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fixtureJson } from "./fixture-localization.ts";
import type {
  LogCollectionStatus,
  LogRecord,
  LogStorageStatus,
  TowbarUser,
} from "@workspace/towbar-web-client";
import { logFilterSchema, logBucketSeconds } from "@workspace/towbar-contracts";

type Workload = { id: string; name: string; serverId: string };
export function createLogsFixture(
  workloads: Workload[],
  getUser: () => TowbarUser | null,
  preparedCollector: (serverId: string) => boolean = () => false,
) {
  const recordAt = (
    index: number,
    timestamp: number,
    incident = false,
  ): LogRecord => {
    const seed = createHash("sha256").update(`logs-fixture:${index}`).digest();
    const workload = workloads[seed.readUInt16BE(0) % workloads.length]!;
    const preview = seed[2]! % 7 === 0;
    const roll = seed[3]!;
    const severity: LogRecord["severity"] = incident
      ? roll < 145
        ? "warn"
        : roll < 240
          ? "error"
          : "fatal"
      : index % 997 === 0
        ? "unknown"
        : roll < 10
          ? "trace"
          : roll < 42
            ? "debug"
            : roll < 217
              ? "info"
              : roll < 237
                ? "warn"
                : roll < 252
                  ? "error"
                  : "fatal";
    const service = ["api", "worker", "scheduler", "proxy"][seed[4]! % 4]!;
    const method = ["GET", "POST", "PATCH", "DELETE"][seed[5]! % 4]!;
    const route = [
      "/api/projects",
      "/api/deployments",
      "/api/users",
      "/api/uploads",
      "/health",
      "/api/webhooks",
    ][seed[6]! % 6]!;
    const failed = severity === "error" || severity === "fatal";
    const status = failed
      ? 500
      : severity === "warn"
        ? 429
        : method === "POST"
          ? 201
          : 200;
    const duration = incident
      ? 1200 + (seed.readUInt16BE(7) % 8000)
      : seed.readUInt16BE(7) % 450;
    const username = ["alex", "praveen", "sam", "jordan", "casey", "taylor"][
      seed[9]! % 6
    ]!;
    const region = ["eu-west-1", "us-east-1", "ap-south-1"][seed[10]! % 3]!;
    const messages = {
      trace: `Query executed SELECT id, name FROM projects WHERE owner_id = $1 duration=${duration}ms rows=${seed[11]! % 40}`,
      debug: `Cache ${index % 2 ? "hit" : "miss"} key=project:${seed[12]} user=${username} duration=${duration}ms`,
      info:
        service === "worker"
          ? `Job completed queue=deployments job_id=job-${index} duration=${duration}ms`
          : `Request completed method=${method} path=${route} status=${status} duration=${duration}ms`,
      warn: `Upstream rate limit reached path=${route} status=${status} retry_in=30s duration=${duration}ms`,
      error: `Database query failed: connection timed out after ${duration}ms\n  at ProjectRepository.findAll\n  at requestHandler`,
      fatal: `Worker stopped after unrecoverable queue error queue=deployments code=QUEUE_UNAVAILABLE\n  at QueueConsumer.run\n  at processTicksAndRejections`,
      unknown: `Service ${service} initialized; waiting for incoming work`,
    };
    const attributes: Record<string, string> = {
      method,
      status: String(status),
      request_id: `request-${index}`,
      "http.route": route,
      "http.status_code": String(status),
      duration_ms: String(duration),
      region,
      "release.version": `2.0.${40 + (seed[13]! % 5)}`,
      meta: JSON.stringify({
        username,
        team: ["platform", "engineering", "support"][seed[14]! % 3],
        request: {
          duration_ms: duration,
          cached: index % 2 === 0,
          attempt: index % 4,
          correlation_id: `correlation-${Math.floor(index / 5)}`,
        },
      }),
    };
    if (service === "worker" || service === "scheduler") {
      attributes["queue.name"] = "deployments";
      attributes["job.id"] = `job-${index}`;
      attributes["retry.count"] = String(index % 4);
    }
    if (failed) {
      attributes["error.type"] =
        severity === "fatal"
          ? "QueueUnavailableError"
          : "ConnectionTimeoutError";
      attributes["error.code"] =
        severity === "fatal" ? "QUEUE_UNAVAILABLE" : "ETIMEDOUT";
    }
    return {
      eventId: seed.toString("hex"),
      timestamp: new Date(timestamp).toISOString(),
      ingestedAt: new Date(timestamp + 100 + seed[15]!).toISOString(),
      serverId: workload.serverId,
      workloadId: workload.id,
      workloadName: workload.name,
      deploymentId: index % 17 === 0 ? null : workload.id,
      previewId: preview ? workload.id : null,
      environment: preview ? "preview" : "production",
      containerId: createHash("sha256")
        .update(`${workload.id}:${service}:${preview}`)
        .digest("hex"),
      service,
      stream: failed || severity === "warn" ? "stderr" : "stdout",
      severity,
      body:
        severity === "info" && index % 9 === 0
          ? JSON.stringify({
              message: messages.info,
              method,
              path: route,
              status,
              duration_ms: duration,
              user: { name: username, region },
            })
          : messages[severity],
      attributes,
      traceId: index % 13 === 0 ? null : seed.toString("hex").slice(0, 32),
      spanId: index % 13 === 0 ? null : seed.toString("hex").slice(0, 16),
      truncated: false,
    };
  };
  let records: LogRecord[] = [];
  let latestAt = 0,
    nextIndex = 0;
  const refresh = () => {
    if (!nextIndex) {
      const now = Date.now();
      records = Array.from({ length: 37800 }, (_, index) => {
        const age =
          index < 24000
            ? ((index + 0.5) / 24000) * 86400000
            : index < 28000
              ? 300000 + ((index - 24000 + 0.5) / 4000) * 1500000
              : index < 32000
                ? 4200000 + ((index - 28000 + 0.5) / 4000) * 1500000
                : index < 36000
                  ? ((index - 32000 + 0.5) / 4000) * 21600000
                  : 86400000 + ((index - 36000 + 0.5) / 1800) * 6 * 86400000;
        return recordAt(index, now - age, index >= 28000 && index < 32000);
      }).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      latestAt = now;
      nextIndex = records.length;
      return;
    }
    const elapsed = Math.floor((Date.now() - latestAt) / 2000);
    if (elapsed < 1) return;
    latestAt += elapsed * 2000;
    const count = Math.min(elapsed, 43200);
    const added = Array.from({ length: count }, (_, index) =>
      recordAt(nextIndex++, latestAt - index * 2000),
    );
    records = [...added, ...records].slice(0, 100000);
  };
  const explicitCollectorChoices = new Set<string>();
  const collectors = new Map<string, LogCollectionStatus>();
  const json = (response: ServerResponse, status: number, data: unknown) => {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(fixtureJson(response, data));
  };
  const storage = (): LogStorageStatus => {
    const state = process.env.TOWBAR_FIXTURE_LOGS_STATE;
    return {
      state:
        state === "not_configured"
          ? "not_configured"
          : state === "unavailable"
            ? "unavailable"
            : "ready",
      retentionDays: state === "not_configured" ? null : 7,
      reason:
        state === "unavailable"
          ? "ClickHouse rejected the configured username or password."
          : null,
      code: state === "unavailable" ? "LOGS_AUTHENTICATION_FAILED" : null,
      checkedAt: new Date().toISOString(),
      documentationUrl: "https://www.towbar.dev/docs/operate/centralized-logs",
    };
  };
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) => {
    const pathname = url.pathname;
    if (
      pathname.startsWith("/v1/core/logs/") ||
      pathname.endsWith("/log-collection")
    )
      refresh();
    if (pathname === "/v1/core/observability/logs/status") {
      json(response, 200, storage());
      return true;
    }
    const server = /^\/v1\/core\/servers\/([^/]+)\/log-collection$/.exec(
      pathname,
    );
    if (server) {
      const serverId = server[1]!;
      const installed =
        process.env.TOWBAR_FIXTURE_LOG_COLLECTOR_STATE !== "not_installed" ||
        (preparedCollector(serverId) && storage().state === "ready");
      const item =
        collectors.get(serverId) ??
        ({
          serverId,
          desiredState: installed ? "enabled" : "disabled",
          status: installed ? "collecting" : "disabled",
          generation: installed ? randomUUID() : null,
          version: installed ? "0.162.0" : null,
          lastReportAt: installed ? new Date().toISOString() : null,
          lastIngestedAt: installed ? records[0]!.ingestedAt : null,
          supportedContainers: installed ? 6 : 0,
          unsupportedContainers: installed ? 1 : 0,
          queueBytes: 0,
          droppedRecords: 0,
          errorMessage: null,
        } satisfies LogCollectionStatus);
      if (
        installed &&
        !explicitCollectorChoices.has(serverId) &&
        item.desiredState === "disabled"
      ) {
        Object.assign(item, {
          desiredState: "enabled",
          status: "collecting",
          generation: randomUUID(),
          version: "0.162.0",
          lastReportAt: new Date().toISOString(),
          lastIngestedAt: records[0]!.ingestedAt,
          supportedContainers: 6,
          unsupportedContainers: 1,
        });
      }
      if (request.method === "PUT") {
        if (getUser()?.workspaceRole !== "admin") {
          json(response, 403, {
            error: { message: "Administrator access is required" },
          });
          return true;
        }
        const parts: Buffer[] = [];
        for await (const chunk of request) parts.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(parts).toString()) as {
          enabled: boolean;
        };
        explicitCollectorChoices.add(serverId);
        item.desiredState = input.enabled ? "enabled" : "disabled";
        item.status = input.enabled ? "collecting" : "disabled";
        if (input.enabled) {
          item.generation = randomUUID();
          item.version = "0.162.0";
          item.lastReportAt = new Date().toISOString();
          item.lastIngestedAt = records[0]!.ingestedAt;
          item.supportedContainers = 6;
          item.unsupportedContainers = 1;
        }
      }
      collectors.set(serverId, item);
      json(response, request.method === "PUT" ? 202 : 200, item);
      return true;
    }
    if (!pathname.startsWith("/v1/core/logs/")) return false;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(
      Buffer.concat(chunks).toString() || "{}",
    ) as Record<string, unknown>;
    if (pathname === "/v1/core/logs/context") {
      const at = records.findIndex(
        (record) => record.eventId === input.eventId,
      );
      json(response, 200, {
        records: records.slice(Math.max(0, at - 3), at + 4),
        partial: false,
      });
      return true;
    }
    const filters = logFilterSchema.parse(input.filters ?? input);
    const found = records.filter(
      (record) =>
        Date.parse(record.timestamp) >= Date.parse(filters.from) &&
        Date.parse(record.timestamp) < Date.parse(filters.to) &&
        (!filters.search ||
          [record.body, record.traceId, record.spanId].some((value) =>
            value?.toLowerCase().includes(filters.search.toLowerCase()),
          )) &&
        (!filters.serverIds.length ||
          filters.serverIds.includes(record.serverId)) &&
        (!filters.deploymentIds.length ||
          (record.deploymentId !== null &&
            filters.deploymentIds.includes(record.deploymentId))) &&
        (!filters.previewIds.length ||
          (record.previewId !== null &&
            filters.previewIds.includes(record.previewId))) &&
        (!filters.containerIds.length ||
          filters.containerIds.includes(record.containerId)) &&
        (!filters.services.length ||
          filters.services.includes(record.service)) &&
        (!filters.workloadIds.length ||
          filters.workloadIds.includes(record.workloadId)) &&
        (!filters.environments.length ||
          filters.environments.includes(record.environment)) &&
        (!filters.severities.length ||
          filters.severities.includes(record.severity)) &&
        (!filters.stream || record.stream === filters.stream) &&
        (!filters.traceId || filters.traceId === record.traceId) &&
        (!filters.conditionGroup ||
          (() => {
            const matches = filters.conditionGroup.conditions.map(
              (condition) => {
                const value = condition.field.startsWith("attribute:")
                  ? record.attributes[condition.field.slice(10)]
                  : record[condition.field as keyof LogRecord];
                const exists = typeof value === "string" && value.length > 0;
                if (condition.operator === "exists")
                  return condition.field.startsWith("attribute:")
                    ? typeof value === "string"
                    : exists;
                if (condition.operator === "not_exists")
                  return condition.field.startsWith("attribute:")
                    ? typeof value !== "string"
                    : !exists;
                if (typeof value !== "string") return false;
                const text = value.toLocaleLowerCase(),
                  query = condition.value.toLocaleLowerCase();
                switch (condition.operator) {
                  case "equals":
                    return value === condition.value;
                  case "not_equals":
                    return value !== condition.value;
                  case "contains":
                    return text.includes(query);
                  case "not_contains":
                    return !text.includes(query);
                  case "starts_with":
                    return text.startsWith(query);
                  case "ends_with":
                    return text.endsWith(query);
                }
              },
            );
            return filters.conditionGroup.match === "or"
              ? matches.some(Boolean)
              : matches.every(Boolean);
          })()) &&
        filters.attributes.every((filter) =>
          filter.operator === "contains"
            ? record.attributes[filter.key]?.includes(filter.value)
            : record.attributes[filter.key] === filter.value,
        ),
    );
    if (pathname === "/v1/core/logs/summary") {
      const facets = Object.fromEntries(
        [
          "workloadId",
          "serverId",
          "deploymentId",
          "previewId",
          "containerId",
          "service",
        ].map((field) => [
          field,
          [
            ...new Set(
              records.map((r) => r[field as keyof LogRecord]).filter(Boolean),
            ),
          ].map((id) => ({
            id,
            name:
              field === "workloadId"
                ? (workloads.find((w) => w.id === id)?.name ?? id)
                : id,
            count: 1,
          })),
        ]),
      );
      const step = logBucketSeconds(filters.from, filters.to) * 1000;
      const counts = new Map<
        string,
        { at: string; severity: string; count: number }
      >();
      for (const record of found) {
        const at = new Date(
            Math.floor(Date.parse(record.timestamp) / step) * step,
          ).toISOString(),
          key = `${at}:${record.severity}`;
        const bucket = counts.get(key) ?? {
          at,
          severity: record.severity,
          count: 0,
        };
        bucket.count++;
        counts.set(key, bucket);
      }
      const buckets = [...counts.values()].sort((a, b) =>
        a.at.localeCompare(b.at),
      );
      json(response, 200, {
        facets,
        buckets,
        attributeKeys: [
          ...new Set(found.flatMap((record) => Object.keys(record.attributes))),
        ],
        partial: false,
      });
      return true;
    }
    if (pathname === "/v1/core/logs/tail") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      });
      response.write(
        `event: records\ndata: ${JSON.stringify({ records: [], nextCursor: "follow", accessRevision: "fixture" })}\n\n`,
      );
      const timer = setInterval(
        () =>
          response.write(
            `event: records\ndata: ${JSON.stringify({ records: found.length ? [{ ...found[0], eventId: createHash("sha256").update(randomUUID()).digest("hex"), timestamp: new Date().toISOString(), ingestedAt: new Date().toISOString() }] : [], nextCursor: "follow", accessRevision: "fixture" })}\n\n`,
          ),
        2000,
      );
      response.once("close", () => clearInterval(timer));
      return true;
    }
    const offset = Number(input.cursor ?? 0),
      limit = Number(input.limit ?? 200);
    json(response, 200, {
      records: found.slice(offset, offset + limit),
      hasMore: found.length > offset + limit,
      nextCursor: found.length > offset + limit ? String(offset + limit) : null,
      snapshotAt: new Date().toISOString(),
      followCursor: "follow",
      accessRevision: "fixture",
      partial: false,
    });
    return true;
  };
}
