import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
const folder = fileURLToPath(new URL("../drizzle", import.meta.url));
// A real v2.0.0 administrative key snapshot, before server.collectLogs existed.
const historicalGrants = [
  "identity.read",
  "repository.read",
  "repository.connect",
  "repository.update",
  "repository.sync",
  "repository.disconnect",
  "deployment.read",
  "deployment.create",
  "deployment.cancel",
  "workload.read",
  "workload.operate",
  "resource.read",
  "resource.backup",
  "resource.restore",
  "server.read",
  "server.prepare",
  "server.update",
  "server.credentials",
  "server.remove",
  "secret.list",
  "secret.update",
  "sharedSecret.list",
  "sharedSecret.update",
  "sharedSecret.reference",
  "scout.read",
  "scout.configure",
  "alert.read",
  "alert.configure",
  "integration.manage",
  "githubInstallation.read",
  "notification.manage",
  "system.read",
  "system.manage",
];
test(
  "admin key upgrade recognizes full snapshots and preserves restricted credentials",
  { skip: !url },
  async () => {
    assert(new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} });
    const name = `admin_key_upgrade_${randomUUID().replaceAll("-", "")}_test`;
    const previous = await mkdtemp(join(tmpdir(), "towbar-admin-key-upgrade-"));
    let client;
    try {
      await cp(folder, previous, { recursive: true });
      const journal = JSON.parse(
        await readFile(join(previous, "meta/_journal.json"), "utf8"),
      );
      const historicalEntries = journal.entries.filter(
        (entry) => entry.idx < 36,
      );
      const index = journal.entries.findIndex(
        (entry) => entry.tag === "0017_admin_key_permissions",
      );
      assert(index > 0);
      journal.entries = journal.entries.slice(0, index);
      await writeFile(
        join(previous, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      const databaseUrl = new URL(url);
      databaseUrl.pathname = `/${name}`;
      client = postgres(databaseUrl.toString(), { max: 1, onnotice() {} });
      await migrate(drizzle(client), { migrationsFolder: previous });
      const [workspace] =
        await client`insert into towbar_workspaces (name,slug) values ('Upgrade','upgrade') returning id`;
      const [owner] =
        await client`insert into towbar_users (email,display_name) values ('admin@example.test','Admin') returning id`;
      const [member] =
        await client`insert into towbar_users (email,display_name) values ('member@example.test','Member') returning id`;
      await client`insert into towbar_workspace_members (workspace_id,user_id,role) values (${workspace.id},${owner.id},'admin'),(${workspace.id},${member.id},'member')`;
      const fixtures = [
        { name: "old-personal", full: true },
        { name: "old-team", scope: "team", full: true },
        {
          name: "current-personal",
          grants: [...historicalGrants, "server.collectLogs"],
          full: true,
        },
        {
          name: "current-team",
          scope: "team",
          grants: [...historicalGrants, "server.collectLogs"],
          full: true,
        },
        { name: "narrow-personal", grants: ["deployment.create"] },
        {
          name: "narrow-team",
          scope: "team",
          grants: historicalGrants.filter(
            (action) => action !== "system.manage",
          ),
        },
        { name: "versioned", version: 2 },
        { name: "unknown", grants: [...historicalGrants, "unknown.action"] },
        {
          name: "browser-grants",
          grants: [...historicalGrants, "secret.reveal"],
        },
        { name: "read", access: "read", includeAdmin: false },
        { name: "edit", includeAdmin: false },
        { name: "member", ownerId: member.id },
        { name: "oauth", tokenType: "mcp-oauth", includeAdmin: false },
        { name: "expired", expiresAt: "2020-01-01T00:00:00Z" },
        { name: "revoked", revokedAt: new Date().toISOString() },
        { name: "disabled", enabled: false },
      ];
      for (const fixture of fixtures) {
        const scope = fixture.scope ?? "personal";
        const ownerId = fixture.ownerId ?? owner.id;
        const [key] =
          await client`insert into towbar_api_keys (config_id,reference_id,name,key,expires_at,enabled) values (${scope},${scope === "personal" ? ownerId : workspace.id},${fixture.name},${"hash-" + fixture.name},${fixture.expiresAt ?? null},${fixture.enabled ?? true}) returning id`;
        await client`insert into towbar_api_key_policies (key_id,workspace_id,scope,owner_user_id,creator_user_id,access,include_admin,grants,creation_digest,version,token_type,oauth_client_id,oauth_resource,oauth_client_trust,revoked_at) values (${key.id},${workspace.id},${scope},${scope === "personal" ? ownerId : null},${owner.id},${fixture.access ?? "edit"},${fixture.includeAdmin ?? true},${JSON.stringify(fixture.grants ?? historicalGrants)}::jsonb,'existing-digest',${fixture.version ?? 1},${fixture.tokenType ?? "api-key"},${fixture.tokenType ? "client" : null},${fixture.tokenType ? "https://app.test/v1/mcp" : null},${fixture.tokenType ? "unverified" : null},${fixture.revokedAt ?? null})`;
      }
      const before =
        await client`select k.*,p.grants,p.include_admin,p.scope,p.revoked_at from towbar_api_keys k join towbar_api_key_policies p on p.key_id=k.id order by k.id`;
      await writeFile(
        join(previous, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: historicalEntries }),
      );
      await migrate(drizzle(client), { migrationsFolder: previous });
      assert.deepEqual(
        await client`select k.*,p.grants,p.include_admin,p.scope,p.revoked_at from towbar_api_keys k join towbar_api_key_policies p on p.key_id=k.id order by k.id`,
        before,
      );
      const policies =
        await client`select k.name,p.permission_mode,p.version from towbar_api_keys k join towbar_api_key_policies p on p.key_id=k.id order by k.name`;
      for (const fixture of fixtures) {
        const policy = policies.find((row) => row.name === fixture.name);
        assert.equal(
          policy.permission_mode,
          fixture.full ? "full-admin" : "scoped",
          fixture.name,
        );
        assert.equal(
          policy.version,
          (fixture.version ?? 1) + (fixture.full ? 1 : 0),
          fixture.name,
        );
      }
      await migrate(drizzle(client), { migrationsFolder: previous });
      assert.deepEqual(
        await client`select k.name,p.permission_mode,p.version from towbar_api_keys k join towbar_api_key_policies p on p.key_id=k.id order by k.name`,
        policies,
      );
      for (const fixture of ["oauth", "read", "edit"])
        await assert.rejects(
          client`update towbar_api_key_policies p set permission_mode='full-admin' from towbar_api_keys k where k.id=p.key_id and k.name=${fixture}`,
          { code: "23514" },
        );
      await assert.rejects(
        client`update towbar_api_key_policies set permission_mode='unknown'`,
        { code: "23514" },
      );
      await client`update towbar_api_key_policies p set include_admin=true from towbar_api_keys k where k.id=p.key_id and k.name='oauth'`;
      for (const mutation of [
        client`update towbar_api_key_policies p set access='read' from towbar_api_keys k where k.id=p.key_id and k.name='oauth'`,
        client`update towbar_api_key_policies p set permission_mode='full-admin' from towbar_api_keys k where k.id=p.key_id and k.name='oauth'`,
        client`update towbar_api_key_policies p set scope='team', owner_user_id=null from towbar_api_keys k where k.id=p.key_id and k.name='oauth'`,
      ])
        await assert.rejects(mutation, { code: "23514" });
    } finally {
      await client?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
      await rm(previous, { recursive: true, force: true });
    }
  },
);
