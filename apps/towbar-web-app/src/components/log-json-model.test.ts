import assert from "node:assert/strict";
import test from "node:test";
import { logRecordSchema } from "@workspace/towbar-contracts";
import {
  logJsonColumnPath,
  logJsonCondition,
  logJsonLines,
  logJsonValue,
  logJsonPresentation,
} from "./log-json-model";
import { logColumnValue, parseStructuredLogValue } from "./log-explorer-model";

const record = logRecordSchema.parse({
  eventId: "a".repeat(64),
  timestamp: "2026-10-15T00:00:00Z",
  ingestedAt: "2026-10-15T00:00:01Z",
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
  body: "Request completed",
  attributes: { "http.method": "GET", empty: "", meta: '{"username":"sam"}' },
  traceId: null,
  spanId: null,
  truncated: false,
});

void test("structured messages expand objects, arrays and double-encoded JSON without changing plain text", () => {
  const object = { level: "warn", event: "request_completed", status: 429 };
  for (const value of [object, [object], {}, []]) {
    for (const body of [
      JSON.stringify(value),
      JSON.stringify(JSON.stringify(value)),
    ]) {
      assert.deepEqual(parseStructuredLogValue(body), value);
      assert.deepEqual(logJsonPresentation({ ...record, body }).body, value);
      assert.equal(logJsonPresentation({ ...record, body }).structured, true);
    }
  }
  for (const body of [
    "Request completed",
    '{"truncated":',
    "null",
    '"text"',
    "123",
    "false",
  ]) {
    assert.equal(parseStructuredLogValue(body), body);
    assert.equal(logJsonPresentation({ ...record, body }).structured, false);
  }
  const deep = "[".repeat(40) + "0" + "]".repeat(40);
  assert.equal(parseStructuredLogValue(deep), deep);
});

void test("parsed details hide only exact duplicate attributes and preserve the complete raw record", () => {
  const body = JSON.stringify({
    event: "request_completed",
    status: 429,
    cached: false,
    request: { id: "request-1" },
    tags: ["api"],
    empty: null,
  });
  const source = {
    ...record,
    body,
    attributes: {
      event: "request_completed",
      status: "429",
      cached: "false",
      "request.id": "request-1",
      "tags.0": "api",
      empty: "null",
      additional: "retained",
      request_id: "different-value",
    },
  };
  const before = JSON.stringify(source);
  const parsed = logJsonPresentation(source);
  assert.deepEqual(parsed.record.body, JSON.parse(body));
  assert.deepEqual(parsed.record.attributes, {
    empty: "null",
    additional: "retained",
    request_id: "different-value",
  });
  assert.equal(JSON.stringify(source), before);
  const allDuplicated = logJsonPresentation({
    ...record,
    body: '{"event":"request_completed"}',
    attributes: { event: "request_completed" },
  });
  assert.equal(Object.hasOwn(allDuplicated.record, "attributes"), false);
  const changed = logJsonPresentation({
    ...source,
    attributes: { status: "500" },
  });
  assert.deepEqual(changed.record.attributes, { status: "500" });
});

void test("expanded body field actions filter the indexed attribute and add a working body column", () => {
  const source = {
    ...record,
    body: JSON.stringify(
      JSON.stringify({ request: { status: 429 }, cached: false }),
    ),
    attributes: { "request.status": "429", cached: "false" },
  };
  const parsed = logJsonPresentation(source);
  const { fields } = logJsonLines(parsed.record);
  const field = [...fields.values()].find(
    ({ path }) => path.join(".") === "body.request.status",
  )!;
  assert.deepEqual(logJsonCondition(source, field), {
    field: "attribute:request.status",
    operator: "equals",
    value: "429",
  });
  assert.deepEqual(logJsonCondition(source, field, true), {
    field: "attribute:request.status",
    operator: "not_equals",
    value: "429",
  });
  assert.equal(logJsonColumnPath(field), "body.request.status");
  assert.equal(logColumnValue(source, "body.request.status"), "429");
  assert.deepEqual(
    logJsonCondition(source, { path: ["body", "cached"], value: false }),
    { field: "attribute:cached", operator: "equals", value: "false" },
  );
  assert.equal(
    logJsonCondition(source, {
      path: ["body", "request"],
      value: { status: 429 },
    }),
    null,
  );
  assert.equal(
    logJsonCondition(source, {
      path: ["body", "request", "status"],
      value: 500,
    }),
    null,
  );
  assert.equal(
    logJsonCondition(source, {
      path: ["body", "not_indexed"],
      value: "unknown",
    }),
    null,
  );
});

