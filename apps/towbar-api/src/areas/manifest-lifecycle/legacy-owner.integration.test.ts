import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  type NormalizedApp,
  type NormalizedResource,
  digestValue,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  repositoryManifests,
  resourceOperations,
  servers,
  sourceEntities,
  sourceEnvironments,
  users,
  workspaces,
} from "@workspace/towbar-database/schema";
import { seedEnvironmentTeam } from "../sources/environment-server-tests.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "a superseded legacy Service can retire without touching its same-ID datastore",
  { skip: !url },
  async (t) => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl: url,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { withActor } = await import("../auth/actor-context.js");
    const { listManifestLifecycle } = await import("./queries.js");
    const { assertManifestManaged } = await import("./guards.js");
    const { removeRetiredWorkload, finalizeRetirement } =
      await import("./removal.js");
    const { getCleanupExpected } =
      await import("../resource-operations/cleanup-plan.js");
    const db = getTowbarDatabase();
    t.after(closeDatabase);
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      sourceId = randomUUID();
    const actor = {
      kind: "session" as const,
      workspaceId,
      userId,
      role: "admin" as const,
    };
    await seedEnvironmentTeam({ workspaceId, userId, sourceId });
    const serverConfig = normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "deploy" },
    });
    const [server] = await db
      .insert(servers)
      .values({
        workspaceId,
        canonicalIp: serverConfig.ip,
        config: serverConfig,
        configDigest: digestValue(serverConfig),
      })
      .returning();
    const [environment] = await db
      .insert(sourceEnvironments)
      .values({ sourceId, name: "production", branch: "main" })
      .returning();
    assert(server && environment);
    const requiredSecrets = {
      build: [],
      runtime: [],
      preDeploy: [],
      postDeploy: [],
    };
    const config: NormalizedResource = {
      kind: "postgres",
      id: "rootset-postgres",
      name: "Rootset PostgreSQL",
      image: "postgres:18",
      server: serverConfig.ip,
      sourceBranch: "main",
      autoDeploy: false,
      container: {
        command: [],
        resources: { cpus: 1, memory: "1g" },
        volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
      },
      health: { type: "command", command: ["pg_isready"], timeoutSeconds: 60 },
    };
    const oldConfig: NormalizedApp = {
      kind: "app",
      id: config.id,
      name: config.name,
      server: config.server,
      sourceBranch: "main",
      autoDeploy: false,
      vulnerabilityScanning: false,
      dockerfile: "Dockerfile",
      context: ".",
      deploymentInputs: [],
      container: { port: 5432 },
      health: { path: "/", timeoutSeconds: 60 },
      hooks: {},
    };
    const [oldEntity, currentEntity] = await db
      .insert(sourceEntities)
      .values([
        { sourceId, entityType: "app", manifestId: config.id },
        {
          sourceId,
          entityType: "resource",
          resourceType: "postgres",
          manifestId: config.id,
        },
      ])
      .returning();
    assert(oldEntity && currentEntity);
    const base = {
      workspaceId,
      sourceId,
      sourceEnvironmentId: environment.id,
      serverId: server.id,
      requiredSecrets,
      manifestId: config.id,
      name: config.name,
      sourceRevision: "a".repeat(40),
    };
    const [legacy, owner] = await db
      .insert(apps)
      .values([
        {
          ...base,
          entityId: oldEntity.id,
          kind: "app",
          config: oldConfig,
          configDigest: digestValue(oldConfig),
          manifestState: "retired",
          retiredAt: new Date("2026-10-10T14:51:33Z"),
          legacyArchivedAt: new Date("2026-10-10T14:51:33Z"),
        },
        {
          ...base,
          entityId: currentEntity.id,
          kind: "postgres",
          config,
          configDigest: digestValue(config),
        },
      ])
      .returning();
    assert(legacy && owner);
    try {
      await db.insert(repositoryManifests).values({
        workspaceId,
        sourceEnvironmentId: environment.id,
        commitSha: base.sourceRevision,
        manifest: {
          version: 2,
          environment: "production",
          previewsEnabled: false,
          source: { branch: "main" },
          apps: [],
          resources: [config],
          requiredSecrets: { [`resource:${config.id}`]: requiredSecrets },
        },
      });
      const list = () =>
        listManifestLifecycle(workspaceId, { offset: 0, limit: 50 });
      const first = await list();
      assert.deepEqual(first.counts, {
        conflicts: 0,
        retirements: 1,
        removing: 0,
      });
      assert.deepEqual(
        first.items[0]?.workloads.map((workload) => workload.id),
        [legacy.id],
      );
      await db.transaction((tx) => assertManifestManaged(tx, owner.id));
      await assert.rejects(
        db.transaction((tx) => assertManifestManaged(tx, legacy.id)),
        /pending retirement/,
      );
      const request = {
        workspaceId,
        workloadId: legacy.id,
        expectedRevision: legacy.updatedAt.toISOString(),
        confirmManifestId: config.id,
        reason: "Remove superseded Service",
        idempotencyKey: randomUUID(),
        requestedBy: userId,
      };
      await assert.rejects(
        withActor(actor, () =>
          removeRetiredWorkload(
            {
              ...request,
              workloadId: owner.id,
              expectedRevision: owner.updatedAt.toISOString(),
            },
            () => Promise.resolve(0),
          ),
        ),
        /still declares/,
      );
      const accepted = await withActor(actor, () =>
        removeRetiredWorkload(request, () => Promise.resolve(0)),
      );
      assert.deepEqual(
        await withActor(actor, () =>
          removeRetiredWorkload(request, () => Promise.resolve(0)),
        ),
        accepted,
      );
      assert.deepEqual((await list()).counts, {
        conflicts: 0,
        retirements: 1,
        removing: 1,
      });
      const cleanup = await getCleanupExpected(server.id, db, legacy.id);
      assert.deepEqual(
        cleanup.retiring?.map((entry) => entry.deployableId),
        [legacy.id],
      );
      assert(cleanup.protectedDeployableIds?.includes(owner.id));
      assert(!cleanup.protectedDeployableIds?.includes(legacy.id));
      const [operation] = await db
        .update(resourceOperations)
        .set({
          state: "succeeded",
          result: {
            cleaned: [],
            skipped: [],
            failures: [],
            retiredDeployableIds: [legacy.id],
          },
        })
        .where(eq(resourceOperations.id, accepted.operations[0]!.id))
        .returning();
      assert(operation);
      await db.transaction((tx) => finalizeRetirement(tx, operation));
      assert.equal((await list()).total, 0);
      const [unchanged] = await db
        .select()
        .from(apps)
        .where(eq(apps.id, owner.id));
      assert.deepEqual(unchanged, owner);
      assert.deepEqual(
        unchanged.config.container.volumes,
        config.container.volumes,
      );
    } finally {
      await db
        .delete(resourceOperations)
        .where(eq(resourceOperations.workspaceId, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
);
