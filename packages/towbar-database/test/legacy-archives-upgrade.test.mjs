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
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

for (const previousVersion of ["0030", "0031"]) {
  test(
    `upgrade from ${previousVersion} preserves legacy archive provenance and current owners`,
    { skip: !url },
    async () => {
      assert(new URL(url).pathname.endsWith("_test"));
      const admin = postgres(url, { max: 1, onnotice() {} });
      const name = `legacy_${randomUUID().replaceAll("-", "")}_test`;
      const folder = await mkdtemp(path.join(tmpdir(), "towbar-migrations-"));
      let client;
      try {
        await admin.unsafe(`CREATE DATABASE "${name}"`);
        const databaseUrl = new URL(url);
        databaseUrl.pathname = `/${name}`;
        client = postgres(databaseUrl.toString(), { max: 1, onnotice() {} });
        await cp(migrationsFolder, folder, { recursive: true });
        const journalPath = path.join(folder, "meta/_journal.json");
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        journal.entries = journal.entries.filter(
          (entry) => entry.idx <= Number(previousVersion),
        );
        await writeFile(journalPath, JSON.stringify(journal));
        const migrationClient = postgres(databaseUrl.toString(), {
          max: 1,
          onnotice() {},
        });
        try {
          await migrate(drizzle(migrationClient), { migrationsFolder: folder });
        } finally {
          await migrationClient.end();
        }
        const workspace = randomUUID(),
          source = randomUUID(),
          installation = randomUUID(),
          environment = randomUUID(),
          server = randomUUID();
        await client`insert into towbar_workspaces (id,slug,name) values (${workspace},${workspace},'Legacy upgrade')`;
        await client`insert into towbar_integration_installations (id,workspace_id,provider,external_id,principal_name,principal_type) values (${installation},${workspace},'github',${installation},'test','Organization')`;
        await client`insert into towbar_sources (id,workspace_id,integration_installation_id,repository_owner,repository_name) values (${source},${workspace},${installation},'test','test')`;
        await client`insert into towbar_source_environments (id,source_id,name,branch) values (${environment},${source},'production','main')`;
        await client`insert into towbar_servers (id,workspace_id,canonical_ip,config,config_digest) values (${server},${workspace},'192.0.2.10','{}',${"a".repeat(64)})`;
        const pairs = [];
        // Later archive dates prove the direct-upgrade path captures archived_at,
        // rather than guessing from a retirement created after lifecycle shipped.
        const archivedAt =
          previousVersion === "0030"
            ? "2026-10-17T15:00:00Z"
            : "2026-10-10T14:51:33Z";
        for (const id of [
          "legacy-postgres",
          "live-duplicate",
          "multiple-declarations",
        ]) {
          const config = {
            kind: "postgres",
            id,
            name: id,
            server: "192.0.2.10",
            image: "postgres:18",
            container: {
              volumes: [
                { name: "data", mountPath: "/var/lib/postgresql/data" },
              ],
            },
          };
          const pair = { config, old: randomUUID(), current: randomUUID() };
          for (const [workloadId, kind] of [
            [pair.old, "app"],
            [pair.current, "postgres"],
          ]) {
            const entity = randomUUID();
            await client`insert into towbar_source_entities (id,source_id,entity_type,manifest_id,resource_type) values (${entity},${source},${kind === "app" ? "app" : "resource"},${id},${kind === "app" ? null : "postgres"})`;
            const stored = kind === "app" ? { ...config, kind: "app" } : config;
            await client`insert into towbar_apps (id,workspace_id,source_id,server_id,entity_id,source_environment_id,required_secrets,manifest_id,kind,name,config,config_digest,source_revision) values (${workloadId},${workspace},${source},${server},${entity},${environment},'{}',${id},${kind},${id},${client.json(stored)},${"a".repeat(64)},${"a".repeat(40)})`;
            if (previousVersion === "0031") {
              await client`update towbar_apps set manifest_state='conflict', retired_at=${workloadId === pair.old && id !== "live-duplicate" ? archivedAt : null} where id=${workloadId}`;
            } else if (workloadId === pair.old && id !== "live-duplicate") {
              await client`update towbar_apps set archived_at=${archivedAt} where id=${workloadId}`;
            }
          }
          pairs.push(pair);
        }
        const manifest = {
          apps: [],
          resources: [...pairs.map((pair) => pair.config), pairs[2].config],
          compose: [],
        };
        if (previousVersion === "0031") {
          await client`insert into towbar_repository_manifests (workspace_id,source_environment_id,commit_sha,manifest) values (${workspace},${environment},${"a".repeat(40)},${client.json(manifest)})`;
        } else {
          const sync = randomUUID();
          await client`insert into towbar_source_syncs (id,source_id,source_environment_id,mapping_revision,commit_sha,normalized_manifest) values (${sync},${source},${environment},${randomUUID()},${"a".repeat(40)},${client.json(manifest)})`;
          await client`update towbar_source_environments set latest_successful_sync_id=${sync} where id=${environment}`;
        }
        const before =
          await client`select id,config,config_digest,source_id,source_environment_id from towbar_apps order by id`;
        await runTowbarMigrations({
          databaseUrl: databaseUrl.toString(),
          logger: { info() {}, error() {} },
        });
        const after =
          await client`select id,config,config_digest,source_id,source_environment_id from towbar_apps order by id`;
        assert.deepEqual(after, before);
        const rows =
          await client`select id,manifest_state,legacy_archived_at,archived_at from towbar_apps`;
        assert.equal(
          rows.find((row) => row.id === pairs[0].current).manifest_state,
          "active",
        );
        const legacy = rows.find((row) => row.id === pairs[0].old);
        assert.equal(legacy.manifest_state, "retired");
        assert.equal(
          legacy.legacy_archived_at.toISOString(),
          new Date(archivedAt).toISOString(),
        );
        assert.equal(legacy.archived_at, null);
        for (const pair of pairs.slice(1)) {
          assert.equal(
            rows.find((row) => row.id === pair.current).manifest_state,
            "conflict",
          );
          assert.equal(
            rows.find((row) => row.id === pair.old).manifest_state,
            "conflict",
          );
        }
        assert.equal(
          rows.find((row) => row.id === pairs[1].old).legacy_archived_at,
          null,
        );
        await runTowbarMigrations({
          databaseUrl: databaseUrl.toString(),
          logger: { info() {}, error() {} },
        });
        assert.equal(
          (await client`select count(*)::int as count from towbar_apps`)[0]
            .count,
          6,
        );
      } finally {
        await client?.end();
        await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
        await rm(folder, { recursive: true, force: true });
      }
    },
  );
}