void test("JSON line actions retain exact nested keys and typed values without targeting closing braces", () => {
  const source = {
    'quoted"key': "first\nsecond",
    list: [{ enabled: false, count: 0 }, null],
    empty: {},
    attributes: record.attributes,
  };
  const { code, fields } = logJsonLines(source);
  assert.equal(code, JSON.stringify(source, null, 2));
  const lines = code.split("\n");
  for (const [line, field] of fields) {
    assert(!/^\s*[}\]]/u.test(lines[line]!), `Closing bracket at ${line}`);
    let value: unknown = source;
    for (const part of field.path) value = Reflect.get(value as object, part);
    assert.deepEqual(field.value, value);
  }
  const find = (path: string[]) =>
    [...fields.values()].find(
      (field) => JSON.stringify(field.path) === JSON.stringify(path),
    );
  assert.deepEqual(find(["list", "0", "count"])?.value, 0);
  assert.deepEqual(find(["list", "0", "enabled"])?.value, false);
  assert.deepEqual(find(["list", "1"])?.value, null);
  assert.equal(find(['quoted"key'])?.value, "first\nsecond");
  assert.equal(find(["attributes", "http.method"])?.value, "GET");
  assert.equal(logJsonValue(false), "false");
  assert.equal(logJsonValue(0), "0");
  assert.equal(logJsonValue(null), "null");
  assert.equal(logJsonValue(source.list), JSON.stringify(source.list));
});

void test("JSON context filters use the API contract and preserve literal attribute keys and empty values", () => {
  assert.deepEqual(
    logJsonCondition(record, {
      path: ["attributes", "http.method"],
      value: "GET",
    }),
    { field: "attribute:http.method", operator: "equals", value: "GET" },
  );
  assert.deepEqual(
    logJsonCondition(
      record,
      { path: ["attributes", "empty"], value: "" },
      true,
    ),
    { field: "attribute:empty", operator: "not_equals", value: "" },
  );
  assert.deepEqual(
    logJsonCondition(record, { path: ["deploymentId"], value: null }),
    { field: "deploymentId", operator: "not_exists", value: "" },
  );
  assert.deepEqual(
    logJsonCondition(record, { path: ["deploymentId"], value: null }, true),
    { field: "deploymentId", operator: "exists", value: "" },
  );
  assert.deepEqual(
    logJsonCondition(record, { path: ["workloadName"], value: "API" }, true),
    { field: "workloadId", operator: "not_equals", value: record.workloadId },
  );
  assert.equal(
    logJsonCondition(record, {
      path: ["attributes", "meta", "username"],
      value: "sam",
    }),
    null,
  );
  assert.equal(
    logJsonCondition(record, {
      path: ["attributes", "large"],
      value: "x".repeat(513),
    }),
    null,
  );
  assert.equal(
    logJsonCondition(record, { path: ["body"], value: "Request completed" }),
    null,
  );
  assert.equal(
    logJsonCondition(record, { path: ["serverId"], value: "not-a-uuid" }),
    null,
  );
});

void test("context columns accept safe dot paths while rejecting ambiguous or executable paths", () => {
  assert.equal(
    logJsonColumnPath({ path: ["attributes", "http.method"], value: "GET" }),
    "attributes.http.method",
  );
  assert.equal(
    logJsonColumnPath({ path: ["constructor", "name"], value: "Object" }),
    null,
  );
  assert.equal(
    logJsonColumnPath({ path: ["attributes", "a b"], value: "x" }),
    null,
  );
});
