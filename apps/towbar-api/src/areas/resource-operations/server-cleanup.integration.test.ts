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
  domainClaims,
  releases,
  resourceOperations,
  servers,
  sourceEnvironments,
  sourceSyncs,
  workspaces,
} from "@workspace/towbar-database/schema";
import { seedEnvironmentTeam } from "../sources/environment-server-tests.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "explicit retirement cleanup preserves ownership, scope and history",
  { skip: !url, timeout: 90_000 },
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
    const { withActor, captureQueuedActor } =
      await import("../auth/actor-context.js");
    const { executeEnvironmentSync } =
      await import("../sources/environment-sync.js");
    const { getCleanupExpected } = await import("./cleanup-plan.js");
    const { finishResourceOperation } = await import("./completion.js");
    const { getOperationExecutionContext } = await import("./execution.js");
    const { listServerCleanups } = await import("./server-cleanup.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      sourceId = randomUUID(),
      userId = randomUUID();
    const actor = {
      kind: "session" as const,
      role: "admin" as const,
      userId,
      workspaceId,
    };
    const config = normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "deploy" },
    });
    const hostname = "retired-ingestion.example.com";
    let desired = ["one", "two"],
      assigned: string | undefined,
      broken = false,
      fetchFailed = false,
      sequence = 0,
      dispatched = 0;
    await seedEnvironmentTeam({ workspaceId, sourceId, userId });
    t.after(async () => {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await closeDatabase();
    });
    const [first, second, builder] = await db
      .insert(servers)
      .values(
        [
          config,
          { ...config, ip: "192.0.2.11" },
          { ...config, ip: "192.0.2.12" },
        ].map((server) => ({
          workspaceId,
          canonicalIp: server.ip,
          config: server,
          configDigest: digestValue(server),
        })),
      )
      .returning();
    assert(first && second && builder);
    const [environment] = await db
      .insert(sourceEnvironments)
      .values({ sourceId, name: "production", branch: "main" })
      .returning();
    assert(environment);
    const dependencies = {
      snapshot: () => {
        if (fetchFailed)
          return Promise.reject(new Error("Fixture repository fetch failed"));
        return Promise.resolve({
          commitSha: (++sequence).toString(16).padStart(40, "0"),
          root: "version: 2\nenvironments:\n  production: {}\n",
          configuration: {
            version: 2 as const,
            environments: { production: {} },
          },
          directories: [".towbar/services"],
          files: desired.map((id) => ({
            path: `.towbar/services/${id}.service.yml`,
            content: broken
              ? "[invalid"
              : JSON.stringify({
                  id,
                  name: id,
                  deployment: { type: "image", image: "nginx:alpine" },
                  container: { port: 80 },
                  ...(assigned === id
                    ? { domains: { primary: hostname } }
                    : {}),
                  environments: { production: { server: config.ip } },
                }),
          })),
        });
      },
      tree: () => Promise.resolve({ complete: true, entries: [] }),
      dispatchCleanup: async () => {
        const jobs = await db
          .select()
          .from(resourceOperations)
          .where(eq(resourceOperations.workspaceId, workspaceId));
        for (const operation of jobs) {
          if (
            operation.request.type !== "cleanup_orphans" ||
            !operation.request.syncId
          )
            continue;
          const [sync] = await db
            .select()
            .from(sourceSyncs)
            .where(eq(sourceSyncs.id, operation.request.syncId));
          assert.equal(
            sync?.status,
            "succeeded",
            "delivery only sees committed successful syncs",
          );
        }
        dispatched += 1;
        return jobs.length;
      },
    };
    async function sync() {
      const [job] = await withActor(actor, () =>
        db
          .insert(sourceSyncs)
          .values({
            sourceId,
            sourceEnvironmentId: environment!.id,
            mappingRevision: environment!.mappingRevision,
            ...captureQueuedActor(workspaceId, ["repository.sync"]),
          })
          .returning(),
      );
      assert(job);
      return await withActor(actor, () =>
        executeEnvironmentSync(job.id, workspaceId, dependencies),
      );
    }
    await sync();
    const instances = await db
      .select()
      .from(apps)
      .where(eq(apps.sourceId, sourceId));
    const one = instances.find((app) => app.manifestId === "one")!,
      two = instances.find((app) => app.manifestId === "two")!;
    async function seedRelease(
      app: typeof apps.$inferSelect,
      server = first!,
      domain = hostname,
    ) {
      const id = randomUUID();
      const [deployment] = await db
        .insert(deployments)
        .values({
          id,
          workspaceId,
          sourceId,
          appId: app.id,
          serverId: server.id,
          idempotencyKey: id,
          temporalWorkflowId: `cleanup-fixture-${id}`,
          appSnapshot: {
            ...app.config,
            domains: { primary: domain, redirects: [] },
          },
          serverSnapshot: server.config,
          commitSha: "a".repeat(40),
          manifestDigest: "b".repeat(64),
          requiredSecrets: app.requiredSecrets,
          state: "succeeded",
          targetEnvironment: {
            id: environment!.id,
            name: "production",
            branch: "main",
            mappingRevision: environment!.mappingRevision,
          },
        })
        .returning();
      await db.insert(releases).values({
        deploymentId: id,
        appId: app.id,
        status: "current",
        commitSha: "a".repeat(40),
        containerName: `container-${id}`,
        imageTag: `towbar/${app.id}:${id}`,
      });
      return deployment!;
    }
    const built = await seedRelease(one);
    await db
      .update(deployments)
      .set({ buildServerId: builder.id, buildServerSnapshot: builder.config })
      .where(eq(deployments.id, built.id));
    await seedRelease(two);
    await seedRelease(one, second);
    const jobs = () =>
      db
        .select()
        .from(resourceOperations)
        .where(eq(resourceOperations.workspaceId, workspaceId));
    await t.test(
      "active workloads retain releases without protecting obsolete images; pending work still blocks cleanup",
      async () => {
        const plan = await getCleanupExpected(first.id);
        assert(plan.deployableIds.includes(one.id));
        assert(!plan.protectedDeployableIds?.includes(one.id));
        assert.equal(
          plan.imageOwners?.[`towbar/${one.id}:${built.id}`],
          one.id,
        );
        assert(plan.imageTags.includes(`towbar/${one.id}:${built.id}`));
        assert.equal(
          (await getCleanupExpected(builder.id)).imageOwners?.[
            `towbar/${one.id}:${built.id}`
          ],
          one.id,
        );
        await db
          .update(deployments)
          .set({ state: "building" })
          .where(eq(deployments.id, built.id));
        assert(
          (await getCleanupExpected(first.id)).protectedDeployableIds?.includes(
            one.id,
          ),
        );
        await db
          .update(deployments)
          .set({ state: "succeeded" })
          .where(eq(deployments.id, built.id));
        await db
          .update(apps)
          .set({ manifestState: "conflict" })
          .where(eq(apps.id, one.id));
        assert(
          (await getCleanupExpected(first.id)).protectedDeployableIds?.includes(
            one.id,
          ),
        );
        await db
          .update(apps)
          .set({ manifestState: "active" })
          .where(eq(apps.id, one.id));
      },
    );
    await t.test(
      "active ambiguous retained owners still reject sync and never queue cleanup",
      async () => {
        await assert.rejects(sync(), /multiple deployed owners/);
        assert.equal((await jobs()).length, 0);
      },
    );
    await t.test(
      "fetch and YAML errors do not archive or dispatch cleanup",
      async () => {
        const before = dispatched;
        desired = ["one"];
        broken = true;
        await assert.rejects(sync());
        broken = false;
        fetchFailed = true;
        await assert.rejects(sync(), /fetch failed/);
        fetchFailed = false;
        assert.equal(dispatched, before);
        assert.equal((await jobs()).length, 0);
        assert(
          (
            await db.select().from(apps).where(eq(apps.sourceId, sourceId))
          ).every((app) => !app.archivedAt),
        );
      },
    );

    await t.test(
      "removing manifests retains every runtime and never queues cleanup",
      async () => {
        desired = [];
        await sync();
        const retained = await db
          .select()
          .from(apps)
          .where(eq(apps.sourceId, sourceId));
        assert(
          retained.every(
            (app) => app.manifestState === "retired" && !app.archivedAt,
          ),
        );
        assert.equal((await jobs()).length, 0);
        const plan = await getCleanupExpected(first.id);
        assert(plan.protectedDeployableIds?.includes(one.id));
        assert(plan.protectedDeployableIds?.includes(two.id));
        assert.equal(plan.retiring?.length, 0);
      },
    );
    const { removeRetiredWorkload } =
      await import("../manifest-lifecycle/removal.js");
    async function remove(appId: string) {
      const [app] = await db.select().from(apps).where(eq(apps.id, appId));
      assert(app);
      return withActor(actor, () =>
        removeRetiredWorkload(
          {
            workspaceId,
            workloadId: app.id,
            expectedRevision: app.updatedAt.toISOString(),
            confirmManifestId: app.manifestId,
            reason: "Explicit fixture retirement",
            idempotencyKey: randomUUID(),
            requestedBy: userId,
          },
          () => Promise.resolve(0),
        ),
      );
    }
    await t.test(
      "permanent removal requires all associated servers and queues only approved workload IDs",
      async () => {
        await db
          .update(servers)
          .set({ archivedAt: new Date() })
          .where(eq(servers.id, builder.id));
        await assert.rejects(remove(one.id), /Register all servers/);
        assert.equal((await jobs()).length, 0);
        await db
          .update(servers)
          .set({ archivedAt: null })
          .where(eq(servers.id, builder.id));
        const firstRemoval = await remove(one.id);
        assert.equal(firstRemoval.operations.length, 3);
        assert.equal((await getCleanupExpected(first.id)).retiring?.length, 0);
        assert.deepEqual(
          (await getCleanupExpected(first.id, db, one.id)).retiring?.map(
            (app) => app.deployableId,
          ),
          [one.id],
        );
        assert(
          (
            await getCleanupExpected(first.id, db, one.id)
          ).protectedDeployableIds?.includes(two.id),
        );
        await remove(two.id);
        assert.equal((await jobs()).length, 4);
      },
    );
    await t.test(
      "cleanup serializes sync, preserves history, and records partial failures idempotently",
      async () => {
        await db.insert(domainClaims).values({
          workspaceId,
          sourceEnvironmentId: environment.id,
          hostname: "released.example.com",
          releasedAppId: one.id,
          activeDeploymentId: built.id,
        });
        for (const attempt of await jobs()) {
          const context = await getOperationExecutionContext(attempt.id);
          assert.equal(context.cleanupExpected.retiring?.length, 1);
          assert(attempt.request.type === "cleanup_orphans");
          assert.equal(
            context.cleanupExpected.retiring?.[0]?.deployableId,
            attempt.request.retirementId,
          );
          await assert.rejects(sync(), /cleanup is running/);
          const result = {
            cleaned: [],
            skipped: [],
            retiredDeployableIds: context.cleanupExpected.retiring!.map(
              (app) => app.deployableId,
            ),
            failures: [
              {
                kind: "image" as const,
                name: "unused-image",
                reason: "Injected unrelated failure",
              },
            ],
          };
          const completed = await finishResourceOperation(attempt.id, {
            state: "failed",
            errorCode: "CLEANUP_PARTIAL",
            errorMessage: "Unrelated image failure",
            result,
          });
          const replay = await finishResourceOperation(attempt.id, {
            state: "succeeded",
            result,
          });
          assert.equal(replay.state, "failed");
          assert.equal(
            replay.finishedAt?.getTime(),
            completed.finishedAt?.getTime(),
          );
        }
        const [claim] = await db
          .select()
          .from(domainClaims)
          .where(
            and(
              eq(domainClaims.workspaceId, workspaceId),
              eq(domainClaims.hostname, "released.example.com"),
            ),
          );
        assert(claim && !claim.releasedAppId && !claim.activeDeploymentId);
        assert(
          (await db.select().from(releases))
            .filter((release) => [one.id, two.id].includes(release.appId))
            .every((release) => release.retiredAt),
        );
        assert(
          (
            await db
              .select()
              .from(deployments)
              .where(eq(deployments.workspaceId, workspaceId))
          ).length === 3,
        );
        const [retained] = await db
          .select()
          .from(apps)
          .where(eq(apps.id, one.id));
        assert.equal(retained?.manifestState, "removing");
        const firstPage = await listServerCleanups({
          serverId: first.id,
          workspaceId,
          page: 1,
          limit: 1,
        });
        const nextPage = await listServerCleanups({
          serverId: first.id,
          workspaceId,
          page: 2,
          limit: 1,
        });
        assert(firstPage.pagination.total >= 2);
        assert.notEqual(
          firstPage.operations[0]?.id,
          nextPage.operations[0]?.id,
        );
      },
    );
  },
);
