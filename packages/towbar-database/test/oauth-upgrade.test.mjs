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
test(
  "OAuth upgrade preserves existing personal and team API keys",
  { skip: !url },
  async () => {
    assert(new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} }),
      name = `oauth_upgrade_${randomUUID().replaceAll("-", "")}_test`;
    const previous = await mkdtemp(join(tmpdir(), "towbar-oauth-upgrade-"));
    let client;
    try {
      await cp(folder, previous, { recursive: true });
      const journal = JSON.parse(
        await readFile(join(previous, "meta/_journal.json"), "utf8"),
      );
      const historicalEntries = journal.entries.filter(
        (entry) => entry.idx < 36,
      );
      const oauthIndex = journal.entries.findIndex(
        (entry) => entry.tag === "0013_mcp_oauth",
      );
      assert(oauthIndex >= 0);
      journal.entries = journal.entries.slice(0, oauthIndex);
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
      const [user] =
        await client`insert into towbar_users (email,display_name) values ('upgrade@example.test','Upgrade') returning id`;
      for (const scope of ["personal", "team"]) {
        const [key] =
          await client`insert into towbar_api_keys (config_id,reference_id,name,key,expires_at) values (${scope},${scope === "personal" ? user.id : workspace.id},${scope},${"existing-hash-" + scope},${scope === "personal" ? null : "2030-01-01T00:00:00Z"}) returning id`;
        await client`insert into towbar_api_key_policies (key_id,workspace_id,scope,owner_user_id,creator_user_id,access,include_admin,grants,creation_digest) values (${key.id},${workspace.id},${scope},${scope === "personal" ? user.id : null},${user.id},'edit',true,'["deployment.create"]','existing-digest')`;
      }
      const before =
        await client`select k.*,p.grants,p.include_admin,p.scope from towbar_api_keys k join towbar_api_key_policies p on p.key_id=k.id order by k.id`;
      await writeFile(
        join(previous, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: historicalEntries }),
      );
      await migrate(drizzle(client), { migrationsFolder: previous });
      assert.deepEqual(
        await client`select k.*,p.grants,p.include_admin,p.scope from towbar_api_keys k join towbar_api_key_policies p on p.key_id=k.id order by k.id`,
        before,
      );
      const policies =
        await client`select token_type,oauth_client_id,oauth_resource from towbar_api_key_policies`;
      assert.equal(policies.length, 2);
      for (const policy of policies)
        assert.deepEqual(policy, {
          token_type: "api-key",
          oauth_client_id: null,
          oauth_resource: null,
        });
    } finally {
      await client?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
      await rm(previous, { recursive: true, force: true });
    }
  },
);
