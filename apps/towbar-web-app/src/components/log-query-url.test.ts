import assert from "node:assert/strict";
import test from "node:test";
import { readLogQueryParams, logQueryParams } from "./log-query-url";
import {
  initialLogQueryHistory,
  logQueryHistoryReducer,
} from "./log-query-history";

const workload = "31111111-1111-4111-8111-333333333333";
const server = "21111111-1111-4111-8111-222222222222";
function encode(state: typeof initialLogQueryHistory.current) {
  return new URLSearchParams(
    Object.entries(logQueryParams(state)).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
}

void test("shared log queries restore custom dates, search, top-level choices and repeated OR conditions", () => {
  const conditions = [
    {
      field: "attribute:http.route",
      operator: "contains",
      value: '/api?team=R&D + "東京"',
    },
    { field: "attribute:http.route", operator: "not_equals", value: "/health" },
    { field: "previewId", operator: "not_exists", value: "" },
  ];
  const params = new URLSearchParams({
    search: "trace id & status=500 + timeout",
    range: "custom",
    from: "2026-10-14T08:15:23.123Z",
    to: "2026-10-15T09:30:45.456Z",
    workload,
    environment: "preview",
    level: "error",
    match: "or",
    conditions: JSON.stringify(conditions),
  });
  const state = readLogQueryParams(params);
  assert.equal(state.search, params.get("search"));
  assert.equal(state.range, "custom");
  assert.deepEqual(state.customRange, {
    startAt: params.get("from"),
    endAt: params.get("to"),
  });
  assert.deepEqual(state.selection, {
    workload: `workload:${workload}`,
    environment: "preview",
    severity: "error",
  });
  assert.equal(state.match, "or");
  assert.deepEqual(
    state.conditions.map(({ field, operator, value }) => ({
      field,
      operator,
      value,
    })),
    conditions,
  );
  assert.deepEqual(readLogQueryParams(encode(state)), state);
  assert.equal(encode(state).get("conditions"), JSON.stringify(conditions));
});

void test("preset and server filters round-trip and remove stale workload and custom dates", () => {
  const state = readLogQueryParams(
    new URLSearchParams({
      range: "1440",
      server,
      environment: "all",
      level: "warn",
    }),
  );
  assert.deepEqual(readLogQueryParams(encode(state)), state);
  assert.equal(state.selection.workload, `server:${server}`);
  const params = logQueryParams(state);
  assert.equal(params.workload, null);
  assert.equal(params.from, null);
  assert.equal(params.to, null);
  assert.equal(params.server, server);
  assert.equal(params.range, "1440");
  assert.deepEqual(
    readLogQueryParams(new URLSearchParams()),
    initialLogQueryHistory.current,
  );
});

void test("malformed, oversized, or invalid shared filters use safe defaults without accepting unknown fields", () => {
  for (const conditions of [
    "[",
    '"x"',
    "x".repeat(16385),
    JSON.stringify([{ field: "sql", operator: "equals", value: "1" }]),
  ]) {
    const state = readLogQueryParams(
      new URLSearchParams({
        search: "kept",
        workload: "invalid",
        server,
        range: "custom",
        from: "2026-10-15T09:00:00Z",
        to: "2026-10-14T09:00:00Z",
        environment: "invalid",
        level: "unknown",
        conditions,
      }),
    );
    assert.equal(state.search, "kept");
    assert.equal(state.range, "60");
    assert.equal(state.customRange, null);
    assert.equal(state.selection.workload, `server:${server}`);
    assert.equal(state.selection.environment, "production");
    assert.equal(state.selection.severity, "all");
    assert.deepEqual(state.conditions, []);
  }
  assert.equal(
    readLogQueryParams(new URLSearchParams({ search: "x".repeat(513) })).search
      .length,
    512,
  );
});

void test("search changes do not consume filter undo history and undo has a shareable URL", () => {
  const initial = {
    current: readLogQueryParams(
      new URLSearchParams({ search: "timeout", range: "360" }),
    ),
    past: [],
  };
  const filtered = logQueryHistoryReducer(initial, {
    type: "change",
    patch: { selection: { ...initial.current.selection, severity: "error" } },
  });
  const typed = logQueryHistoryReducer(filtered, {
    type: "change",
    patch: { search: "connection timeout" },
    record: false,
  });
  assert.equal(typed.past.length, 1);
  const undone = logQueryHistoryReducer(typed, { type: "undo" });
  assert.deepEqual(readLogQueryParams(encode(undone.current)), initial.current);
});
