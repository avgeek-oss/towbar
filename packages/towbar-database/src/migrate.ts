import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationLockKey = "towbar:migrations";

type MigrationLogger = Pick<typeof console, "error" | "info">;

export interface RunTowbarMigrationsOptions {
  databaseUrl?: string;
  logger?: MigrationLogger;
}

function resolveMigrationsFolder() {
  const candidates = [
    "/repo/packages/towbar-database/drizzle",
    "/app/packages/towbar-database/drizzle",
    path.resolve(directory, "../drizzle"),
  ];
  const folder = candidates.find((candidate) => existsSync(candidate));
  if (!folder) {
    throw new Error(
      `Towbar migrations folder not found. Checked: ${candidates.join(", ")}`,
    );
  }
  return folder;
}

export async function runTowbarMigrations(
  options: RunTowbarMigrationsOptions = {},
) {
  const databaseUrl =
    options.databaseUrl ??
    process.env.DATABASE_TOWBAR_MIGRATOR_URL ??
    process.env.DATABASE_TOWBAR_URL ??
    process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_TOWBAR_MIGRATOR_URL, DATABASE_TOWBAR_URL, or DATABASE_URL is required",
    );
  }

  const logger = options.logger ?? console;
  const client = postgres(databaseUrl, { max: 1 });
  const database = drizzle(client);
  let lockAcquired = false;
  try {
    logger.info("Acquiring Towbar migration lock");
    await client`select pg_advisory_lock(hashtext(${migrationLockKey}))`;
    lockAcquired = true;
    const [legacy] = await client<{ exists: boolean }[]>`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'towbar_apps'
          and column_name = 'archived_at'
      ) and not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'towbar_apps'
          and column_name = 'manifest_state'
      ) as exists
    `;
    if (legacy?.exists)
      await client`
        create temporary table towbar_legacy_archives on commit preserve rows as
        select id, archived_at from public.towbar_apps where archived_at is not null
      `;
    await migrate(database, { migrationsFolder: resolveMigrationsFolder() });
    logger.info("Towbar database migrations completed");
  } catch (error) {
    logger.error("Towbar database migration failed", error);
    throw error;
  } finally {
    if (lockAcquired) {
      await client`select pg_advisory_unlock(hashtext(${migrationLockKey}))`;
    }
    await client.end();
  }
}
