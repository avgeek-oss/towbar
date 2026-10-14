import assert from "node:assert/strict";
import test from "node:test";
import { parsedLogFields } from "./log-fields.js";
void test("structured log fields retain bounded nested paths and exclude credentials", () => {
  const fields = parsedLogFields({
    message: "Hello",
    meta: {
      username: "alex",
      password: "private",
      token: { value: "private" },
    },
    request: { duration_ms: 0, cached: false },
    items: [{ id: 7 }],
  });
  assert.deepEqual(fields, {
    message: "Hello",
    "meta.username": "alex",
    "request.duration_ms": "0",
    "request.cached": "false",
    "items.0.id": "7",
  });
  assert(!JSON.stringify(fields).includes("private"));
  assert.equal(
    Object.keys(
      parsedLogFields(
        Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`field${i}`, "x"]),
        ),
      ),
    ).length,
    50,
  );
  assert.equal(
    parsedLogFields({ value: "x".repeat(5000) }).value?.length,
    4096,
  );
  assert.deepEqual(
    parsedLogFields(
      JSON.parse('{"__proto__":{"secret":"x"},"constructor":{"value":"x"}}'),
    ),
    {},
  );
  const crowded = parsedLogFields({
    meta: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`field${i}`, "x"]),
    ),
    trace_id: "a".repeat(32),
  });
  assert.equal(crowded.trace_id, "a".repeat(32));
  assert.equal(Object.keys(crowded).length, 50);
});
