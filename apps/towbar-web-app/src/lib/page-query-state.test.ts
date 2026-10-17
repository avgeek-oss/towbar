import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsUrlState,
  parseCursorTrail,
  queryInteger,
} from "./page-query-state";

test("analytics URLs preserve short ranges and only filters for the selected measure", () => {
  const filters = [
    { field: "path", operator: "startsWith", value: "/api" },
    { field: "method", operator: "in", value: ["GET"] },
    { field: "country", operator: "in", value: ["IN"] },
  ];
  const state = analyticsUrlState(
    new URLSearchParams({
      measure: "request",
      days: String(1 / 96),
      filters: JSON.stringify(filters),
    }),
  );
  assert.equal(state.days, 1 / 96);
  assert.equal(state.kind, "request");
  assert.deepEqual(state.filters, filters.slice(0, 2));
});
test("invalid and oversized URL values cannot become analytics queries or expensive offsets", () => {
  for (const filters of [
    "{",
    JSON.stringify([
      { field: "path", operator: "equals", value: "https://bad.example" },
    ]),
    " ".repeat(8193),
  ]) {
    const state = analyticsUrlState(
      new URLSearchParams({ days: "999999", measure: "invalid", filters }),
    );
    assert.deepEqual(state, { kind: "pageview", days: 1, filters: [] });
  }
  for (const value of [
    null,
    "-1",
    "0",
    "NaN",
    "1.5",
    "1e5",
    "999999999999999999999",
  ])
    assert.equal(queryInteger(value), 1);
  assert.equal(queryInteger("12"), 12);
});
test("cursor URLs preserve timestamp precision and reject malformed pairs", () => {
  const cursor = {
    before: "2026-10-18T01:02:03.123456Z",
    beforeId: "11111111-1111-4111-8111-111111111111",
  };
  assert.deepEqual(parseCursorTrail(JSON.stringify([cursor])), [cursor]);
  for (const value of [
    "broken",
    "{}",
    JSON.stringify([{ before: cursor.before }]),
    JSON.stringify([{ ...cursor, beforeId: "x&state=all" }]),
    JSON.stringify([{ ...cursor, before: "invalid" }]),
  ])
    assert.deepEqual(parseCursorTrail(value), []);
});
