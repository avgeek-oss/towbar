import { logRecordSchema, logFilterSchema } from "@workspace/towbar-contracts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  localizedResponse,
  defaultDateTimePreferences,
} from "@workspace/towbar-core/date-time";
import {
  clearDateTimeLabels,
  localizationGeneration,
  receiveDateTimeLabels,
} from "../lib/date-time-display";
import {
  conditionFilters,
  logMatchNeedsValue,
  logColumnValue,
  validLogColumnPath,
  reorderLogColumns,
  logDateTime,
  logRangeLabel,
} from "./log-explorer-model";

void test("condition groups preserve repeated fields and the selected match mode", () => {
  const conditions = [
    { id: "a", field: "service", operator: "equals" as const, value: "api" },
    {
      id: "b",
      field: "attribute:customer",
      operator: "equals" as const,
      value: "123",
    },
    {
      id: "c",
      field: "attribute:customer",
      operator: "contains" as const,
      value: "456",
    },
  ];
  assert.deepEqual(conditionFilters(conditions, "or"), {
    conditionGroup: {
      match: "or",
      conditions: conditions.map(({ field, operator, value }) => ({
        field,
        operator,
        value,
      })),
    },
  });
  assert.deepEqual(conditionFilters([]), {});
});
void test("existence filters need no value and metadata rejects text matching", () => {
  const base = { from: "2026-10-15T00:00:00Z", to: "2026-10-15T01:00:00Z" };
  for (const operator of ["exists", "not_exists"] as const) {
    assert.equal(logMatchNeedsValue(operator), false);
    assert(
      logFilterSchema.safeParse({
        ...base,
        conditionGroup: {
          match: "and",
          conditions: [{ field: "deploymentId", operator, value: "" }],
        },
      }).success,
    );
  }
  assert.equal(logMatchNeedsValue("not_contains"), true);
  assert.equal(
    logFilterSchema.safeParse({
      ...base,
      conditionGroup: {
        match: "and",
        conditions: [
          { field: "deploymentId", operator: "contains", value: "123" },
        ],
      },
    }).success,
    false,
  );
});
void test("custom columns resolve nested, flattened and JSON-message paths without evaluating input", () => {
  const record = logRecordSchema.parse({
    eventId: "a".repeat(64),
    timestamp: "2026-10-15T00:00:00Z",
    ingestedAt: "2026-10-15T00:00:00Z",
    serverId: "00000000-0000-4000-8000-000000000001",
    workloadId: "00000000-0000-4000-8000-000000000002",
    workloadName: "API",
    deploymentId: null,
    previewId: null,
    environment: "production",
    containerId: "b".repeat(64),
    service: "api",
    severity: "info",
    stream: "stdout",
    body: JSON.stringify({
      request: { cached: false, duration: 0 },
      users: [{ name: "Alex" }],
    }),
    attributes: {
      "http.method": "GET",
      meta: JSON.stringify({ username: "praveen" }),
    },
    traceId: null,
    spanId: null,
    truncated: false,
  });
  assert.equal(logColumnValue(record, "meta.username"), "praveen");
  assert.equal(logColumnValue(record, "attributes.http.method"), "GET");
  assert.equal(logColumnValue(record, "request.cached"), "false");
  assert.equal(logColumnValue(record, "request.duration"), "0");
  assert.equal(logColumnValue(record, "users.0.name"), "Alex");
  assert.equal(logColumnValue(record, "missing.field"), "");
  assert.equal(logColumnValue(record, "constructor.name"), "");
  assert(!validLogColumnPath("meta.username; alert(1)"));
  assert(!validLogColumnPath("__proto__.secret"));
  const order = ["time", "message", "level"];
  assert.deepEqual(reorderLogColumns(order, "level", "time"), [
    "level",
    "time",
    "message",
  ]);
  assert.deepEqual(order, ["time", "message", "level"]);
});
void test("logs always show seconds while preserving the user's localized date and timezone", () => {
  const values = { from: "2026-10-14T23:55:17Z", to: "2026-10-15T00:05:23Z" };
  clearDateTimeLabels();
  receiveDateTimeLabels(
    localizedResponse(values, {
      ...defaultDateTimePreferences,
      timeZone: "Asia/Kolkata",
    }),
    localizationGeneration(),
  );
  assert.equal(logDateTime(values.from), "05:25:17, 15 Oct 2026");
  assert.equal(
    logRangeLabel(values.from, values.to),
    "15 Oct 2026 · 05:25:17 – 05:35:23",
  );
  clearDateTimeLabels();
  receiveDateTimeLabels(
    localizedResponse(values, defaultDateTimePreferences),
    localizationGeneration(),
  );
  assert.equal(
    logRangeLabel(values.from, values.to),
    "23:55:17, 14 Oct 2026 – 00:05:23, 15 Oct 2026",
  );
  clearDateTimeLabels();
});
