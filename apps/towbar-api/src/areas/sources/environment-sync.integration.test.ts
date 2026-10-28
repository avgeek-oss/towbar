import { environmentSyncDependencies } from "./environment-sync-fixture.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  type ManifestNotifications,
  digestValue,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  servers,
  sourceEnvironments,
  sourceSyncs,
  sources,
  users,
  workspaces,
} from "@workspace/towbar-database/schema";

import {
  assertManifestNotificationSync,
  assertScopedDeliveryHistory,
} from "./environment-notification-tests.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "environment sync preserves instance and secret isolation",
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
    const { executeEnvironmentSync } = await import("./environment-sync.js");
    const { assertRequiredInstanceSecrets, listSecretEnvironments } =
      await import("../apps/secrets.js");
    const { assertDeclaredSecretValueCanBeCleared } =
      await import("./environment-secret-clear-tests.js");
    const { getInstanceEnvironment, lockDeploymentEnvironment } =
      await import("../apps/instance-environment.js");
    const { readSecretValues, readSecretMetadata, mutateSecret } =
      await import("../secrets/store.js");
    const database = getTowbarDatabase();
    const workspaceId = randomUUID(),
      sourceId = randomUUID(),
      userId = randomUUID();
    const { withActor, captureQueuedActor } =
      await import("../auth/actor-context.js");
    const actor = {
      kind: "session" as const,
      workspaceId,
      userId,
      role: "admin" as const,
    };
    const root = "version: 2\nenvironments:\n  production: {}\n  staging: {}\n";
    let keys = ["TOKEN", "EMPTY"];
    let broken = false;
    let notifications: ManifestNotifications | undefined;
    let snapshotCommit = "a".repeat(40);
    const dependencies = environmentSyncDependencies(() => ({
      root,
      snapshotCommit,
      keys,
      broken,
      notifications,
    }));
    try {
      const { seedEnvironmentTeam } =
        await import("./environment-server-tests.js");
      await seedEnvironmentTeam({ workspaceId, userId, sourceId });
      const config = normalizeServerConfiguration({
        ip: "192.0.2.10",
        ssh: { username: "deploy" },
      });
      await database.insert(servers).values({
        workspaceId,
        canonicalIp: config.ip,
        config,
        configDigest: digestValue(config),
      });
      const [production, staging] = await database
        .insert(sourceEnvironments)
        .values([
          { sourceId, name: "production", branch: "main" },
          { sourceId, name: "staging", branch: "develop" },
        ])
        .returning();
      async function sync(
        environment: NonNullable<typeof production>,
        revision = environment.mappingRevision,
      ) {
        const [job] = await database
          .insert(sourceSyncs)
          .values({
            sourceId,
            sourceEnvironmentId: environment.id,
            mappingRevision: revision,
            ...withActor(actor, () =>
              captureQueuedActor(workspaceId, ["admin"]),
            ),
          })
          .returning();
        return executeEnvironmentSync(job!.id, workspaceId, dependencies);
      }
      await sync(production!);
      snapshotCommit = "b".repeat(40);
      await sync(staging!);
      const instances = await database
        .select()
        .from(apps)
        .where(eq(apps.sourceId, sourceId));
      assert.equal(instances.length, 2);
      assert.equal(instances[0]!.entityId, instances[1]!.entityId);
      assert.notEqual(instances[0]!.id, instances[1]!.id);
      const prod = instances.find(
        (row) => row.sourceEnvironmentId === production!.id,
      )!;
      const stage = instances.find(
        (row) => row.sourceEnvironmentId === staging!.id,
      )!;
      await t.test(
        "a delayed retry cannot reopen a completed sync",
        async () => {
          const { assertCompletedSyncRetry } =
            await import("./environment-sync-retry-tests.js");
          await withActor(actor, () =>
            assertCompletedSyncRetry({
              staging: staging!,
              workspaceId,
              snapshotCommit,
              dependencies,
            }),
          );
        },
      );
      await t.test("instance identity and mapped push routing", async () => {
        const { assertInstanceQueryIdentity } =
          await import("./environment-query-tests.js");
        await assertInstanceQueryIdentity({
          workspaceId,
          sourceId,
          prod,
          stage,
        });
      });
      const slot = {
        type: "app" as const,
        id: stage.id,
        workspaceId,
        environment: "staging",
        stage: "deployment",
      };
      const prodSlot = { ...slot, id: prod.id, environment: "production" };
      await t.test(
        "new declarations and environment snapshots are isolated",
        async () => {
          const { assertEnvironmentManifestSnapshots } =
            await import("./environment-preview-tests.js");
          await assertEnvironmentManifestSnapshots({
            sourceId,
            workspaceId,
            productionId: production!.id,
            stagingId: staging!.id,
          });
          assert.deepEqual((await readSecretMetadata(slot)).missingKeys, [
            "EMPTY",
            "TOKEN",
          ]);
          assert.deepEqual(
            Object.keys((await readSecretValues(slot)).values),
            [],
          );
        },
      );
      await t.test(
        "sync cannot revive a removed server; an admin must register it again",
        async () => {
          const { assertRemovedServerAdmission } =
            await import("./environment-server-tests.js");
          await withActor(actor, () =>
            assertRemovedServerAdmission({
              workspaceId,
              prod,
              config,
              syncProduction: async () => {
                snapshotCommit = "a".repeat(40);
                await sync(production!);
              },
              syncStaging: async () => {
                snapshotCommit = "b".repeat(40);
                await sync(staging!);
              },
            }),
          );
        },
      );
      await assert.rejects(
        assertRequiredInstanceSecrets({
          appId: stage.id,
          sourceId,
          workspaceId,
        }),
        /Required secrets missing in staging/,
      );
      const metadata = await readSecretMetadata(slot);
      await mutateSecret(
        slot,
        {
          expectedRevision: metadata.revision,
          set: { TOKEN: "stage-value", EMPTY: "" },
          delete: [],
        },
        userId,
      );
      await t.test(
        "declared values can be cleared without removing their YAML declarations",
        async () =>
          assertDeclaredSecretValueCanBeCleared({
            appId: stage.id,
            slot,
            userId,
            workspaceId,
          }),
      );
      await t.test("values cannot cross environment boundaries", async () => {
        assert.deepEqual(
          Object.keys((await readSecretValues(prodSlot)).values),
          [],
        );
        await assert.rejects(
          readSecretValues({ ...slot, environment: "production" }),
          /does not match/,
        );
      });
      await t.test(
        "PR declarations validate isolated preview values without reconciling slots",
        async () => {
          assert.deepEqual(
            await listSecretEnvironments({
              type: "app",
              id: stage.id,
              workspaceId,
            }),
            ["staging", "preview:staging"],
          );
          const before = await readSecretMetadata(slot);
          await assert.rejects(
            assertRequiredInstanceSecrets({
              appId: stage.id,
              sourceId,
              workspaceId,
              preview: true,
              declarations: {
                build: [],
                runtime: ["TOKEN", "PR_ONLY"],
                preDeploy: [],
                postDeploy: [],
              },
            }),
            /Required secrets missing in preview:staging/,
          );
          assert.deepEqual(await readSecretMetadata(slot), before);
          assert.deepEqual(
            (
              await readSecretMetadata({
                ...slot,
                environment: "preview:staging",
              })
            ).keys,
            before.keys,
          );
        },
      );
      await t.test(
        "sync preserves empty values, adds unset keys and removes deleted values only in staging",
        async () => {
          keys = ["EMPTY", "ADDED"];
          await sync(staging!);
          assert.deepEqual(
            { ...(await readSecretValues(slot)).values },
            { EMPTY: "" },
          );
          assert.deepEqual((await readSecretMetadata(slot)).missingKeys, [
            "ADDED",
          ]);
          assert.deepEqual((await readSecretMetadata(prodSlot)).keys, [
            "EMPTY",
            "TOKEN",
          ]);
        },
      );
      await t.test(
        "invalid sync rolls back inventory and secret removal",
        async () => {
          keys = [];
          broken = true;
          await assert.rejects(sync(staging!), /192\.0\.2\.99/);
          assert.deepEqual((await readSecretMetadata(slot)).keys, [
            "ADDED",
            "EMPTY",
          ]);
          const [retained] = await database
            .select()
            .from(apps)
            .where(
              and(eq(apps.id, stage.id), eq(apps.workspaceId, workspaceId)),
            );
          assert.equal(retained!.config.server, "192.0.2.10");
          broken = false;
        },
      );
      await t.test(
        "deployment admission serializes branch edits and rejects stale mappings",
        async () => {
          const expected = await getInstanceEnvironment({
            appId: stage.id,
            workspaceId,
          });
          assert(expected);
          await database.transaction(async (transaction) => {
            await lockDeploymentEnvironment(expected, transaction);
            await assert.rejects(
              database.transaction(async (editor) => {
                await editor.execute(sql`set local lock_timeout = '100ms'`);
                await editor
                  .update(sourceEnvironments)
                  .set({ mappingRevision: randomUUID() })
                  .where(eq(sourceEnvironments.id, expected.id));
              }),
              (error: unknown) => {
                const cause = error as {
                  cause?: { code?: string };
                  code?: string;
                };
                return (cause.cause?.code ?? cause.code) === "55P03";
              },
            );
          });
          await assert.rejects(
            database.transaction((transaction) =>
              lockDeploymentEnvironment(
                { ...expected, mappingRevision: randomUUID() },
                transaction,
              ),
            ),
            /environment changed/,
          );
        },
      );
      await t.test(
        "resuming a source selects each environment revision independently",
        async () => {
          const { scheduleLatestAutomaticDeploymentsForSource } =
            await import("../apps/automatic-deployments.js");
          const before = await database
            .select()
            .from(apps)
            .where(eq(apps.sourceId, sourceId));
          try {
            await database
              .update(sources)
              .set({ autoDeployPaused: true })
              .where(eq(sources.id, sourceId));
            await database
              .update(servers)
              .set({
                preparedAt: new Date(),
                preparedConfigDigest: digestValue(config),
              })
              .where(eq(servers.id, stage.serverId));
            for (const instance of before) {
              await database
                .update(apps)
                .set({
                  config: { ...instance.config, autoDeploy: true },
                  requiredSecrets: {
                    build: [],
                    runtime: [],
                    preDeploy: [],
                    postDeploy: [],
                  },
                })
                .where(eq(apps.id, instance.id));
            }
            assert.deepEqual(
              await scheduleLatestAutomaticDeploymentsForSource({
                sourceId,
                workspaceId,
              }),
              { deploymentIds: [] },
            );
            const deferred = await database
              .select()
              .from(apps)
              .where(eq(apps.sourceId, sourceId));
            assert.equal(
              deferred.find((item) => item.id === prod.id)
                ?.deferredAutomaticDeployment?.commitSha,
              "a".repeat(40),
            );
            assert.equal(
              deferred.find((item) => item.id === stage.id)
                ?.deferredAutomaticDeployment?.commitSha,
              "b".repeat(40),
            );
            await database
              .update(apps)
              .set({ deferredAutomaticDeployment: null })
              .where(eq(apps.sourceId, sourceId));
            await scheduleLatestAutomaticDeploymentsForSource({
              sourceId,
              workspaceId,
              sourceEnvironmentId: staging!.id,
            });
            const scoped = await database
              .select()
              .from(apps)
              .where(eq(apps.sourceId, sourceId));
            assert.equal(
              scoped.find((item) => item.id === prod.id)
                ?.deferredAutomaticDeployment,
              null,
            );
            assert.equal(
              scoped.find((item) => item.id === stage.id)
                ?.deferredAutomaticDeployment?.commitSha,
              "b".repeat(40),
            );
            await database
              .update(apps)
              .set({ deferredAutomaticDeployment: null })
              .where(eq(apps.sourceId, sourceId));
            await database
              .update(sourceEnvironments)
              .set({ mappingRevision: randomUUID() })
              .where(eq(sourceEnvironments.id, staging!.id));
            await scheduleLatestAutomaticDeploymentsForSource({
              sourceId,
              workspaceId,
            });
            const afterBranchEdit = await database
              .select()
              .from(apps)
              .where(eq(apps.sourceId, sourceId));
            assert.equal(
              afterBranchEdit.find((item) => item.id === stage.id)
                ?.deferredAutomaticDeployment,
              null,
            );
            assert.equal(
              afterBranchEdit.find((item) => item.id === prod.id)
                ?.deferredAutomaticDeployment?.commitSha,
              "a".repeat(40),
            );
          } finally {
            await database
              .update(sourceEnvironments)
              .set({ mappingRevision: staging!.mappingRevision })
              .where(eq(sourceEnvironments.id, staging!.id));
            await database
              .update(sources)
              .set({ autoDeployPaused: false })
              .where(eq(sources.id, sourceId));
            for (const instance of before) {
              await database
                .update(apps)
                .set({
                  config: instance.config,
                  requiredSecrets: instance.requiredSecrets,
                  deferredAutomaticDeployment: null,
                })
                .where(eq(apps.id, instance.id));
            }
          }
        },
      );
      await t.test(
        "preview discovery uses mapped branches and retains cleanup work when disabled",
        async () => {
          const { assertPreviewDiscovery } =
            await import("./environment-preview-tests.js");
          await assertPreviewDiscovery({
            stageId: stage.id,
            stagingId: staging!.id,
            sourceId,
            workspaceId,
          });
        },
      );
      await t.test(
        "preview admission rejects stale environment snapshots and disabled target apps",
        async () => {
          const { assertPreviewAdmissionGuards } =
            await import("./environment-preview-tests.js");
          await assertPreviewAdmissionGuards({
            stage,
            sourceId,
            workspaceId,
            config,
          });
        },
      );
      await t.test(
        "worker validates snapshotted preview declarations and preserves intentional empty values",
        async () => {
          const { assertDeploymentSecretSnapshot } =
            await import("./environment-preview-tests.js");
          await assertDeploymentSecretSnapshot({
            stage,
            sourceId,
            workspaceId,
            config,
            userId,
          });
        },
      );
      await t.test(
        "sync updates manifest notification subscriptions",
        async () => {
          keys = ["EMPTY", "ADDED"];
          await assertManifestNotificationSync({
            stageId: stage.id,
            workspaceId,
            sync: () => sync(staging!),
            setNotifications: (value) => {
              notifications = value;
            },
          });
        },
      );
      await t.test("delivery history is scoped to its deployable", () =>
        withActor(actor, () =>
          assertScopedDeliveryHistory({
            workspaceId,
            sourceId,
            stage,
            production: prod,
          }),
        ),
      );
      await t.test(
        "changed branch mapping rejects a previously queued sync",
        async () => {
          const { assertStaleSync } =
            await import("./environment-sync-retry-tests.js");
          await assertStaleSync(
            staging!,
            () => sync(staging!),
            () => readSecretMetadata(slot),
          );
        },
      );
    } finally {
      await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await database.delete(users).where(eq(users.id, userId));
      await closeDatabase();
    }
  },
);
