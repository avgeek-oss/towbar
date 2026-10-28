import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { runTowbarMigrations } from "../dist/migrate.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
test(
  "retires a paused upgrade and providers while preserving repository and delivery history",
  { skip: !url },
  async () => {
    assert(new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} });
    const name = `retired_${randomUUID().replaceAll("-", "")}_test`;
    const folder = await mkdtemp(
      path.join(tmpdir(), "towbar-retired-features-"),
    );
    let client;
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      const databaseUrl = new URL(url);
      databaseUrl.pathname = `/${name}`;
      client = postgres(databaseUrl.href, { max: 1, onnotice() {} });
      await cp(fileURLToPath(new URL("../drizzle", import.meta.url)), folder, {
        recursive: true,
      });
      const journalPath = path.join(folder, "meta/_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      journal.entries = journal.entries.filter((entry) => entry.idx < 35);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(drizzle(client), { migrationsFolder: folder });
      const workspace = randomUUID(),
        source = randomUUID(),
        authorization = randomUUID(),
        environment = randomUUID(),
        event = randomUUID();
      await client`insert into towbar_workspaces (id, slug, name) values (${workspace}, ${workspace}, 'Retired features')`;
      await client`insert into towbar_integration_authorizations (id, workspace_id, slug, name, provider, encrypted_payload) values (${authorization}, ${workspace}, 'gitlab', 'GitLab', 'gitlab', '{"fixture":true}')`;
      await client`insert into towbar_sources (id, workspace_id, provider, integration_authorization_id, provider_repository_id, repository_owner, repository_name) values (${source}, ${workspace}, 'gitlab', ${authorization}, '123', 'example', 'platform')`;
      await client`insert into towbar_source_environments (id, source_id, name, branch, previews_enabled) values (${environment}, ${source}, 'production', 'main', true)`;
      await client`insert into towbar_notification_events (id, workspace_id, source_id, dedupe_key, type, category, payload, occurred_at) values (${event}, ${workspace}, ${source}, 'fixture', 'deployment.failed', 'deployments', '{}', now())`;
      await client`insert into towbar_notification_deliveries (event_id, destination_key, provider, state) values (${event}, 'discord-pending', 'discord', 'pending'), (${event}, 'telegram-retrying', 'telegram', 'retrying'), (${event}, 'discord-history', 'discord', 'succeeded'), (${event}, 'slack-pending', 'slack', 'pending')`;
      await client`update towbar_upgrade_admission set job_id = ${randomUUID()}`;
      await runTowbarMigrations({
        databaseUrl: databaseUrl.href,
        logger: { info() {}, error() {} },
      });
      assert.equal(
        (
          await client`select count(*)::int as count from pg_trigger where tgname = 'towbar_upgrade_guard'`
        )[0].count,
        0,
      );
      for (const table of [
        "towbar_upgrade_admission",
        "towbar_upgrade_leases",
        "towbar_upgrade_blockers",
        "towbar_notification_discord_route_settings",
        "towbar_notification_telegram_destinations",
        "towbar_notification_telegram_routing",
        "towbar_integration_authorization_attempts",
      ]) {
        assert.equal(
          (await client`select to_regclass(${table}) as name`)[0].name,
          null,
          table,
        );
      }
      const [repository] =
        await client`select status, auto_deploy_paused, archived_at from towbar_sources where id = ${source}`;
      assert.equal(repository.status, "archived");
      assert.equal(repository.auto_deploy_paused, true);
      assert(repository.archived_at);
      const [mapping] =
        await client`select auto_deploy_paused, previews_enabled, disconnected_at from towbar_source_environments where id = ${environment}`;
      assert.equal(mapping.auto_deploy_paused, true);
      assert.equal(mapping.previews_enabled, false);
      assert(mapping.disconnected_at);
      const [connection] =
        await client`select disconnected_at, encrypted_payload from towbar_integration_authorizations where id = ${authorization}`;
      assert(connection.disconnected_at);
      assert.equal(connection.encrypted_payload, null);
      const deliveries =
        await client`select destination_key, state, last_error_code from towbar_notification_deliveries order by destination_key`;
      assert.deepEqual(
        deliveries.map((delivery) => [
          delivery.destination_key,
          delivery.state,
          delivery.last_error_code,
        ]),
        [
          ["discord-history", "succeeded", null],
          ["discord-pending", "failed", "PROVIDER_REMOVED"],
          ["slack-pending", "pending", null],
          ["telegram-retrying", "failed", "PROVIDER_REMOVED"],
        ],
      );
      await assert.rejects(
        client`update towbar_sources set status = 'active' where id = ${source}`,
        { code: "23514" },
      );
      await runTowbarMigrations({
        databaseUrl: databaseUrl.href,
        logger: { info() {}, error() {} },
      });
    } finally {
      await client?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(folder, { recursive: true, force: true });
    }
  },
);
