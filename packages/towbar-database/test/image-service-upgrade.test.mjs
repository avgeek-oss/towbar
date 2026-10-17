import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  decryptCredential,
  encryptCredential,
  normalizeDeploymentManifest,
} from "@workspace/towbar-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

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
  "image-to-service upgrade preserves identity, encrypted secrets and deployment history",
  { skip: !url },
  async () => {
    assert(new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} });
    const name = `image_upgrade_${randomUUID().replaceAll("-", "")}_test`;
    const previous = await mkdtemp(join(tmpdir(), "towbar-image-upgrade-"));
    let client;
    try {
      await cp(folder, previous, { recursive: true });
      const journal = JSON.parse(
        await readFile(join(previous, "meta/_journal.json"), "utf8"),
      );
      const index = journal.entries.findIndex(
        (entry) => entry.tag === "0010_services_datastores",
      );
      assert(index > 0);
      journal.entries = journal.entries.slice(0, index);
      await writeFile(
        join(previous, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      const isolated = new URL(url);
      isolated.pathname = `/${name}`;
      client = postgres(isolated.href, { max: 1, onnotice() {} });
      await migrateDatabase(isolated.href, previous);

      const [workspace] =
        await client`insert into towbar_workspaces (name,slug) values ('Image upgrade','image-upgrade') returning id`;
      const [installation] =
        await client`insert into towbar_integration_installations (workspace_id,provider,external_id,principal_name,principal_type) values (${workspace.id},'github','123','example','Organization') returning id`;
      const [source] =
        await client`insert into towbar_sources (workspace_id,integration_installation_id,repository_owner,repository_name) values (${workspace.id},${installation.id},'example','platform-services') returning id`;
      const [environment] =
        await client`insert into towbar_source_environments (source_id,name,branch) values (${source.id},'production','main') returning *`;
      const [server] =
        await client`insert into towbar_servers (workspace_id,canonical_ip,config,config_digest) values (${workspace.id},'192.0.2.10','{}','fixture') returning id`;
      const [entity] =
        await client`insert into towbar_source_entities (source_id,entity_type,manifest_id,resource_type) values (${source.id},'resource','infisical','image') returning id`;
      const config = {
        id: "infisical",
        kind: "image",
        name: "Infisical",
        image: "infisical/infisical:v0.165.15",
        server: "192.0.2.10",
        sourceBranch: "main",
        autoDeploy: false,
        container: {
          port: 8080,
          network: "platform-services",
          networkAlias: "infisical",
          command: [],
          volumes: [{ name: "infisical-data", mountPath: "/data" }],
        },
        health: { type: "http", path: "/api/status", timeoutSeconds: 180 },
      };
      const declarations = {
        build: [],
        runtime: ["AUTH_SECRET", "ENCRYPTION_KEY"],
        preDeploy: [],
        postDeploy: [],
      };
      const [app] =
        await client`insert into towbar_apps (workspace_id,source_id,server_id,entity_id,source_environment_id,required_secrets,manifest_id,kind,name,config,config_digest,source_revision) values (${workspace.id},${source.id},${server.id},${entity.id},${environment.id},${client.json(declarations)},'infisical','image','Infisical',${client.json(config)},'original-digest','original-commit') returning id`;
      const secretId = randomUUID();
      const masterKey = randomBytes(32);
      const associatedData = `${workspace.id}:app:${app.id}:production:deployment:${secretId}`;
      const values = {
        AUTH_SECRET: "original-auth",
        ENCRYPTION_KEY: "original-encryption",
      };
      const envelope = encryptCredential({
        associatedData,
        masterKey,
        value: values,
      });
      await client`insert into towbar_managed_secrets (id,workspace_id,source_id,app_id,owner,environment,stage,encrypted_payload,keys,revision) values (${secretId},${workspace.id},${source.id},${app.id},${`app:${app.id}`},'production','deployment',${client.json(envelope)},${client.json(Object.keys(values))},${randomUUID()})`;
      const [deployment] =
        await client`insert into towbar_deployments (workspace_id,source_id,app_id,server_id,target_environment,idempotency_key,temporal_workflow_id,deployable_kind,state,commit_sha,manifest_digest,required_secrets,app_snapshot,server_snapshot) values (${workspace.id},${source.id},${app.id},${server.id},${client.json({ id: environment.id, name: environment.name, branch: environment.branch, mappingRevision: environment.mapping_revision })},'original-deployment','original-workflow','image','succeeded','original-commit','original-manifest',${client.json(declarations)},${client.json(config)},'{}') returning id`;
      await client`insert into towbar_releases (app_id,deployment_id,status,commit_sha,image_tag,container_name) values (${app.id},${deployment.id},'current','original-commit','original-image','original-container')`;
      await client`insert into towbar_deployment_steps (deployment_id,sequence,state,status) values (${deployment.id},0,'succeeded','succeeded')`;
      await client`insert into towbar_deployment_log_chunks (deployment_id,sequence,stream,content) values (${deployment.id},0,'stdout','Original deployment log')`;
      await client`insert into towbar_image_vulnerability_scans (workspace_id,source_id,app_id,server_id,deployment_id,image_digest,state,severity_totals) values (${workspace.id},${source.id},${app.id},${server.id},${deployment.id},${`sha256:${"a".repeat(64)}`},'clean','{}')`;
      const before =
        await client`select * from towbar_managed_secrets where id=${secretId}`;

      async function rejectUpgrade(message) {
        await assert.rejects(
          migrateDatabase(isolated.href, folder),
          (error) => {
            assert.equal(error.cause?.code, "P0001");
            assert.match(error.cause.message, message);
            return true;
          },
        );
        assert.equal(
          (await client`select kind from towbar_apps where id=${app.id}`)[0]
            .kind,
          "image",
        );
        assert.equal(
          (
            await client`select entity_type from towbar_source_entities where id=${entity.id}`
          )[0].entity_type,
          "resource",
        );
        assert.equal(
          (
            await client`select deployable_kind from towbar_deployments where id=${deployment.id}`
          )[0].deployable_kind,
          "image",
        );
        assert.deepEqual(
          await client`select * from towbar_managed_secrets where id=${secretId}`,
          before,
        );
      }

      const [otherEntity] =
        await client`insert into towbar_source_entities (source_id,entity_type,manifest_id) values (${source.id},'app','infisical') returning id`;
      const [otherApp] =
        await client`insert into towbar_apps (workspace_id,source_id,server_id,entity_id,source_environment_id,required_secrets,manifest_id,kind,name,config,config_digest,source_revision) select workspace_id,source_id,server_id,${otherEntity.id},source_environment_id,required_secrets,manifest_id,'app','Existing app',jsonb_set(config,'{kind}','"app"'),config_digest,source_revision from towbar_apps where id=${app.id} returning *`;
      await rejectUpgrade(/Image workloads share IDs with apps/u);
      await assert.rejects(migrateDatabase(isolated.href, folder), (error) => {
        assert.match(error.cause.detail, /example\/platform-services/u);
        assert(error.cause.detail.includes(entity.id));
        assert.match(error.cause.hint, /resolve-a-legacy-image-id-conflict/u);
        return true;
      });

      const [staging] =
        await client`insert into towbar_source_environments (source_id,name,branch) values (${source.id},'staging','staging') returning id`;
      const [stagingApp] =
        await client`insert into towbar_apps (workspace_id,source_id,server_id,entity_id,source_environment_id,required_secrets,manifest_id,kind,name,config,config_digest,source_revision) select workspace_id,source_id,server_id,entity_id,${staging.id},required_secrets,manifest_id,kind,name,config,config_digest,source_revision from towbar_apps where id=${app.id} returning id`;
      const recoveryDocs = await readFile(
        new URL("../../../docs/docs/self-hosting/upgrades.md", import.meta.url),
        "utf8",
      );
      const renameSql = recoveryDocs
        .match(/```sql\n([\s\S]*?)\n```/u)[1]
        .replace("IMAGE-ENTITY-UUID", entity.id);
      await assert.rejects(
        client.unsafe(renameSql.replaceAll("infisical-image", "infisical")),
        /already used/u,
      );
      await client`rollback`;
      await client.unsafe(renameSql);
      config.id = "infisical-image";
      assert.equal(
        (
          await client`select manifest_id from towbar_apps where id=${stagingApp.id}`
        )[0].manifest_id,
        config.id,
      );

      await client`update towbar_apps set config=jsonb_set(config,'{container,command}','["custom-command"]') where id=${app.id}`;
      await rejectUpgrade(/custom runtime settings converted to a service/u);
      await client`update towbar_apps set config=${client.json(config)} where id=${app.id}`;

      for (const mountPath of [
        "/",
        "/etc/config",
        "/proc/data",
        "/sys/data",
        "/dev/data",
        "/run/data",
        "/var/run/data",
        "/data/",
        "/data//uploads",
        "/data/./uploads",
        "/data/../uploads",
        "/data uploads",
      ]) {
        const volumes = [{ name: "infisical-data", mountPath }];
        await client`update towbar_apps set config=jsonb_set(config,'{container,volumes}',${client.json(volumes)}) where id=${app.id}`;
        await rejectUpgrade(/service-incompatible volume mount/u);
      }
      for (const volumes of [
        [
          { name: "data", mountPath: "/data" },
          { name: "uploads", mountPath: "/data/uploads" },
        ],
        [
          { name: "uploads", mountPath: "/data/uploads" },
          { name: "data", mountPath: "/data" },
        ],
        [
          { name: "data", mountPath: "/data" },
          { name: "uploads", mountPath: "/data" },
        ],
        [
          { name: "data", mountPath: "/data" },
          { name: "data", mountPath: "/uploads" },
        ],
      ]) {
        await client`update towbar_apps set config=jsonb_set(config,'{container,volumes}',${client.json(volumes)}) where id=${app.id}`;
        await rejectUpgrade(/uniquely named volumes with non-overlapping/u);
      }
      await client`update towbar_apps set config=${client.json(config)} where id=${app.id}`;
      await client`update towbar_deployments set app_snapshot=jsonb_set(app_snapshot,'{container,volumes}','[{"name":"data","mountPath":"/etc/config"}]') where id=${deployment.id}`;
      await rejectUpgrade(/service-incompatible volume mount/u);
      await client`update towbar_deployments set app_snapshot=${client.json({ ...config, id: "infisical" })} where id=${deployment.id}`;

      await migrateDatabase(isolated.href, folder);
      await migrateDatabase(isolated.href, folder);
      assert.deepEqual(
        (await client`select * from towbar_apps where id=${otherApp.id}`)[0],
        { ...otherApp, manifest_state: "active", retired_at: null },
      );
      const [converted] =
        await client`select * from towbar_apps where id=${app.id}`;
      assert.equal(converted.kind, "app");
      assert.equal(converted.entity_id, entity.id);
      assert.deepEqual(
        (
          await client`select entity_type,resource_type from towbar_source_entities where id=${entity.id}`
        )[0],
        { entity_type: "app", resource_type: null },
      );
      const after =
        await client`select * from towbar_managed_secrets where id=${secretId}`;
      assert.deepEqual(after, before);
      assert.deepEqual(
        decryptCredential({
          associatedData,
          masterKey,
          envelope: after[0].encrypted_payload,
        }),
        values,
      );
      const expected = normalizeDeploymentManifest({
        version: 2,
        source: { branch: "main" },
        apps: [
          {
            id: config.id,
            name: config.name,
            server: config.server,
            autoDeploy: config.autoDeploy,
            deployment: { type: "image", image: config.image },
            container: {
              port: 8080,
              network: "platform-services",
              networkAlias: "infisical",
              volumes: config.container.volumes,
            },
            health: { path: "/api/status", timeoutSeconds: 180 },
            rollout: {
              type: "recreate",
              maintenanceMode: true,
              terminationSeconds: 30,
              reason: "Keep the existing single-container deployment",
            },
          },
        ],
      }).apps[0];
      assert.deepEqual(converted.config, expected);
      const [history] =
        await client`select deployable_kind,app_snapshot,state from towbar_deployments where id=${deployment.id}`;
      assert.equal(history.deployable_kind, "app");
      assert.equal(history.state, "succeeded");
      assert.deepEqual(history.app_snapshot, { ...expected, id: "infisical" });
      for (const table of [
        "towbar_releases",
        "towbar_deployment_steps",
        "towbar_deployment_log_chunks",
        "towbar_image_vulnerability_scans",
      ])
        assert.equal(
          (
            await client.unsafe(
              `select count(*)::int as count from ${table} where deployment_id=$1`,
              [deployment.id],
            )
          )[0].count,
          1,
          table,
        );
    } finally {
      await client?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
      await rm(previous, { recursive: true, force: true });
    }
  },
);
