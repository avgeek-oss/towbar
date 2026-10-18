import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  digestValue,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  managedSecrets,
  repositoryManifests,
  servers,
  sourceEnvironments,
  sourceSyncs,
  sources,
  workspaces,
} from "@workspace/towbar-database/schema";
import { seedEnvironmentTeam } from "./environment-server-tests.js";
import { environmentSyncDependencies } from "./environment-sync-fixture.js";
import { captureQueuedActor, withActor } from "../auth/actor-context.js";
import { deleteSource } from "./service.js";
import { previewRepositoryRemoval } from "./withdrawal.js";
import { disconnectSourceEnvironment } from "./environments.js";
import { mutateSecret, readSecretMetadata } from "../secrets/store.js";
import { loadManifestRegistry } from "../manifest-lifecycle/reconcile.js";
import { getRuntimeSourceIds } from "../manifest-lifecycle/runtime-ownership.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "repository withdrawal reconciles connected claims without deleting runtime or secrets",
  { skip: !url },
  async (t) => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { executeEnvironmentSync } = await import("./environment-sync.js");
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
    await seedEnvironmentTeam({ workspaceId, sourceId: firstId, userId });
    try {
      const [source] = await db
        .select()
        .from(sources)
        .where(eq(sources.id, firstId));
      assert(source);
      await db
        .insert(sources)
        .values({ ...source, id: secondId, repositoryName: "destination" });
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
      const fixture = environmentSyncDependencies(() => ({
        root: "version: 2\nenvironments:\n  production: {}\n  staging: {}\n",
        snapshotCommit: "a".repeat(40),
        keys: ["TOKEN"],
        broken: false,
      }));
      async function sync(environment: NonNullable<typeof first>) {
        const [job] = await db
          .insert(sourceSyncs)
          .values({
            sourceId: environment.sourceId,
            sourceEnvironmentId: environment.id,
            mappingRevision: environment.mappingRevision,
            ...withActor(actor, () =>
              captureQueuedActor(workspaceId, ["repository.sync"]),
            ),
          })
          .returning();
        assert(job);
        return withActor(actor, () =>
          executeEnvironmentSync(job.id, workspaceId, {
            ...fixture,
            snapshot: async () => {
              const snapshot = await fixture.snapshot();
              return {
                ...snapshot,
                files: snapshot.files.map((file) => ({
                  ...file,
                  content: file.content
                    .replaceAll(
                      "prod.example.com",
                      `${workspaceId}.example.com`,
                    )
                    .replaceAll(
                      "stage.example.com",
                      `stage-${workspaceId}.example.com`,
                    ),
                })),
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
      await sync(first);
      const original = await workload();
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
            set: { TOKEN: "{{repo.TOKEN}}" },
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
        serverSnapshot: config,
        commitSha: "a".repeat(40),
        manifestDigest: original.configDigest,
        requiredSecrets: original.requiredSecrets,
        state: "succeeded",
        targetEnvironment: {
          id: first.id,
          name: first.name,
          branch: first.branch,
          mappingRevision: first.mappingRevision,
        },
      });
      await sync(second);
      assert.equal((await workload()).manifestState, "conflict");
      await t.test(
        "missing destination repo references remain conflicts and preview contains no values",
        async () => {
          const review = await previewRepositoryRemoval(firstId, workspaceId);
          assert.equal(review.summary.conflicts, 1);
          assert.match(review.workloads[0]!.reason!, /repo.TOKEN/);
          assert(!JSON.stringify(review).includes("{{repo.TOKEN}}"));
          await withActor(actor, () =>
            deleteSource(firstId, workspaceId, review.revision),
          );
          assert.equal((await workload()).sourceId, firstId);
          assert.equal((await workload()).manifestState, "conflict");
          const registry = await loadManifestRegistry(db, workspaceId);
          assert.deepEqual(
            registry.declarations.map((d) => d.sourceId),
            [secondId],
          );
        },
      );
      const destinationSlot = {
        ...slot,
        type: "repository" as const,
        id: secondId,
      };
      await withActor(actor, () =>
        mutateSecret(
          destinationSlot,
          {
            expectedRevision: null,
            set: { TOKEN: "destination-only-value" },
            delete: [],
          },
          userId,
        ),
      );
      await t.test(
        "sync completes adoption after adding repository secret; history and ciphertext stay intact",
        async () => {
          await sync(second);
          const moved = await workload();
          assert.equal(moved.id, original.id);
          assert.equal(moved.sourceId, secondId);
          assert.equal(moved.manifestState, "active");
          assert.deepEqual(
            (
              await db
                .select()
                .from(managedSecrets)
                .where(eq(managedSecrets.appId, moved.id))
            )[0]?.encryptedPayload,
            encrypted?.encryptedPayload,
          );
          assert.deepEqual(
            (await getRuntimeSourceIds(db, workspaceId, [moved.id])).get(
              moved.id,
            ),
            [firstId],
          );
          assert.equal(
            (
              await db
                .select()
                .from(deployments)
                .where(eq(deployments.appId, moved.id))
            ).length,
            1,
          );
        },
      );
      await t.test(
        "removing the only connection retires immediately; stale reviews and foreign workspaces are rejected",
        async () => {
          const review = await previewRepositoryRemoval(secondId, workspaceId);
          assert.equal(review.summary.retirements, 1);
          await assert.rejects(
            previewRepositoryRemoval(secondId, randomUUID()),
            /Source was not found/,
          );
          await db
            .update(sources)
            .set({ updatedAt: new Date(Date.now() + 1000) })
            .where(eq(sources.id, secondId));
          await assert.rejects(
            deleteSource(secondId, workspaceId, review.revision),
            /impact changed/,
          );
          await withActor(actor, () => deleteSource(secondId, workspaceId));
          assert.equal((await workload()).manifestState, "retired");
          assert.equal((await workload()).archivedAt, null);
          assert.equal(
            (await loadManifestRegistry(db, workspaceId)).declarations.length,
            0,
          );
          assert.equal(
            (await db.select().from(repositoryManifests)).filter(
              (s) => s.workspaceId === workspaceId,
            ).length,
            2,
          );
        },
      );
      await t.test(
        "disconnecting an environment withdraws its snapshot and transfers directly to a compatible claim",
        async () => {
          await db
            .update(sources)
            .set({ status: "active", archivedAt: null })
            .where(eq(sources.id, firstId));
          const [connectedFirst] = await db
            .update(sourceEnvironments)
            .set({ disconnectedAt: null })
            .where(eq(sourceEnvironments.id, first.id))
            .returning();
          assert(connectedFirst);
          const firstSlot = { ...destinationSlot, id: firstId };
          await withActor(actor, () =>
            mutateSecret(
              firstSlot,
              {
                expectedRevision: null,
                set: { TOKEN: "first-only-value" },
                delete: [],
              },
              userId,
            ),
          );
          await sync(connectedFirst);
          assert.equal((await workload()).sourceId, firstId);
          await db
            .update(sources)
            .set({ status: "active", archivedAt: null })
            .where(eq(sources.id, secondId));
          const [connectedSecond] = await db
            .update(sourceEnvironments)
            .set({ disconnectedAt: null })
            .where(eq(sourceEnvironments.id, second.id))
            .returning();
          assert(connectedSecond);
          await sync(connectedSecond);
          const pending = await workload();
          await db
            .update(apps)
            .set({
              deferredAutomaticDeployment: {
                commitSha: "a".repeat(40),
                deploymentDigest: pending.deploymentDigest!,
                manifestId: pending.id,
                deferredAt: new Date().toISOString(),
                reason: "paused",
                scope: "environment",
              },
            })
            .where(eq(apps.id, pending.id));
          const review = await previewRepositoryRemoval(
            firstId,
            workspaceId,
            first.id,
          );
          assert.equal(review.summary.transfers, 1);
          await withActor(actor, () =>
            disconnectSourceEnvironment({
              sourceId: firstId,
              environmentId: first.id,
              workspaceId,
              actorUserId: userId,
              expectedRevision: connectedFirst.mappingRevision,
              expectedRemovalRevision: review.revision,
            }),
          );
          assert.equal((await workload()).deferredAutomaticDeployment, null);
          assert.equal((await workload()).sourceId, secondId);
          assert.equal((await workload()).id, original.id);
          assert.equal((await workload()).manifestState, "active");
          assert.deepEqual(
            (await loadManifestRegistry(db, workspaceId)).declarations.map(
              (d) => d.sourceId,
            ),
            [secondId],
          );
        },
      );
      await t.test(
        "removing the original connection transfers a staging workload with shared repo secrets and a configuration diff",
        async () => {
          const [firstStaging, secondStaging] = await db
            .insert(sourceEnvironments)
            .values([
              { sourceId: firstId, name: "staging", branch: "develop" },
              { sourceId: secondId, name: "staging", branch: "develop" },
            ])
            .returning();
          assert(firstStaging && secondStaging);
          await sync(firstStaging);
          const [stagingWorkload] = await db
            .select()
            .from(apps)
            .where(eq(apps.sourceEnvironmentId, firstStaging.id));
          assert(stagingWorkload);
          const stagingSlot = {
            ...slot,
            id: stagingWorkload.id,
            environment: "staging",
          };
          await withActor(actor, async () =>
            mutateSecret(
              stagingSlot,
              {
                expectedRevision: (await readSecretMetadata(stagingSlot))
                  .revision,
                set: { TOKEN: "{{repo.TOKEN}}" },
                delete: [],
              },
              userId,
            ),
          );
          await sync(secondStaging);
          const [snapshot] = await db
            .select()
            .from(repositoryManifests)
            .where(
              eq(repositoryManifests.sourceEnvironmentId, secondStaging.id),
            );
          assert(snapshot?.manifest.apps[0]);
          snapshot.manifest.apps[0].name = "Destination staging";
          await db
            .update(repositoryManifests)
            .set({ manifest: snapshot.manifest })
            .where(
              eq(repositoryManifests.sourceEnvironmentId, secondStaging.id),
            );
          const review = await previewRepositoryRemoval(firstId, workspaceId);
          assert.equal(review.summary.transfers, 1);
          assert(
            review.workloads
              .find((item) => item.environment === "staging")
              ?.changedPaths.includes("name"),
          );
          await withActor(actor, () =>
            deleteSource(firstId, workspaceId, review.revision),
          );
          const [moved] = await db
            .select()
            .from(apps)
            .where(eq(apps.id, stagingWorkload.id));
          assert.equal(moved?.sourceId, secondId);
          assert.equal(moved?.manifestState, "active");
          assert.equal(moved?.name, "Destination staging");
          assert.equal(
            (
              await db
                .select()
                .from(deployments)
                .where(eq(deployments.appId, stagingWorkload.id))
            ).length,
            0,
          );
        },
      );
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    }
  },
);
