import { logMatchingCases } from "./matching-test-support.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  logFilterSchema,
  logQuerySchema,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  logCollectors,
  logPolicies,
  logRetentionState,
  logSources,
  servers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { withActor } from "../auth/actor-context.js";
import { LogStorage, ensureLogSchema } from "./storage.js";
import {
  logContext,
  queryLogs,
  summarizeLogs,
  tailLogPage,
} from "./queries.js";
import { retainLogCutoff } from "./policy.js";
import {
  authenticateLogCollector,
  hashLogCredential,
  ingestLogExport,
  logExportSchema,
} from "./ingest.js";

const databaseUrl = process.env.TOWBAR_TEST_DATABASE_URL;
const clickhouseUrl = process.env.TOWBAR_TEST_CLICKHOUSE_URL;
void test(
  "ClickHouse stores and queries logs with workspace and administrator isolation",
  {
    skip: !databaseUrl || !clickhouseUrl,
  },
  async (t) => {
    assert(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));
    assert(
      clickhouseUrl &&
        ["127.0.0.1", "localhost"].includes(new URL(clickhouseUrl).hostname),
    );
    process.env.DATABASE_TOWBAR_URL = databaseUrl;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const configuration = {
      retentionDays: 7,
      clickhouse: {
        endpoint: clickhouseUrl,
        database: "towbar_logs_test",
        username: "logs_test",
        password: "logs_test",
      },
    };
    process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify(configuration);
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const db = getTowbarDatabase(),
      storage = new LogStorage(configuration);
    const workspaceId = randomUUID(),
      otherWorkspace = randomUUID(),
      workloadId = randomUUID(),
      restrictedId = randomUUID(),
      serverId = randomUUID(),
      userId = randomUUID();
    const actor = (role: "admin" | "member" | "viewer") => ({
      kind: "session" as const,
      workspaceId,
      role,
      userId,
    });
    const now = new Date(),
      timestamp = new Date(now.getTime() - 60000).toISOString();
    const filters = logFilterSchema.parse({
      from: new Date(now.getTime() - 3600000).toISOString(),
      to: new Date(now.getTime() + 60000).toISOString(),
    });
    try {
      await db.insert(workspaces).values([
        { id: workspaceId, slug: workspaceId, name: "Centralized logs test" },
        { id: otherWorkspace, slug: otherWorkspace, name: "Other workspace" },
      ]);
      await db.insert(servers).values({
        id: serverId,
        workspaceId,
        canonicalIp: "192.0.2.210",
        configDigest: "logs-test",
        config: normalizeServerConfiguration({
          ip: "192.0.2.210",
          ssh: { username: "deploy" },
          hostLogCollection: true,
        }),
      });
      const token = `twlg_${randomBytes(32).toString("hex")}`;
      await db.insert(logCollectors).values({
        serverId,
        generation: randomUUID(),
        desiredState: "enabled",
        status: "waiting",
        tokenHash: hashLogCredential(token),
      });
      await db.insert(logSources).values(
        [workloadId, restrictedId].map((id, index) => ({
          workspaceId,
          workloadId: id,
          serverId,
          containerId: String(index).repeat(64),
          workloadName: `Service ${index}`,
        })),
      );
      await ensureLogSchema(storage);
      const makeRecord = (
        eventId: string,
        overrides: Record<string, unknown> = {},
      ) => ({
        workspaceId,
        eventId,
        timestamp,
        observedAt: timestamp,
        ingestedAt: timestamp,
        expiresAt: new Date(now.getTime() + 86400000).toISOString(),
        serverId,
        workloadId,
        workloadName: "API",
        deploymentId: null,
        previewId: null,
        environment: "production",
        containerId: "a".repeat(64),
        service: "api",
        stream: "stdout",
        severity: "info",
        body: "Payment accepted",
        attributes: { customer: "123" },
        traceId: null,
        spanId: null,
        visibility: "all",
        truncated: false,
        ...overrides,
      });
      const rows = [
        makeRecord("a".repeat(64), {
          traceId: "1".repeat(32),
          spanId: "2".repeat(16),
        }),
        makeRecord("b".repeat(64), {
          workloadId: restrictedId,
          visibility: "admin",
          body: "Admin only",
          attributes: { customer: "123", admin_secret: "private" },
        }),
        makeRecord("c".repeat(64), {
          workspaceId: otherWorkspace,
          body: "Other workspace",
          attributes: { other_workspace_secret: "private" },
        }),
        makeRecord("d".repeat(64), {
          body: "Expired",
          expiresAt: new Date(now.getTime() - 1000).toISOString(),
        }),
      ];
      await storage.execute(
        "INSERT INTO log_records FORMAT JSONEachRow",
        {},
        { data: rows.map((row) => JSON.stringify(row)).join("\n") },
      );
      await storage.execute(
        "INSERT INTO log_records FORMAT JSONEachRow",
        {},
        { data: JSON.stringify(rows[0]) },
      );
      await t.test(
        "viewer, member, and admin searches agree with aggregate visibility",
        async () => {
          for (const role of ["viewer", "member", "admin"] as const) {
            const page = await withActor(actor(role), () =>
              queryLogs(workspaceId, logQuerySchema.parse({ filters })),
            );
            assert.equal(page.records.length, role === "admin" ? 2 : 1);
            assert(
              !page.records.some((row) =>
                ["Other workspace", "Expired"].includes(row.body),
              ),
            );
            const summary = await withActor(actor(role), () =>
              summarizeLogs(workspaceId, filters),
            );
            assert.deepEqual(
              summary.attributeKeys,
              role === "admin" ? ["admin_secret", "customer"] : ["customer"],
            );
            assert.equal(
              summary.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
              role === "admin" ? 2 : 1,
            );
          }
        },
      );
      await t.test("one-hour summaries use 30-second buckets", async () => {
        const summary = await withActor(actor("viewer"), () =>
          summarizeLogs(
            workspaceId,
            logFilterSchema.parse({ ...filters, to: now.toISOString() }),
          ),
        );
        assert.equal(summary.buckets.length, 1);
        assert.equal(
          Date.parse(summary.buckets[0]!.at),
          Math.floor(Date.parse(timestamp) / 30000) * 30000,
        );
        assert.equal(summary.buckets[0]!.count, 1);
      });
      await t.test(
        "search finds trace and span IDs within the same authorized scope",
        async () => {
          for (const search of ["1".repeat(32), "2".repeat(16)]) {
            const result = await withActor(actor("viewer"), () =>
              queryLogs(
                workspaceId,
                logQuerySchema.parse({ filters: { ...filters, search } }),
              ),
            );
            assert.deepEqual(
              result.records.map((record) => record.eventId),
              ["a".repeat(64)],
            );
          }
        },
      );
      await t.test(
        "AND/OR groups match attributes and metadata without weakening visibility",
        async () => {
          for (const role of ["viewer", "admin"] as const) {
            for (const match of ["and", "or"] as const) {
              const grouped = logFilterSchema.parse({
                ...filters,
                conditionGroup: {
                  match,
                  conditions: [
                    {
                      field: "workloadId",
                      operator: "equals",
                      value: restrictedId,
                    },
                    {
                      field: "attribute:customer",
                      operator: "equals",
                      value: "123",
                    },
                  ],
                },
              });
              const result = await withActor(actor(role), () =>
                queryLogs(
                  workspaceId,
                  logQuerySchema.parse({ filters: grouped }),
                ),
              );
              const expected =
                match === "or"
                  ? role === "admin"
                    ? 2
                    : 1
                  : role === "admin"
                    ? 1
                    : 0;
              assert.equal(result.records.length, expected);
              const summary = await withActor(actor(role), () =>
                summarizeLogs(workspaceId, grouped),
              );
              assert.equal(
                summary.buckets.reduce(
                  (total, bucket) => total + bucket.count,
                  0,
                ),
                expected,
              );
            }
          }
          const group = logFilterSchema.parse({
            ...filters,
            conditionGroup: {
              match: "and",
              conditions: [
                {
                  field: "attribute:customer",
                  operator: "equals",
                  value: "123",
                },
                {
                  field: "attribute:customer",
                  operator: "equals",
                  value: "other",
                },
              ],
            },
          });
          assert.equal(
            (
              await withActor(actor("viewer"), () =>
                queryLogs(
                  workspaceId,
                  logQuerySchema.parse({ filters: group }),
                ),
              )
            ).records.length,
            0,
          );
        },
      );
      await t.test(
        "expanded matching operators execute within the authorized scope",
        async () => {
          for (const [field, operator, value, expected] of logMatchingCases(
            restrictedId,
          )) {
            const grouped = logFilterSchema.parse({
              ...filters,
              conditionGroup: {
                match: "and",
                conditions: [{ field, operator, value }],
              },
            });
            const result = await withActor(actor("viewer"), () =>
              queryLogs(
                workspaceId,
                logQuerySchema.parse({ filters: grouped }),
              ),
            );
            assert.equal(
              result.records.length,
              expected,
              `${field} ${operator}`,
            );
            const summary = await withActor(actor("viewer"), () =>
              summarizeLogs(workspaceId, grouped),
            );
            assert.equal(
              summary.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
              expected,
              `${field} ${operator} summary`,
            );
          }
          const withoutTrace = await withActor(actor("admin"), () =>
            queryLogs(
              workspaceId,
              logQuerySchema.parse({
                filters: {
                  ...filters,
                  conditionGroup: {
                    match: "and",
                    conditions: [
                      { field: "traceId", operator: "not_exists", value: "" },
                    ],
                  },
                },
              }),
            ),
          );
          assert.deepEqual(
            withoutTrace.records.map((record) => record.eventId),
            ["b".repeat(64)],
          );
        },
      );
      await t.test(
        "cursor pagination does not repeat equal-timestamp events",
        async () => {
          const first = await withActor(actor("admin"), () =>
            queryLogs(workspaceId, logQuerySchema.parse({ filters, limit: 1 })),
          );
          assert(first.nextCursor);
          const second = await withActor(actor("admin"), () =>
            queryLogs(
              workspaceId,
              logQuerySchema.parse({
                filters,
                limit: 1,
                cursor: first.nextCursor,
              }),
            ),
          );
          assert.equal(second.records.length, 1);
          assert.notEqual(
            first.records[0]?.eventId,
            second.records[0]?.eventId,
          );
        },
      );
      await t.test(
        "search and attribute filters execute as parameters",
        async () => {
          const found = await withActor(actor("viewer"), () =>
            queryLogs(
              workspaceId,
              logQuerySchema.parse({
                filters: {
                  ...filters,
                  search: "payment",
                  attributes: [{ key: "customer", value: "123" }],
                },
              }),
            ),
          );
          assert.equal(found.records.length, 1);
          const absent = await withActor(actor("viewer"), () =>
            queryLogs(
              workspaceId,
              logQuerySchema.parse({
                filters: { ...filters, search: "' OR 1=1 --" },
              }),
            ),
          );
          assert.equal(absent.records.length, 0);
        },
      );
      await t.test(
        "accepted writes, replay, late timestamps and tail use committed ingestion sequence",
        async () => {
          const principal = await authenticateLogCollector(serverId, token);
          await assert.rejects(
            authenticateLogCollector(serverId, `twlg_${"f".repeat(64)}`),
          );
          await assert.rejects(authenticateLogCollector(randomUUID(), token));
          const initial = await withActor(actor("admin"), () =>
            tailLogPage(workspaceId, filters, undefined),
          );
          const makeBatch = (
            offset: string,
            text: string,
            at = Date.now() - 120000,
          ) =>
            logExportSchema.parse({
              resourceLogs: [
                {
                  resource: {
                    attributes: [
                      {
                        key: "container.id",
                        value: { stringValue: "0".repeat(64) },
                      },
                    ],
                  },
                  scopeLogs: [
                    {
                      logRecords: [
                        {
                          timeUnixNano: String(BigInt(at) * 1000000n),
                          body: { stringValue: text },
                          attributes: [
                            {
                              key: "log.file.record_offset",
                              value: { intValue: offset },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            });
          const batch = makeBatch(
            "0",
            '{"level":50,"msg":"late payment failure","trace_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","meta":{"username":"alex","password":"must-not-retain"}}',
          );
          await ingestLogExport(principal, batch, 512);
          const first = await withActor(actor("admin"), () =>
            tailLogPage(workspaceId, filters, initial.nextCursor),
          );
          assert.equal(first.records.length, 1);
          assert.equal(first.records[0]?.body, "late payment failure");
          assert.equal(first.records[0]?.severity, "error");
          assert.equal(first.records[0]?.attributes["meta.username"], "alex");
          assert(!JSON.stringify(first.records[0]).includes("must-not-retain"));
          assert.equal(first.records[0]?.traceId, "a".repeat(32));
          await ingestLogExport(principal, batch, 512);
          const replay = await withActor(actor("admin"), () =>
            tailLogPage(workspaceId, filters, first.nextCursor),
          );
          assert.equal(
            replay.records.length,
            0,
            "replay must retain the earliest accepted event version",
          );
          const text = "x".repeat(200000);
          const large = makeBatch("50", text);
          large.resourceLogs[0]!.scopeLogs[0]!.logRecords = Array.from(
            { length: 8 },
            (_, i) => ({
              ...large.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!,
              attributes: [
                {
                  key: "log.file.record_offset",
                  value: { intValue: String(50 + i) },
                },
              ],
            }),
          );
          await ingestLogExport(principal, large, 1600000);
          const page = await withActor(actor("admin"), () =>
            tailLogPage(workspaceId, filters, replay.nextCursor),
          );
          assert(page.hasMore && page.partial);
          assert(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024 + 8192);
          const rest = await withActor(actor("admin"), () =>
            tailLogPage(workspaceId, filters, page.nextCursor),
          );
          assert.equal(page.records.length + rest.records.length, 8);
          const around = await withActor(actor("admin"), () =>
            logContext(workspaceId, { ...first.records[0]!, limit: 2 }),
          );
          assert(
            around.records.some(
              (entry) => entry.eventId === first.records[0]!.eventId,
            ),
          );
          const [sequence] = await db
            .select()
            .from(logRetentionState)
            .where(eq(logRetentionState.workspaceId, workspaceId));
          const rogue = makeRecord("e".repeat(64), {
            body: "uncommitted",
            ingestSequence: Number(sequence!.committedSequence) + 1,
          });
          await storage.execute(
            "INSERT INTO log_records FORMAT JSONEachRow",
            {},
            { data: JSON.stringify(rogue) },
          );
          const all = await withActor(actor("admin"), () =>
            queryLogs(workspaceId, logQuerySchema.parse({ filters })),
          );
          assert(!all.records.some((record) => record.body === "uncommitted"));
          const summary = await withActor(actor("admin"), () =>
            summarizeLogs(workspaceId, filters),
          );
          assert.equal(
            summary.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
            11,
          );
          assert(all.partial);
          await db
            .update(logCollectors)
            .set({ desiredState: "disabled", tokenHash: null })
            .where(eq(logCollectors.serverId, serverId));
          await assert.rejects(authenticateLogCollector(serverId, token));
          await assert.rejects(ingestLogExport(principal, batch, 512));
        },
      );
      await t.test(
        "tightened policies hide formerly unrestricted history",
        async () => {
          await db
            .insert(logPolicies)
            .values({ workspaceId, workloadId, restricted: true });
          const hidden = await withActor(actor("viewer"), () =>
            queryLogs(workspaceId, logQuerySchema.parse({ filters })),
          );
          assert.equal(hidden.records.length, 0);
          const visible = await withActor(actor("admin"), () =>
            queryLogs(workspaceId, logQuerySchema.parse({ filters })),
          );
          assert(visible.records.length >= 2);
        },
      );
      await t.test(
        "retention increases cannot undo an earlier expiry boundary",
        async () => {
          const shortened = await retainLogCutoff(workspaceId, 1, now);
          const increased = await retainLogCutoff(workspaceId, 365, now);
          assert.equal(increased.getTime(), shortened.getTime());
        },
      );
    } finally {
      await storage.execute(
        "ALTER TABLE log_records DELETE WHERE workspaceId IN {workspaces:Array(UUID)}",
        { workspaces: [workspaceId, otherWorkspace] },
      );
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace));
      await closeDatabase();
    }
  },
);
