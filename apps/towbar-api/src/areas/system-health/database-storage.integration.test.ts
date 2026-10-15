import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { databaseStorageSamples } from "@workspace/towbar-database/schema";

const databaseUrl = process.env.TOWBAR_TEST_DATABASE_URL;

void test(
  "database storage separates analytics and preserves historic samples",
  { skip: !databaseUrl },
  async () => {
    assert(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));
    delete process.env.TOWBAR_LOGS_CONFIG_JSON;
    process.env.DATABASE_TOWBAR_URL = databaseUrl;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { recordDatabaseStorageSample, getDatabaseStorage } =
      await import("./database-storage.js");
    const database = getTowbarDatabase();
    const oldSampleAt = new Date(Date.now() - 60_000);
    let newSampleAt: Date | undefined;
    try {
      await database.insert(databaseStorageSamples).values({
        sampledAt: oldSampleAt,
        towbarBytes: 100,
        monitoringBytes: 200,
      });
      const sample = await recordDatabaseStorageSample();
      assert(sample);
      newSampleAt = sample.sampledAt;
      const [analyticsTable] = await database.execute<{ bytes: string }>(sql`
      select pg_total_relation_size('towbar_analytics_samples')::text as bytes
    `);
      assert(analyticsTable);
      assert(sample.analyticsBytes !== null);
      assert(sample.analyticsBytes >= Number(analyticsTable.bytes));
      assert(sample.monitoringBytes > 0);
      assert(sample.towbarBytes > 0);

      const samples = await getDatabaseStorage();
      const historic = samples.find(
        (row) => row.sampledAt === oldSampleAt.toISOString(),
      );
      const current = samples.find(
        (row) => row.sampledAt === sample.sampledAt.toISOString(),
      );
      assert.equal(historic?.analyticsBytes, null);
      assert.equal(historic?.logsBytes, null);
      assert.equal(current?.logsBytes, null);
      assert.equal(current?.analyticsBytes, sample.analyticsBytes);
      if (process.env.TOWBAR_TEST_CLICKHOUSE_URL) {
        process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify({
          clickhouse: {
            endpoint: process.env.TOWBAR_TEST_CLICKHOUSE_URL,
            database: "towbar_logs_test",
            username: "logs_test",
            password: "logs_test",
          },
        });
        const reading = await recordDatabaseStorageSample();
        assert(reading);
        assert(reading.logsBytes !== null && reading.logsBytes >= 0);
        assert.equal(reading.logsError, null);
        assert(reading.towbarBytes > 0);
        await database
          .delete(databaseStorageSamples)
          .where(eq(databaseStorageSamples.sampledAt, reading.sampledAt));
      }
      process.env.TOWBAR_LOGS_CONFIG_JSON = "invalid";
      const unavailable = await recordDatabaseStorageSample();
      assert(unavailable);
      assert(unavailable.towbarBytes > 0);
      assert.equal(unavailable.logsBytes, null);
      assert.match(unavailable.logsError!, /configuration is invalid/);
      const recorded = (await getDatabaseStorage()).find(
        (row) => row.sampledAt === unavailable.sampledAt.toISOString(),
      );
      assert.equal(recorded?.logsError, unavailable.logsError);
      await database
        .delete(databaseStorageSamples)
        .where(eq(databaseStorageSamples.sampledAt, unavailable.sampledAt));
    } finally {
      await database
        .delete(databaseStorageSamples)
        .where(eq(databaseStorageSamples.sampledAt, oldSampleAt));
      if (newSampleAt)
        await database
          .delete(databaseStorageSamples)
          .where(eq(databaseStorageSamples.sampledAt, newSampleAt));
      await closeDatabase();
    }
  },
);
