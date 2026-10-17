import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
const url = process.env.TOWBAR_TEST_DATABASE_URL;
const folder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function migrateDatabase(databaseUrl, migrationsFolder) {
  const connection = postgres(databaseUrl, { max: 1, onnotice() {} });
  try {
    await migrate(drizzle(connection), { migrationsFolder });
  } finally {
    await connection.end();
  }
}

test(
  "manifest lifecycle upgrade preserves duplicate workloads, verified claims, ciphertext and old retirements",
  { skip: !url },
  async () => {
    assert(new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} }),
      name = `manifest_lifecycle_${randomUUID().replaceAll("-", "")}_test`;
    const previous = await mkdtemp(join(tmpdir(), "towbar-manifest-upgrade-"));
    let client;
    try {
      await cp(folder, previous, { recursive: true });
      const journal = JSON.parse(
        await readFile(join(previous, "meta/_journal.json"), "utf8"),
      );
      journal.entries = journal.entries.filter(
        (entry) => entry.tag !== "0031_manifest_lifecycle",
      );
      await writeFile(
        join(previous, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      const isolated = new URL(url);
      isolated.pathname = `/${name}`;
      await migrateDatabase(isolated.href, previous);
      client = postgres(isolated.href, { max: 1, onnotice() {} });
      const [workspace] =
        await client`insert into towbar_workspaces(name,slug) values ('Manifest upgrade','manifest-upgrade') returning id`;
      const [installation] =
        await client`insert into towbar_integration_installations(workspace_id,provider,external_id,principal_name,principal_type) values (${workspace.id},'github','manifest-upgrade','example','Organization') returning id`;
      const [server] =
        await client`insert into towbar_servers(workspace_id,canonical_ip,config,config_digest) values (${workspace.id},'192.0.2.10','{}','server') returning id`;
      const originals = [];
      let oldRetirement;
      for (const repository of ["first", "second"]) {
        const [source] =
          await client`insert into towbar_sources(workspace_id,integration_installation_id,repository_owner,repository_name) values (${workspace.id},${installation.id},'example',${repository}) returning id`;
        const [environment] =
          await client`insert into towbar_source_environments(source_id,name,branch) values (${source.id},'production','main') returning *`;
        const [entity] =
          await client`insert into towbar_source_entities(source_id,entity_type,manifest_id,resource_type) values (${source.id},'resource','postgres','postgres') returning id`;
        const config = {
          id: "postgres",
          kind: "postgres",
          name: repository,
          image: "postgres:17",
          server: "192.0.2.10",
          sourceBranch: "main",
          container: {},
          autoDeploy: false,
        };
        const required = {
          build: [],
          runtime: ["PASSWORD"],
          preDeploy: [],
          postDeploy: [],
        };
        const [app] =
          await client`insert into towbar_apps(workspace_id,source_id,server_id,entity_id,source_environment_id,required_secrets,manifest_id,kind,name,config,config_digest,source_revision) values (${workspace.id},${source.id},${server.id},${entity.id},${environment.id},${client.json(required)},'postgres','postgres',${repository},${client.json(config)},'original-digest','original-revision') returning *`;
        const [sync] =
          await client`insert into towbar_source_syncs(source_id,source_environment_id,mapping_revision,status,commit_sha,normalized_manifest) values (${source.id},${environment.id},${environment.mapping_revision},'succeeded','original-commit',${client.json({ version: 2, source: { branch: "main" }, apps: [], resources: [config], requiredSecrets: { "resource:postgres": required } })}) returning id`;
        await client`update towbar_source_environments set latest_successful_sync_id=${sync.id} where id=${environment.id}`;
        await client`insert into towbar_managed_secrets(workspace_id,source_id,app_id,owner,environment,stage,encrypted_payload,keys,revision) values (${workspace.id},${source.id},${app.id},${`app:${app.id}`},'production','deployment',${client.json({ ciphertext: "preserve-original-envelope" })},${client.json(["PASSWORD"])},${randomUUID()})`;
        if (repository === "first") {
          const [retiredEntity] =
            await client`insert into towbar_source_entities(source_id,entity_type,manifest_id) values (${source.id},'app','old-worker') returning id`;
          [oldRetirement] =
            await client`insert into towbar_apps(workspace_id,source_id,server_id,entity_id,source_environment_id,required_secrets,manifest_id,kind,name,config,config_digest,source_revision,archived_at) values (${workspace.id},${source.id},${server.id},${retiredEntity.id},${environment.id},${client.json(required)},'old-worker','app','Old worker','{}','old-digest','old-commit',now()) returning *`;
        }
        originals.push(app);
      }
      const secrets =
        await client`select * from towbar_managed_secrets order by id`;
      await migrateDatabase(isolated.href, folder);
      await migrateDatabase(isolated.href, folder);
      const upgraded = await client`select * from towbar_apps order by id`;
      assert.equal(upgraded.length, 3);
      assert(oldRetirement);
      assert.deepEqual(
        upgraded.find((app) => app.id === oldRetirement.id),
        {
          ...oldRetirement,
          archived_at: null,
          manifest_state: "retired",
          retired_at: oldRetirement.archived_at,
        },
      );
      for (const original of originals) {
        const actual = upgraded.find((app) => app.id === original.id);
        assert.deepEqual(actual, {
          ...original,
          manifest_state: "conflict",
          retired_at: null,
        });
      }
      assert.deepEqual(
        await client`select * from towbar_managed_secrets order by id`,
        secrets,
      );
      const claims =
        await client`select commit_sha,manifest from towbar_repository_manifests`;
      assert.equal(claims.length, 2);
      assert(
        claims.every(
          (claim) =>
            claim.commit_sha === "original-commit" &&
            claim.manifest.resources[0].id === "postgres",
        ),
      );
    } finally {
      if (client) await client.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(previous, { recursive: true, force: true });
    }
  },
);
