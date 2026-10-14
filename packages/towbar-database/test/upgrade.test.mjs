import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { runTowbarMigrations } from "../dist/migrate.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

test("migration journal keeps notification destinations and failure subscriptions", async () => {
  const files = (await readdir(migrationsFolder)).filter((name) =>
    name.endsWith(".sql"),
  );
  assert.deepEqual(files, [
    "0002_curvy_wasp.sql",
    "0003_sad_gabe_jones.sql",
    "0004_brainy_alice.sql",
    "0005_high_reptil.sql",
    "0006_broken_hammerhead.sql",
    "0007_military_darkhawk.sql",
    "0008_remove_observability_integrations.sql",
    "0009_server_names.sql",
    "0010_services_datastores.sql",
    "0011_notification_deployment_failures.sql",
    "0012_database_storage_samples.sql",
    "0013_mcp_oauth.sql",
    "0014_scout_analytics.sql",
    "0015_host_upgrades.sql",
    "0016_incident_trigger_observation.sql",
    "0017_admin_key_permissions.sql",
    "0018_domain_claims.sql",
    "0019_github_accounts.sql",
    "001_team_access_v2.sql",
    "0020_preview_reporting_recovery.sql",
    "0021_passkey_recovery.sql",
    "0022_notification_reads.sql",
    "0023_analytics_storage_samples.sql",
    "0024_server_lifecycle_events.sql",
    "0025_mcp_admin_consent.sql",
    "0026_mcp_role_revocation.sql",
    "0027_server_cleanup.sql",
  ]);
  const journal = JSON.parse(
    await readFile(`${migrationsFolder}/meta/_journal.json`, "utf8"),
  );
  assert.equal(journal.entries.length, 27);
  assert.equal(journal.entries[0].tag, "001_team_access_v2");
  assert.equal(journal.entries[1].tag, "0002_curvy_wasp");
  assert.equal(journal.entries[2].tag, "0003_sad_gabe_jones");
  assert.equal(journal.entries[3].tag, "0004_brainy_alice");
  assert.equal(journal.entries[4].tag, "0005_high_reptil");
  assert.equal(journal.entries[5].tag, "0006_broken_hammerhead");
  assert.equal(journal.entries[6].tag, "0007_military_darkhawk");
  assert.equal(
    journal.entries[7].tag,
    "0008_remove_observability_integrations",
  );
  assert.equal(journal.entries[8].tag, "0009_server_names");
  assert.equal(journal.entries[9].tag, "0010_services_datastores");
  assert.equal(
    journal.entries[10].tag,
    "0011_notification_deployment_failures",
  );
  assert.equal(journal.entries[11].tag, "0012_database_storage_samples");
  assert.equal(journal.entries[12].tag, "0013_mcp_oauth");
  assert.equal(journal.entries[13].tag, "0014_scout_analytics");
  assert.equal(journal.entries[14].tag, "0015_host_upgrades");
  assert.equal(journal.entries[15].tag, "0016_incident_trigger_observation");
  assert.equal(journal.entries[16].tag, "0017_admin_key_permissions");
  assert.equal(journal.entries[17].tag, "0018_domain_claims");
  assert.equal(journal.entries[23].tag, "0024_server_lifecycle_events");
  assert.equal(journal.entries[24].tag, "0025_mcp_admin_consent");
  assert.equal(journal.entries[25].tag, "0026_mcp_role_revocation");
  assert.equal(journal.entries[26].tag, "0027_server_cleanup");
  const failureSubscriptions = await readFile(
    `${migrationsFolder}/0011_notification_deployment_failures.sql`,
    "utf8",
  );
  for (const destination of [
    "email_destinations",
    "slack_destinations",
    "telegram_destinations",
    "discord_route_settings",
    "webhook_route_settings",
  ])
    assert.match(
      failureSubscriptions,
      new RegExp(
        `ALTER TABLE "towbar_notification_${destination}" ADD COLUMN "deployment_failures"`,
        "u",
      ),
    );
  assert.match(
    await readFile(`${migrationsFolder}/0009_server_names.sql`, "utf8"),
    /ADD COLUMN "name" varchar\(120\)/u,
  );
  const retirement = await readFile(
    `${migrationsFolder}/0008_remove_observability_integrations.sql`,
    "utf8",
  );
  assert.match(
    retirement,
    /DROP TABLE IF EXISTS "towbar_server_integration_states"/u,
  );
  const migration = await readFile(
    `${migrationsFolder}/001_team_access_v2.sql`,
    "utf8",
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "uq_towbar_integration_workspace_provider" ON "towbar_integration_authorizations" USING btree \("workspace_id","provider"\)/u,
  );
  assert.match(
    migration,
    /CREATE FUNCTION towbar_record_deployable_ownership\(\) RETURNS trigger/u,
  );
  assert.match(
    migration,
    /CREATE FUNCTION towbar_require_active_server\(\) RETURNS trigger/u,
  );
  assert.match(
    migration,
    /CREATE FUNCTION towbar_merge_monitoring_metrics\(a jsonb, b jsonb\) RETURNS jsonb/u,
  );
  assert.equal(
    migration.match(/CREATE TRIGGER towbar_require_active_server/gu)?.length,
    9,
  );
  assert.match(
    migration,
    /CREATE TRIGGER towbar_monitoring_require_active_server/u,
  );
  assert.doesNotMatch(migration, /towbar_notification_destinations/u);
  assert.doesNotMatch(
    migration,
    /towbar_workspace_notification_provider_configurations/u,
  );
  assert.doesNotMatch(migration, /towbar_installation_setup/u);
  assert.doesNotMatch(
    migration,
    /towbar_(?:auth_sso|enterprise_identity|scim_)/u,
  );
  assert.doesNotMatch(migration, /'(?:oidc|saml|scim)'/u);
  assert.doesNotMatch(migration, /fluent[ -]?bit/iu);
  assert.doesNotMatch(migration, /aws.?secrets.?manager/iu);
  const cleanup = await readFile(
    `${migrationsFolder}/0002_curvy_wasp.sql`,
    "utf8",
  );
  assert.match(cleanup, /DELETE FROM "towbar_managed_secrets"/u);
  assert.doesNotMatch(cleanup, /'source:' \|\|/u);
  const email = await readFile(
    `${migrationsFolder}/0003_sad_gabe_jones.sql`,
    "utf8",
  );
  assert.match(email, /CREATE TABLE "towbar_notification_email_destinations"/u);
  assert.match(email, /CREATE TABLE "towbar_notification_email_routing"/u);
  const slack = await readFile(
    `${migrationsFolder}/0004_brainy_alice.sql`,
    "utf8",
  );
  assert.match(slack, /CREATE TABLE "towbar_notification_slack_destinations"/u);
  assert.match(slack, /CREATE TABLE "towbar_notification_slack_routing"/u);
  assert.doesNotMatch(slack, /towbar_notification_email_destinations/u);
  const discord = await readFile(
    `${migrationsFolder}/0005_high_reptil.sql`,
    "utf8",
  );
  assert.match(
    discord,
    /CREATE TABLE "towbar_notification_discord_route_settings"/u,
  );
  assert.doesNotMatch(discord, /towbar_notification_slack_destinations/u);
  const webhook = await readFile(
    `${migrationsFolder}/0007_military_darkhawk.sql`,
    "utf8",
  );
  assert.match(
    webhook,
    /CREATE TABLE "towbar_notification_webhook_route_settings"/u,
  );
  assert.doesNotMatch(webhook, /towbar_notification_discord_route_settings/u);
  const telegram = await readFile(
    `${migrationsFolder}/0006_broken_hammerhead.sql`,
    "utf8",
  );
  assert.match(
    telegram,
    /CREATE TABLE "towbar_notification_telegram_destinations"/u,
  );
  assert.match(
    telegram,
    /CREATE TABLE "towbar_notification_telegram_routing"/u,
  );
  assert.doesNotMatch(telegram, /towbar_notification_discord_route_settings/u);
});

