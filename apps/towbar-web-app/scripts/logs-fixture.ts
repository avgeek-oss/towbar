import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fixtureJson } from "./fixture-localization.ts";
import type {
  LogCollectionStatus,
  LogRecord,
  LogStorageStatus,
  TowbarUser,
} from "@workspace/towbar-web-client";
import { logFilterSchema } from "@workspace/towbar-contracts";

type Workload = { id: string; name: string; serverId: string };
export function createLogsFixture(
  workloads: Workload[],
  getUser: () => TowbarUser | null,
) {
  const now = Date.now();
  const records: LogRecord[] = Array.from({ length: 650 }, (_, index) => {
    const workload = workloads[index % workloads.length]!;
    const preview = index % 7 === 0;
    const id = createHash("sha256")
      .update(`logs-fixture:${index}`)
      .digest("hex");
    const age =
      index < 96
        ? index * 28000
        : 3600000 + ((index - 96) / 553) * (7 * 86400000 - 3660000);
    return {
      eventId: id,
      timestamp: new Date(now - age).toISOString(),
      ingestedAt: new Date(now - age + 200).toISOString(),
      serverId: workload.serverId,
      workloadId: workload.id,
      workloadName: workload.name,
      deploymentId: workload.id,
      previewId: preview ? workload.id : null,
      environment: preview ? "preview" : "production",
      containerId: createHash("sha256").update(workload.id).digest("hex"),
      service: "api",
      stream: index % 5 ? "stdout" : "stderr",
      severity:
        index % 11
          ? "info"
          : (
              [
                "trace",
                "debug",
                "info",
                "warn",
                "error",
                "fatal",
                "unknown",
              ] as const
            )[index % 7]!,
      body:
        index % 11
          ? `Request completed method=GET path=/api/projects status=200 duration=${index % 120}ms`
          : "Database query failed: connection timed out\n  at ProjectRepository.findAll\n  at requestHandler",
      attributes: {
        method: index % 3 ? "GET" : "POST",
        meta: JSON.stringify({
          username: ["alex", "praveen", "sam", "jordan"][index % 4],
          request: { duration_ms: index % 120, cached: index % 2 === 0 },
        }),
        request_id: `request-${index}`,
        status: index % 11 ? "200" : "500",
      },
      traceId: id.slice(0, 32),
      spanId: id.slice(0, 16),
      truncated: false,
    };
  });
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
    if (pathname === "/v1/core/observability/logs/status") {
      json(response, 200, storage());
      return true;
    }
    const server = /^\/v1\/core\/servers\/([^/]+)\/log-collection$/.exec(
      pathname,
    );
    if (server) {
      const serverId = server[1]!;
      const item =
        collectors.get(serverId) ??
        ({
          serverId,
          desiredState: "enabled",
          status: "collecting",
          generation: randomUUID(),
          version: "0.162.0",
          lastReportAt: new Date().toISOString(),
          lastIngestedAt: records[0]!.ingestedAt,
          supportedContainers: 6,
          unsupportedContainers: 1,
          queueBytes: 0,
          droppedRecords: 0,
          errorMessage: null,
        } satisfies LogCollectionStatus);
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
        item.desiredState = input.enabled ? "enabled" : "disabled";
        item.status = input.enabled ? "collecting" : "disabled";
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
      const step = Math.max(
        60000,
        Math.ceil(
          (Date.parse(filters.to) - Date.parse(filters.from)) / 500 / 1000,
        ) * 1000,
      );
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
