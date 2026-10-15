import assert from "node:assert/strict";
import test from "node:test";
import { logRecordSchema } from "@workspace/towbar-contracts";
import {
  logJsonColumnPath,
  logJsonCondition,
  logJsonLines,
  logJsonValue,
} from "./log-json-model";

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
