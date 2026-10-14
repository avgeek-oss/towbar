import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { actorAllows, keyCeiling } from "@workspace/towbar-access";
import {
  logFilterSchema,
  logPolicySchema,
  logStorageConfigurationSchema,
} from "@workspace/towbar-core";
import { parseLogConfiguration } from "./configuration.js";
import {
  buildLogConditions,
  decodeLogCursor,
  encodeLogCursor,
} from "./queries.js";
import { logEventIdentity, nanosecondsToIso } from "./ingest.js";

void test("logging is optional and invalid config never echoes credentials", () => {
  assert.equal(parseLogConfiguration(undefined), null);
  const password = "private-password";
  assert.throws(
    () => parseLogConfiguration(JSON.stringify({ clickhouse: { password } })),
    (error: unknown) =>
      error instanceof Error && !error.message.includes(password),
  );
  assert.throws(() => parseLogConfiguration("{"));
  const base = {
    endpoint: "https://logs.example.com:8443",
    database: "towbar_logs",
    username: "towbar",
    password,
  };
  assert.equal(
    logStorageConfigurationSchema.parse({ clickhouse: base }).retentionDays,
    7,
  );
  for (const endpoint of [
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com?password=x",
    "file:///etc/passwd",
  ])
    assert.equal(
      logStorageConfigurationSchema.safeParse({
        clickhouse: { ...base, endpoint },
      }).success,
      false,
    );
  assert.equal(
    logPolicySchema.safeParse({ restrict: "member" }).success,
    false,
  );
});

void test("all roles read ordinary logs; only effective administrators read restricted logs", () => {
  const workspaceId = randomUUID(),
    userId = randomUUID();
  for (const role of ["viewer", "member", "admin"] as const) {
    assert(
      actorAllows({ kind: "session", workspaceId, userId, role }, [
        "logs.read",
      ]),
    );
    assert.equal(
      actorAllows({ kind: "session", workspaceId, userId, role }, [
        "logs.readAdmin",
      ]),
      role === "admin",
    );
    for (const access of ["read", "edit"] as const) {
      const grants = keyCeiling(role, access, false);
      assert(grants.includes("logs.read"));
      assert(!grants.includes("logs.readAdmin"));
    }
  }
  const adminGrant = {
    scope: "personal" as const,
    access: "edit" as const,
    includeAdmin: true,
    grants: keyCeiling("admin", "edit", true),
  };
  assert(
    actorAllows(
      {
        kind: "personal-key",
        workspaceId,
        userId,
        keyId: randomUUID(),
        role: "admin",
        policy: adminGrant,
      },
      ["logs.readAdmin"],
    ),
  );
  assert(
    !actorAllows(
      {
        kind: "personal-key",
        workspaceId,
        userId,
        keyId: randomUUID(),
        role: "member",
        policy: adminGrant,
      },
      ["logs.readAdmin"],
    ),
  );
});

void test("queries bind untrusted filters and apply ownership and visibility before aggregation", () => {
  const workspaceId = randomUUID(),
    workloadId = randomUUID(),
    restrictedId = randomUUID();
  const filters = logFilterSchema.parse({
    from: "2026-10-10T00:00:00Z",
    to: "2026-10-10T01:00:00Z",
    search: "'; DROP TABLE log_records; --",
    attributes: [{ key: "customer", value: "' OR 1=1" }],
  });
  const now = new Date("2026-10-10T01:00:00Z"),
    retentionFloor = new Date("2026-10-10T00:30:00Z");
  const result = buildLogConditions({
    workspaceId,
    filters,
    scope: {
      administrator: false,
      restrictedIds: [restrictedId],
      knownIds: [workloadId],
    },
    retentionDays: 7,
    now,
    snapshotAt: now.toISOString(),
    retentionFloor,
  });
  const sql = result.conditions.join(" AND ");
  assert(!sql.includes("DROP TABLE"));
  assert(!sql.includes("' OR 1=1"));
  assert(sql.includes("workspaceId = {workspaceId:UUID}"));
  assert(sql.includes("visibility = 'all'"));
  assert(sql.includes("workloadId NOT IN {restrictedIds:Array(UUID)}"));
  assert.equal(result.parameters.retentionFloor, retentionFloor.toISOString());
  assert.equal(result.parameters.search, filters.search);
});

void test("pagination cursors detect tampering and expiry", () => {
  const payload = {
    version: 1 as const,
    workspaceId: randomUUID(),
    filterHash: "query-hash",
    snapshotAt: new Date().toISOString(),
    issuedAt: Date.now(),
    timestamp: new Date().toISOString(),
    eventId: "a".repeat(64),
  };
  const cursor = encodeLogCursor(payload, "test-secret");
  assert.deepEqual(decodeLogCursor(cursor, "test-secret"), payload);
  assert.throws(() => decodeLogCursor(`${cursor}tampered`, "test-secret"));
  assert.throws(() => decodeLogCursor(cursor, "different-secret"));
  assert.throws(() =>
    decodeLogCursor(
      encodeLogCursor(
        { ...payload, issuedAt: Date.now() - 16 * 60000 },
        "test-secret",
      ),
      "test-secret",
    ),
  );
});

void test("record identities retain nanoseconds and distinguish repeated messages by position", () => {
  const timestamp = "1792000000123456789",
    container = "a".repeat(64);
  assert.equal(nanosecondsToIso(timestamp).endsWith(".123456789Z"), true);
  assert.equal(
    logEventIdentity(container, timestamp, "stdout", "0"),
    logEventIdentity(container, timestamp, "stdout", "0"),
  );
  assert.notEqual(
    logEventIdentity(container, timestamp, "stdout", "0"),
    logEventIdentity(container, timestamp, "stdout", "100"),
  );
  assert.notEqual(
    logEventIdentity(container, timestamp, "stdout", "0"),
    logEventIdentity(container, timestamp, "stderr", "0"),
  );
});
