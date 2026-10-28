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
  "audit removal preserves server cleanup markers and unrelated data",
  { skip: !url },
  async () => {
    assert(new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} });
    const name = `audit_removal_${randomUUID().replaceAll("-", "")}_test`;
    const previous = await mkdtemp(join(tmpdir(), "towbar-audit-removal-"));
    let client;
    try {
      await cp(folder, previous, { recursive: true });
      const journal = JSON.parse(
        await readFile(join(previous, "meta/_journal.json"), "utf8"),
      );
      journal.entries = journal.entries.filter((entry) => entry.idx < 34);
      await writeFile(
        join(previous, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      const databaseUrl = new URL(url);
      databaseUrl.pathname = `/${name}`;
      client = postgres(databaseUrl.href, { max: 1, onnotice() {} });
      await migrate(drizzle(client), { migrationsFolder: previous });
      const workspaceId = randomUUID(),
        serverId = randomUUID(),
        freshServerId = randomUUID();
      await client`INSERT INTO towbar_workspaces(id,slug,name) VALUES(${workspaceId},${workspaceId},'Preserved team')`;
      for (const [id, ip] of [
        [serverId, "192.0.2.1"],
        [freshServerId, "192.0.2.2"],
      ])
        await client`INSERT INTO towbar_servers(id,workspace_id,canonical_ip,config,config_digest) VALUES(${id},${workspaceId},${ip},'{}','digest')`;
      for (const at of ["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"])
        await client`INSERT INTO towbar_audit_events(workspace_id,action,target_type,target_id,created_at) VALUES(${workspaceId},'server.removed','server',${serverId},${at})`;
      const before =
        await client`SELECT * FROM towbar_workspaces WHERE id=${workspaceId}`;
      await migrate(drizzle(client), { migrationsFolder: folder });
      await migrate(drizzle(client), { migrationsFolder: folder });
      assert.deepEqual(
        await client`SELECT * FROM towbar_workspaces WHERE id=${workspaceId}`,
        before,
      );
      assert.equal(
        new Date(
          (
            await client`SELECT last_removed_at FROM towbar_servers WHERE id=${serverId}`
          )[0].last_removed_at,
        ).toISOString(),
        "2026-10-02T00:00:00.000Z",
      );
      assert.equal(
        (
          await client`SELECT last_removed_at FROM towbar_servers WHERE id=${freshServerId}`
        )[0].last_removed_at,
        null,
      );
      assert.equal(
        (await client`SELECT to_regclass('towbar_audit_events') AS relation`)[0]
          .relation,
        null,
      );
    } finally {
      if (client) await client.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
      await rm(previous, { recursive: true, force: true });
    }
  },
);
