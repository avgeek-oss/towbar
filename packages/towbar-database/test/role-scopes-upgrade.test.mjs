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
  "role scopes retain full administrative keys and require consent for granular credentials",
  { skip: !url },
  async () => {
    assert(new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} });
    const name = `role_scopes_${randomUUID().replaceAll("-", "")}_test`;
    const previous = await mkdtemp(join(tmpdir(), "towbar-role-scopes-"));
    let client;
    try {
      await cp(folder, previous, { recursive: true });
      const journal = JSON.parse(
        await readFile(join(previous, "meta/_journal.json"), "utf8"),
      );
      journal.entries = journal.entries.filter((entry) => entry.idx < 36);
      await writeFile(
        join(previous, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      const target = new URL(url);
      target.pathname = `/${name}`;
      client = postgres(target.toString(), { max: 1, onnotice() {} });
      await migrate(drizzle(client), { migrationsFolder: previous });
      const [workspace] =
        await client`INSERT INTO towbar_workspaces(name,slug) VALUES('Scopes','scopes') RETURNING id`;
      const [user] =
        await client`INSERT INTO towbar_users(email,display_name) VALUES('scopes@example.test','Scope owner') RETURNING id`;
      await client`INSERT INTO towbar_workspace_members(workspace_id,user_id,role) VALUES(${workspace.id},${user.id},'admin')`;
      for (const mode of ["full-admin", "scoped"]) {
        const [key] =
          await client`INSERT INTO towbar_api_keys(config_id,reference_id,name,key) VALUES('personal',${user.id},${mode},${"hash-" + mode}) RETURNING id`;
        await client`INSERT INTO towbar_api_key_policies(key_id,workspace_id,scope,owner_user_id,creator_user_id,access,include_admin,permission_mode,grants,creation_digest) VALUES(${key.id},${workspace.id},'personal',${user.id},${user.id},'edit',true,${mode},'["deployment.create"]','fixture')`;
      }
      await client`INSERT INTO towbar_mcp_oauth_requests(client_id,client_name,client_trust,redirect_uri,resource,scope,challenge,expires_at,user_id,workspace_id,grants,code_hash) VALUES('fixture','Fixture','unverified','http://localhost/callback','http://localhost/v1/mcp','mcp:read mcp:write','challenge',now()+interval '5 minutes',${user.id},${workspace.id},'["repository.read"]','unexchanged')`;
      const keys = await client`SELECT * FROM towbar_api_keys ORDER BY id`;
      await migrate(drizzle(client), { migrationsFolder: folder });
      await migrate(drizzle(client), { migrationsFolder: folder });
      assert.deepEqual(
        await client`SELECT * FROM towbar_api_keys ORDER BY id`,
        keys,
      );
      const policies =
        await client`SELECT k.name,p.grants,p.revoked_at FROM towbar_api_key_policies p JOIN towbar_api_keys k ON k.id=p.key_id ORDER BY k.name`;
      assert.deepEqual(policies[0].grants, ["viewer", "member", "admin"]);
      assert.equal(policies[0].revoked_at, null);
      assert.deepEqual(policies[1].grants, []);
      assert(policies[1].revoked_at);
      const [request] =
        await client`SELECT consumed_at,code_hash,grants,expires_at<=now() AS expired FROM towbar_mcp_oauth_requests`;
      assert(request.consumed_at);
      assert.equal(request.code_hash, null);
      assert.equal(request.grants, null);
      assert.equal(request.expired, true);
      assert.equal(
        (
          await client`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='towbar_api_key_policies' AND column_name='permission_mode'`
        )[0].count,
        0,
      );
      await assert.rejects(
        client`UPDATE towbar_api_key_policies SET grants='["deployment.create"]'`,
        { code: "23514" },
      );
    } finally {
      await client?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
      await rm(previous, { recursive: true, force: true });
    }
  },
);
