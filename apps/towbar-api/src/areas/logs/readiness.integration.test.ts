import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  logRetentionState,
  workspaces,
} from "@workspace/towbar-database/schema";
import { LogStorage, ensureLogSchema, logTableSchema } from "./storage.js";
import { logStorageStatus } from "./readiness.js";
import { retainLogCutoff } from "./policy.js";
import { maintainLogRetention } from "./retention.js";

const databaseUrl = process.env.TOWBAR_TEST_DATABASE_URL;
const clickhouseUrl = process.env.TOWBAR_TEST_CLICKHOUSE_URL;
void test(
  "ClickHouse readiness verifies actual privileges, schema compatibility and retention maintenance",
  { skip: !databaseUrl || !clickhouseUrl },
  async (t) => {
    assert(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));
    assert(
      clickhouseUrl &&
        ["127.0.0.1", "localhost"].includes(new URL(clickhouseUrl).hostname),
    );
    // A private database: maintainLogRetention() prunes every workspace
    // with pending retention in its database and must find none left.
    const admin = postgres(databaseUrl, { max: 1, onnotice() {} });
    const privateDatabase = `towbar_log_readiness_${randomUUID().replaceAll("-", "")}_test`;
    await admin.unsafe(`CREATE DATABASE "${privateDatabase}"`);
    t.after(async () => {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${privateDatabase}" WITH (FORCE)`,
      );
      await admin.end();
    });
    const isolated = new URL(databaseUrl);
    isolated.pathname = `/${privateDatabase}`;
    process.env.DATABASE_TOWBAR_URL = isolated.href;
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
    const storage = new LogStorage(configuration);
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl: isolated.href,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      temporaryDatabase = `towbar_logs_${randomBytes(6).toString("hex")}_test`,
      limitedUser = `towbar_logs_${randomBytes(6).toString("hex")}`;
    const temporary = new LogStorage({
      ...configuration,
      clickhouse: { ...configuration.clickhouse, database: temporaryDatabase },
    });
    try {
      await db.insert(workspaces).values({
        id: workspaceId,
        slug: workspaceId,
        name: "Storage maintenance test",
      });
      process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify(configuration);
      await ensureLogSchema(storage);
      await t.test(
        "a valid dedicated account is ready while authentication failures remain sanitized",
        async () => {
          assert.equal((await logStorageStatus()).state, "ready");
          const wrong = {
            ...configuration,
            clickhouse: {
              ...configuration.clickhouse,
              password: "invalid-secret-must-not-be-echoed",
            },
          };
          process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify(wrong);
          const result = await logStorageStatus();
          assert.equal(result.code, "LOGS_AUTHENTICATION_FAILED");
          assert(!JSON.stringify(result).includes(wrong.clickhouse.password));
          delete process.env.TOWBAR_LOGS_CONFIG_JSON;
          assert.equal((await logStorageStatus()).state, "not_configured");
          process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify(configuration);
        },
      );
      await t.test("SELECT alone is insufficient for collection", async () => {
        await storage.execute(
          `CREATE USER ${limitedUser} IDENTIFIED BY 'test-read-only'`,
        );
        await storage.execute(
          `GRANT SELECT ON towbar_logs_test.* TO ${limitedUser}`,
        );
        const limited = {
          ...configuration,
          clickhouse: {
            ...configuration.clickhouse,
            username: limitedUser,
            password: "test-read-only",
          },
        };
        process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify(limited);
        assert.equal((await logStorageStatus()).code, "LOGS_PERMISSION_DENIED");
        await storage.execute(
          `GRANT INSERT, CREATE TABLE, ALTER ON towbar_logs_test.* TO ${limitedUser}`,
        );
        await ensureLogSchema(new LogStorage(limited));
        assert.equal((await logStorageStatus()).state, "ready");
        process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify(configuration);
      });
      await t.test(
        "an existing table with the wrong engine is rejected without resetting it",
        async () => {
          await storage.execute(`CREATE DATABASE ${temporaryDatabase}`);
          await temporary.execute(
            logTableSchema.replace(
              "ReplacingMergeTree(dedupVersion)",
              "MergeTree",
            ),
          );
          await assert.rejects(ensureLogSchema(temporary), {
            code: "LOGS_SCHEMA_INCOMPATIBLE",
          });
          const [table] = await temporary.execute<{ statement: string }>(
            "SHOW CREATE TABLE log_records FORMAT JSONEachRow",
          );
          assert(table?.statement.includes("ENGINE = MergeTree"));
        },
      );
      await t.test(
        "shortened retention requests physical deletion and cannot be undone by increasing it",
        async () => {
          const at = new Date(Date.now() - 2 * 86400000).toISOString();
          await storage.execute(
            "INSERT INTO log_records FORMAT JSONEachRow",
            {},
            {
              data: JSON.stringify({
                workspaceId,
                eventId: "f".repeat(64),
                timestamp: at,
                observedAt: at,
                ingestedAt: at,
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
                serverId: randomUUID(),
                workloadId: randomUUID(),
                workloadName: "Expired history",
                deploymentId: null,
                previewId: null,
                environment: "production",
                containerId: "a".repeat(64),
                service: "",
                stream: "stdout",
                severity: "info",
                body: "Expired after shorter retention",
                attributes: {},
                traceId: null,
                spanId: null,
                visibility: "all",
                truncated: false,
              }),
            },
          );
          await retainLogCutoff(workspaceId, 7);
          process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify({
            ...configuration,
            retentionDays: 1,
          });
          await maintainLogRetention();
          const deadline = Date.now() + 15000;
          let remaining = 1;
          while (remaining && Date.now() < deadline) {
            const [row] = await storage.execute<{ count: number }>(
              "SELECT count() AS count FROM log_records WHERE workspaceId = {workspaceId:UUID} FORMAT JSONEachRow",
              { workspaceId },
            );
            remaining = Number(row?.count ?? 0);
            if (remaining) await delay(100);
          }
          assert.equal(remaining, 0);
          const [state] = await db
            .select()
            .from(logRetentionState)
            .where(eq(logRetentionState.workspaceId, workspaceId));
          assert(state?.prunedBeforeAt);
          process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify(configuration);
          await maintainLogRetention();
          const increased = await retainLogCutoff(workspaceId, 7);
          assert(increased >= state.cutoffAt);
          delete process.env.TOWBAR_LOGS_CONFIG_JSON;
          assert.deepEqual(await maintainLogRetention(), { requested: 0 });
        },
      );
    } finally {
      process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify(configuration);
      await storage.execute(`DROP DATABASE IF EXISTS ${temporaryDatabase}`);
      await storage.execute(`DROP USER IF EXISTS ${limitedUser}`);
      await storage.execute(
        "ALTER TABLE log_records DELETE WHERE workspaceId = {workspaceId:UUID}",
        { workspaceId },
      );
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await closeDatabase();
    }
  },
);
