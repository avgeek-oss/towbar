import { asc, sql } from "drizzle-orm";

import { databaseStorageSamples } from "@workspace/towbar-database/schema";

import { getLogConfiguration } from "../logs/configuration.js";
import { LogStorage } from "../logs/storage.js";
import { HttpError } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";

export async function recordDatabaseStorageSample() {
  const database = getTowbarDatabase();
  const [size] = await database.execute<{
    towbarBytes: string;
    monitoringBytes: string;
    analyticsBytes: string;
  }>(sql`
    select
      coalesce(sum(pg_total_relation_size(c.oid)) filter (
        where left(c.relname, length('towbar_monitoring_')) <> 'towbar_monitoring_'
          and left(c.relname, length('towbar_scout_')) <> 'towbar_scout_'
          and left(c.relname, length('towbar_analytics_')) <> 'towbar_analytics_'
      ), 0)::text as "towbarBytes",
      coalesce(sum(pg_total_relation_size(c.oid)) filter (
        where left(c.relname, length('towbar_monitoring_')) = 'towbar_monitoring_'
          or left(c.relname, length('towbar_scout_')) = 'towbar_scout_'
      ), 0)::text as "monitoringBytes",
      coalesce(sum(pg_total_relation_size(c.oid)) filter (
        where left(c.relname, length('towbar_analytics_')) = 'towbar_analytics_'
      ), 0)::text as "analyticsBytes"
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema()
      and c.relkind in ('r', 'p')
      and left(c.relname, length('towbar_')) = 'towbar_'
  `);
  if (!size) throw new Error("Could not read the Towbar table sizes");
  const towbarBytes = Number(size.towbarBytes);
  const monitoringBytes = Number(size.monitoringBytes);
  const analyticsBytes = Number(size.analyticsBytes);
  if (
    !Number.isSafeInteger(towbarBytes) ||
    !Number.isSafeInteger(monitoringBytes) ||
    !Number.isSafeInteger(analyticsBytes)
  )
    throw new Error("Towbar database size exceeds the supported range");

  const logStorage = await readLogStorageUsage();
  const [sample] = await database
    .insert(databaseStorageSamples)
    .values({ towbarBytes, monitoringBytes, analyticsBytes, ...logStorage })
    .returning();
  await database
    .delete(databaseStorageSamples)
    .where(
      sql`${databaseStorageSamples.sampledAt} < now() - interval '90 days'`,
    );
  return sample;
}

export async function getDatabaseStorage() {
  const samples = await getTowbarDatabase()
    .select()
    .from(databaseStorageSamples)
    .where(
      sql`${databaseStorageSamples.sampledAt} >= now() - interval '90 days'`,
    )
    .orderBy(asc(databaseStorageSamples.sampledAt));
  return samples.map((sample) => ({
    sampledAt: sample.sampledAt.toISOString(),
    towbarBytes: sample.towbarBytes,
    monitoringBytes: sample.monitoringBytes,
    analyticsBytes: sample.analyticsBytes,
    logsBytes: sample.logsBytes,
    logsError: sample.logsError,
  }));
}

export async function readLogStorageUsage(): Promise<{
  logsBytes: number | null;
  logsError: string | null;
}> {
  try {
    const configuration = getLogConfiguration();
    if (!configuration) return { logsBytes: null, logsError: null };
    const [size] = await new LogStorage(configuration).execute<{
      bytes: string;
    }>(
      "SELECT toString(sum(bytes_on_disk)) AS bytes FROM system.parts WHERE active AND database = {database:String} AND table = 'log_records' FORMAT JSONEachRow",
      { database: configuration.clickhouse.database },
      { readOnly: true },
    );
    const bytes = size?.bytes === undefined ? NaN : Number(size.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new HttpError(
        503,
        "LOGS_STORAGE_RESPONSE",
        "ClickHouse returned an invalid log storage size.",
      );
    return { logsBytes: bytes, logsError: null };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return {
      logsBytes: null,
      logsError:
        error.code === "LOGS_PERMISSION_DENIED"
          ? "ClickHouse storage usage requires SELECT access to system.parts for the configured account. Log ingestion and search can continue without this chart permission."
          : error.publicMessage,
    };
  }
}