test(
  "fresh installation applies v2 auth, tenancy and runtime safeguards",
  { skip: !url },
  async () => {
    assert(
      new URL(url).pathname.endsWith("_test"),
      "Use a dedicated test database ending in _test",
    );
    const admin = postgres(url, { max: 1, onnotice() {} });
    const databaseName = `towbar_fresh_${randomUUID().replaceAll("-", "")}_test`;
    let client;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      const databaseUrl = new URL(url);
      databaseUrl.pathname = `/${databaseName}`;
      client = postgres(databaseUrl.toString(), { max: 1, onnotice() {} });
      await migrate(drizzle(client), { migrationsFolder });
      await runTowbarMigrations({
        databaseUrl: databaseUrl.toString(),
        logger: { info() {}, error() {} },
      });
      const [{ count }] =
        await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
      assert.equal(count, 27);
      const roleTriggers =
        await client`select tgname from pg_trigger where tgname = 'towbar_revoke_mcp_on_role_change' and not tgisinternal`;
      assert.deepEqual(
        roleTriggers.map((row) => row.tgname),
        ["towbar_revoke_mcp_on_role_change"],
      );
      const roles =
        await client`select enumlabel from pg_enum join pg_type on pg_type.oid = enumtypid where typname = 'towbar_workspace_role' order by enumsortorder`;
      assert.deepEqual(
        roles.map((row) => row.enumlabel),
        ["admin", "member", "viewer"],
      );
      const columns =
        await client`select table_name, column_name from information_schema.columns where table_schema = 'public'`;
      for (const [table, column] of [
        ["towbar_scout_alert_incidents", "trigger_observation"],
        ["towbar_analytics_samples", "cells"],
        ["towbar_analytics_samples", "collected_at"],
        ["towbar_analytics_refresh", "requested_at"],
        ["towbar_servers", "canonical_ip"],
        ["towbar_servers", "name"],
        ["towbar_apps", "required_secrets"],
        ["towbar_deployments", "target_environment"],
        ["towbar_deployments", "domain_handoff_snapshot"],
        ["towbar_domain_claims", "hostname"],
        ["towbar_domain_claims", "pending_deployment_id"],
        ["towbar_deployments", "requested_by_actor"],
        ["towbar_source_syncs", "requested_by_actor"],
        ["towbar_api_key_policies", "creation_request_id"],
        ["towbar_api_key_policies", "permission_mode"],
        ["towbar_users", "must_change_password"],
        ["towbar_auth_recovery_codes", "code_hashes"],
        ["towbar_sessions", "authenticated_at"],
        ["towbar_preview_environments", "cleanup_requested_by_actor"],
        ["towbar_database_storage_samples", "sampled_at"],
        ["towbar_database_storage_samples", "towbar_bytes"],
        ["towbar_database_storage_samples", "monitoring_bytes"],
        ["towbar_database_storage_samples", "analytics_bytes"],
        ["towbar_server_observations", "hardware"],
        ["towbar_server_observations", "hardware_at"],
        ["towbar_server_observations", "instance_at"],
        ["towbar_server_observations", "boot_id"],
        ["towbar_server_observations", "boot_observed_at"],
        ["towbar_server_events", "at"],
        ["towbar_server_events", "type"],
        ["towbar_server_events", "detail"],
      ])
        assert(
          columns.some(
            (row) => row.table_name === table && row.column_name === column,
          ),
          `${table}.${column}`,
        );
      assert(
        !columns.some(
          (row) => row.table_name === "towbar_server_integration_states",
        ),
      );
      assert(
        !columns.some((row) => row.table_name === "towbar_auth_two_factors"),
      );
      const [{ merged }] =
        await client`select towbar_merge_monitoring_metrics('{"cpu":{"sum":3,"min":1,"max":2,"count":2}}', '{"cpu":{"sum":4,"min":4,"max":4,"count":1}}') as merged`;
      assert.deepEqual(merged, { cpu: { sum: 7, min: 1, max: 4, count: 3 } });
      const [workspace] =
        await client`insert into towbar_workspaces (slug, name) values ('fresh', 'Fresh install') returning id`;
      const [server] =
        await client`insert into towbar_servers (workspace_id, canonical_ip, config, config_digest, archived_at) values (${workspace.id}, '192.0.2.10', '{}', 'fixture', now()) returning id`;
      await assert.rejects(
        client`insert into towbar_server_checks (server_id) values (${server.id})`,
        { code: "23514" },
      );
      const triggers =
        await client`select tgname from pg_trigger where not tgisinternal`;
      assert.equal(
        triggers.filter((row) => row.tgname === "towbar_require_active_server")
          .length,
        9,
      );
      assert(
        triggers.some(
          (row) => row.tgname === "towbar_record_deployable_ownership",
        ),
      );
      assert(
        triggers.some(
          (row) => row.tgname === "towbar_monitoring_require_active_server",
        ),
      );
      const integrationIndexes =
        await client`select indexname from pg_indexes where schemaname = 'public' and tablename = 'towbar_integration_authorizations'`;
      assert(
        integrationIndexes.some(
          (row) => row.indexname === "uq_towbar_integration_workspace_provider",
        ),
        "integration providers must be unique within a workspace",
      );
    } finally {
      await client?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  },
);
