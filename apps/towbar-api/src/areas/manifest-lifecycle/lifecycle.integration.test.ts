import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  digestValue,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  domainClaims,
  managedSecrets,
  releases,
  repositoryManifests,
  resourceOperations,
  servers,
  sourceEnvironments,
  sourceSyncs,
  sources,
  users,
  workspaces,
} from "@workspace/towbar-database/schema";
import { seedEnvironmentTeam } from "../sources/environment-server-tests.js";
import { environmentSyncDependencies } from "../sources/environment-sync-fixture.js";
import { getRuntimeSourceIds } from "./runtime-ownership.js";
import { assertIndependentRetirements } from "./legacy-retirement.test-helper.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "repository moves preserve identity and encrypted secrets in both Git orders",
  { skip: !url },
  async (t) => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl: url,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { executeEnvironmentSync } =
      await import("../sources/environment-sync.js");
    const { withActor, captureQueuedActor } =
      await import("../auth/actor-context.js");
    const { mutateSecret, readSecretValues, readSecretMetadata } =
      await import("../secrets/store.js");
    const { getCleanupExpected } =
      await import("../resource-operations/cleanup-plan.js");
    const { assertManifestManaged } = await import("./guards.js");
    const { listManifestLifecycle } = await import("./queries.js");
    const { removeRetiredWorkload, finalizeRetirement } =
      await import("./removal.js");
    const db = getTowbarDatabase();
    t.after(closeDatabase);
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      firstId = randomUUID(),
      secondId = randomUUID();
    const actor = {
      kind: "session" as const,
      workspaceId,
      userId,
      role: "admin" as const,
    };
    await seedEnvironmentTeam({ workspaceId, userId, sourceId: firstId });
    const [firstSource] = await db
      .select()
      .from(sources)
      .where(eq(sources.id, firstId));
    assert(firstSource);
    await db
      .insert(sources)
      .values({ ...firstSource, id: secondId, repositoryName: "destination" });
    const config = normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "deploy" },
    });
    const [server] = await db
      .insert(servers)
      .values({
        workspaceId,
        canonicalIp: config.ip,
        config,
        configDigest: digestValue(config),
      })
      .returning();
    assert(server);
    const [first, second] = await db
      .insert(sourceEnvironments)
      .values([
        { sourceId: firstId, name: "production", branch: "main" },
        { sourceId: secondId, name: "production", branch: "main" },
      ])
      .returning();
    assert(first && second);
    const base = environmentSyncDependencies(() => ({
      root: "version: 2\nenvironments:\n  production: {}\n  staging: {}\n",
      snapshotCommit: "a".repeat(40),
      keys: ["TOKEN"],
      broken: false,
    }));
    async function sync(
      environment: NonNullable<typeof first>,
      present = true,
      options: {
        fail?: boolean;
        commit?: string;
        waitFor?: Promise<void>;
        entered?: () => void;
      } = {},
    ) {
      const [job] = await db
        .insert(sourceSyncs)
        .values({
          sourceId: environment.sourceId,
          sourceEnvironmentId: environment.id,
          mappingRevision: environment.mappingRevision,
          ...withActor(actor, () => captureQueuedActor(workspaceId, ["admin"])),
        })
        .returning();
      assert(job);
      return withActor(actor, () =>
        executeEnvironmentSync(job.id, workspaceId, {
          ...base,
          snapshot: async () => {
            if (options.fail) throw new Error("Git provider unavailable");
            options.entered?.();
            if (options.waitFor) await options.waitFor;
            const snapshot = await base.snapshot();
            return {
              ...snapshot,
              commitSha: options.commit ?? snapshot.commitSha,
              directories: present ? snapshot.directories : [],
              files: present
                ? snapshot.files.map((file) => {
                    const entity = JSON.parse(file.content) as {
                      container: Record<string, unknown>;
                    };
                    (entity as typeof entity & { rollout: unknown }).rollout = {
                      type: "recreate",
                      reason: "Single-writer fixture volume",
                      maintenanceMode: true,
                    };
                    entity.container.resources = { cpus: 1, memory: "1g" };
                    entity.container.volumes = [
                      { name: "data", mountPath: "/data" },
                    ];
                    return { ...file, content: JSON.stringify(entity) };
                  })
                : [],
            };
          },
          dispatchCleanup: () => Promise.resolve(0),
        }),
      );
    }
    async function workload() {
      const [app] = await db
        .select()
        .from(apps)
        .where(
          and(eq(apps.workspaceId, workspaceId), eq(apps.manifestId, "site")),
        );
      assert(app);
      return app;
    }
    try {
      await sync(first);
      const original = await workload();
      assert.equal(original.config.container.volumes?.[0]?.name, "data");
      const slot = {
        type: "app" as const,
        id: original.id,
        workspaceId,
        environment: "production",
        stage: "deployment",
      };
      await withActor(actor, async () =>
        mutateSecret(
          slot,
          {
            expectedRevision: (await readSecretMetadata(slot)).revision,
            set: { TOKEN: "do-not-change" },
            delete: [],
          },
          userId,
        ),
      );
      const [encrypted] = await db
        .select()
        .from(managedSecrets)
        .where(eq(managedSecrets.appId, original.id));
      const deploymentId = randomUUID();
      await db.insert(deployments).values({
        id: deploymentId,
        workspaceId,
        sourceId: firstId,
        appId: original.id,
        serverId: server.id,
        idempotencyKey: deploymentId,
        temporalWorkflowId: deploymentId,
        appSnapshot: original.config,
        serverSnapshot: server.config,
        commitSha: "a".repeat(40),
        manifestDigest: "a".repeat(64),
        requiredSecrets: original.requiredSecrets,
        state: "succeeded",
        targetEnvironment: {
          id: first.id,
          name: first.name,
          branch: first.branch,
          mappingRevision: first.mappingRevision,
        },
      });
      await db.insert(releases).values({
        deploymentId,
        appId: original.id,
        status: "current",
        commitSha: "a".repeat(40),
        containerName: `towbar-${original.id}`,
        imageTag: `towbar/${original.id}:current`,
      });
      await db
        .update(domainClaims)
        .set({
          activeAppId: original.id,
          activeDeploymentId: deploymentId,
        })
        .where(eq(domainClaims.workspaceId, workspaceId));
      await t.test(
        "add destination first produces informational conflict, never a duplicate workload",
        async () => {
          const result = await sync(second);
          assert.equal(
            (
              await db
                .select()
                .from(apps)
                .where(eq(apps.workspaceId, workspaceId))
            ).length,
            1,
          );
          assert.equal((await workload()).manifestState, "conflict");
          assert(result?.issues?.length);
          assert.equal(
            (await listManifestLifecycle(workspaceId, { offset: 0, limit: 50 }))
              .counts.conflicts,
            1,
          );
          await assert.rejects(
            db.transaction((tx) => assertManifestManaged(tx, original.id)),
            /manifest conflict/,
          );
        },
      );
      await t.test(
        "failed sync cannot relinquish the previous verified declaration",
        async () => {
          await assert.rejects(
            sync(first, false, { fail: true }),
            /Git provider unavailable/,
          );
          assert.equal((await workload()).sourceId, firstId);
          assert.equal(
            (
              await db
                .select()
                .from(repositoryManifests)
                .where(eq(repositoryManifests.workspaceId, workspaceId))
            ).length,
            2,
          );
        },
      );
      await t.test(
        "remove original completes transfer without changing runtime, history or ciphertext",
        async () => {
          await sync(first, false);
          const moved = await workload();
          assert.equal(moved.id, original.id);
          assert.equal(moved.sourceId, secondId);
          assert.equal(moved.serverId, original.serverId);
          assert.equal(moved.manifestState, "active");
          const lineage = await getRuntimeSourceIds(db, workspaceId, [
            moved.id,
          ]);
          assert.deepEqual(lineage.get(moved.id), [firstId]);
          assert.equal(
            (await getRuntimeSourceIds(db, randomUUID(), [moved.id])).size,
            0,
          );
          assert.equal(
            (await getRuntimeSourceIds(db, workspaceId, [randomUUID()])).size,
            0,
          );

          const [claim] = await db
            .select()
            .from(domainClaims)
            .where(eq(domainClaims.workspaceId, workspaceId));
          assert.equal(claim?.sourceEnvironmentId, second.id);
          assert.equal(claim?.desiredAppId, original.id);
          assert.equal(claim?.activeAppId, original.id);
          assert.equal(claim?.activeDeploymentId, deploymentId);
          assert.deepEqual(
            moved.config.container.volumes,
            original.config.container.volumes,
          );
          const [secret] = await db
            .select()
            .from(managedSecrets)
            .where(eq(managedSecrets.appId, moved.id));
          assert.equal(secret?.sourceId, secondId);
          assert.deepEqual(
            secret?.encryptedPayload,
            encrypted?.encryptedPayload,
          );
          assert.equal(
            (await readSecretValues(slot)).values.TOKEN,
            "do-not-change",
          );
          assert.equal(
            (
              await db
                .select()
                .from(deployments)
                .where(eq(deployments.id, deploymentId))
            )[0]?.sourceId,
            firstId,
          );
          assert.equal(
            (
              await db
                .select()
                .from(releases)
                .where(eq(releases.appId, moved.id))
            ).length,
            1,
          );
          assert.equal(
            (
              await db
                .select()
                .from(resourceOperations)
                .where(eq(resourceOperations.workspaceId, workspaceId))
            ).length,
            0,
          );
        },
      );
      await t.test(
        "remove first preserves runtime and prevents ordinary cleanup; adding elsewhere rescues it",
        async () => {
          await sync(second, false);
          const retired = await workload();
          assert.equal(retired.manifestState, "retired");
          assert.equal(retired.archivedAt, null);
          const plan = await getCleanupExpected(server.id);
          assert(plan.deployableIds.includes(original.id));
          assert(!plan.retiring?.length);
          await sync(first, true);
          const rescued = await workload();
          assert.equal(rescued.id, original.id);
          assert.equal(rescued.sourceId, firstId);
          assert.equal(rescued.manifestState, "active");
          assert.equal(
            (await readSecretValues(slot)).values.TOKEN,
            "do-not-change",
          );
        },
      );
      await t.test(
        "concurrent repositories converge to a conflict, and a delayed snapshot cannot undo a newer sync",
        async () => {
          await Promise.all([sync(first, true), sync(second, true)]);
          assert.equal((await workload()).manifestState, "conflict");
          assert.equal(
            (
              await db
                .select()
                .from(apps)
                .where(eq(apps.workspaceId, workspaceId))
            ).length,
            1,
          );
          await sync(second, false);
          let release: () => void = () => {};
          let entered: () => void = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const fetching = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const delayed = sync(first, false, { waitFor: gate, entered });
          await fetching;
          await sync(first, true, { commit: "b".repeat(40) });
          release();
          await assert.rejects(delayed, /newer environment sync/);
          assert.equal((await workload()).manifestState, "active");
          assert.equal((await workload()).sourceRevision, "b".repeat(40));
        },
      );
      await t.test(
        "active operations block transfer until a fresh destination sync",
        async () => {
          await db
            .update(deployments)
            .set({ state: "building" })
            .where(eq(deployments.id, deploymentId));
          await sync(second, true);
          await sync(first, false);
          assert.equal((await workload()).sourceId, firstId);
          assert.equal((await workload()).manifestState, "conflict");
          await db
            .update(deployments)
            .set({ state: "succeeded" })
            .where(eq(deployments.id, deploymentId));
          await sync(second, true);
          assert.equal((await workload()).sourceId, secondId);
          assert.equal((await workload()).id, original.id);
          await sync(second, false);
          await sync(first, true);
          assert.equal(
            (
              await listManifestLifecycle(randomUUID(), {
                offset: 0,
                limit: 50,
              })
            ).total,
            0,
          );
        },
      );
      await t.test(
        "a stale revision and a restored declaration both reject destructive removal",
        async () => {
          await sync(first, false);
          const retired = await workload();
          const request = {
            workspaceId,
            workloadId: retired.id,
            expectedRevision: retired.updatedAt.toISOString(),
            confirmManifestId: "site",
            reason: "No longer needed",
            requestedBy: userId,
            idempotencyKey: randomUUID(),
          };
          await assert.rejects(
            withActor(actor, () =>
              removeRetiredWorkload(
                { ...request, expectedRevision: new Date(0).toISOString() },
                () => Promise.resolve(0),
              ),
            ),
            /retirement changed/,
          );
          await sync(first, true);
          await assert.rejects(
            withActor(actor, () =>
              removeRetiredWorkload(request, () => Promise.resolve(0)),
            ),
            /still declares/,
          );
        },
      );
      await t.test(
        "explicit removal is scoped, retryable, and reserves the ID until verified completion",
        async () => {
          await sync(first, false);
          const retired = await workload();
          const request = {
            workspaceId,
            workloadId: retired.id,
            expectedRevision: retired.updatedAt.toISOString(),
            confirmManifestId: "site",
            reason: "Remove test workload",
            requestedBy: userId,
            idempotencyKey: randomUUID(),
          };
          const removed = await withActor(actor, () =>
            removeRetiredWorkload(request, () => Promise.resolve(0)),
          );
          assert.equal(removed.operations.length, 1);
          assert.deepEqual(
            await withActor(actor, () =>
              removeRetiredWorkload(request, () => Promise.resolve(0)),
            ),
            removed,
          );
          assert.equal((await workload()).manifestState, "removing");
          assert.equal(
            (await getCleanupExpected(server.id)).retiring?.length,
            0,
          );
          assert.equal(
            (await getCleanupExpected(server.id, db, original.id)).retiring?.[0]
              ?.deployableId,
            original.id,
          );
          await sync(second, true);
          assert.equal((await workload()).manifestState, "removing");
          // A reappearing declaration cannot adopt a workload whose removal has started.
          assert.equal((await workload()).sourceId, firstId);
          await sync(second, false);
          await db
            .update(apps)
            .set({ manifestState: "removing" })
            .where(eq(apps.id, original.id));
          const [operation] = await db
            .update(resourceOperations)
            .set({
              state: "succeeded",
              result: {
                cleaned: [],
                skipped: [],
                failures: [],
                retiredDeployableIds: [original.id],
              },
            })
            .where(eq(resourceOperations.id, removed.operations[0]!.id))
            .returning();
          assert(operation);
          await db.transaction((tx) => finalizeRetirement(tx, operation));
          assert.equal((await workload()).manifestState, "removed");
          await sync(first, true);
          const fresh = (
            await db
              .select()
              .from(apps)
              .where(
                and(
                  eq(apps.workspaceId, workspaceId),
                  eq(apps.manifestState, "active"),
                ),
              )
          )[0];
          assert(fresh);
          assert.notEqual(fresh.id, original.id);
          await assertIndependentRetirements(db, {
            workspaceId,
            fresh,
            sourceId: secondId,
            sourceEnvironmentId: second.id,
          });
        },
      );
    } finally {
      await db
        .delete(resourceOperations)
        .where(eq(resourceOperations.workspaceId, workspaceId));
      await db
        .delete(releases)
        .where(
          inArray(
            releases.appId,
            db
              .select({ id: apps.id })
              .from(apps)
              .where(eq(apps.workspaceId, workspaceId)),
          ),
        );
      await db
        .delete(deployments)
        .where(eq(deployments.workspaceId, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
);
