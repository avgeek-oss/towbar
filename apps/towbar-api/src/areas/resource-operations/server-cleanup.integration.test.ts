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
  "sync removal and durable server cleanup preserve ownership until retirement",
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
    const {
      lockDomainClaims,
      synchronizeDomainClaims,
      reserveDeploymentDomains,
      deploymentDomainHandoffs,
    } = await import("../deployments/domain-claims.js");
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
      "all removed owners commit and produce one attempt per associated server",
      async () => {
        await db
          .update(servers)
          .set({ archivedAt: new Date() })
          .where(eq(servers.id, builder.id));
        desired = [];
        const completed = await sync();
        assert(completed);
        const attempts = await jobs();
        assert.equal(attempts.length, 3);
        const unavailable = attempts.find(
          (attempt) => attempt.serverId === builder.id,
        );
        assert.equal(unavailable?.state, "failed");
        assert.equal(unavailable?.errorCode, "SERVER_UNAVAILABLE");
        assert.deepEqual(
          new Set(attempts.map((operation) => operation.serverId)),
          new Set([first.id, second.id, builder.id]),
        );
        assert(
          attempts.every(
            (operation) =>
              operation.request.type === "cleanup_orphans" &&
              operation.request.trigger === "sync",
          ),
        );
        await executeEnvironmentSync(completed.id, workspaceId, dependencies);
        assert.equal(
          (await jobs()).length,
          3,
          "sync replay does not duplicate attempts",
        );
        assert.equal(
          (
            await db
              .select()
              .from(domainClaims)
              .where(eq(domainClaims.workspaceId, workspaceId))
          ).length,
          0,
          "does not invent an owner",
        );
      },
    );
    await t.test(
      "hostname reuse remains blocked while retained routes have not been retired",
      async () => {
        desired = ["replacement"];
        assigned = "replacement";
        await assert.rejects(sync(), /multiple deployed owners/);
        assert.equal((await jobs()).length, 3);
      },
    );
    await t.test(
      "re-added workloads and pending deployments are protected by a fresh plan",
      async () => {
        await db
          .update(apps)
          .set({ archivedAt: null })
          .where(eq(apps.id, one.id));
        let plan = await getCleanupExpected(first.id);
        assert(!plan.retiring?.some((app) => app.deployableId === one.id));
        assert(
          plan.imageTags.length >= 2,
          "retained artifacts on every associated server are protected",
        );
        await db
          .update(apps)
          .set({ archivedAt: new Date() })
          .where(eq(apps.id, one.id));
        const pending = await seedRelease(two, first, "pending.example.com");
        await db
          .update(deployments)
          .set({ state: "building" })
          .where(eq(deployments.id, pending.id));
        plan = await getCleanupExpected(first.id);
        assert(plan.protectedDeployableIds?.includes(two.id));
        assert(!plan.retiring?.some((app) => app.deployableId === two.id));
        await db
          .update(deployments)
          .set({ state: "failed" })
          .where(eq(deployments.id, pending.id));
      },
    );
    await t.test(
      "running cleanup locks sync; completion retains history and permits domain reuse",
      async () => {
        await db.insert(domainClaims).values({
          workspaceId,
          sourceEnvironmentId: environment.id,
          hostname: "released.example.com",
          releasedAppId: one.id,
          activeDeploymentId: built.id,
        });
        const attempts = await jobs();
        for (const attempt of attempts) {
          if (attempt.state === "failed") continue;
          const context = await getOperationExecutionContext(attempt.id);
          assert(context.cleanupExpected.retiring?.length);
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
            errorMessage: "Injected unrelated image failure",
            result,
          });
          assert.equal(completed.state, "failed");
          assert.deepEqual(completed.result, result);
          const replay = await finishResourceOperation(attempt.id, {
            state: "succeeded",
            result,
          });
          assert.equal(
            replay.state,
            "failed",
            "terminal callbacks cannot rewrite history",
          );
          assert.equal(
            replay.finishedAt?.getTime(),
            completed.finishedAt?.getTime(),
          );
        }
        const [released] = await db
          .select()
          .from(domainClaims)
          .where(
            and(
              eq(domainClaims.workspaceId, workspaceId),
              eq(domainClaims.hostname, "released.example.com"),
            ),
          );
        assert(
          released && !released.releasedAppId && !released.activeDeploymentId,
        );
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
          ).length >= 4,
        );
        await sync();
        const [claim] = await db
          .select()
          .from(domainClaims)
          .where(
            and(
              eq(domainClaims.workspaceId, workspaceId),
              eq(domainClaims.hostname, hostname),
            ),
          );
        assert(claim?.desiredAppId && !claim.activeAppId);
      },
    );
    await t.test(
      "single-owner removal and replacement retain explicit handoff protection",
      async () => {
        const [replacement] = await db
          .select()
          .from(apps)
          .where(
            and(
              eq(apps.sourceId, sourceId),
              eq(apps.manifestId, "replacement"),
            ),
          );
        assert(replacement);
        const previous = await seedRelease(replacement);
        await db
          .update(domainClaims)
          .set({ activeAppId: replacement.id, activeDeploymentId: previous.id })
          .where(eq(domainClaims.workspaceId, workspaceId));
        desired = ["successor"];
        assigned = "successor";
        await sync();
        const plan = await getCleanupExpected(first.id);
        assert(plan.protectedDeployableIds?.includes(replacement.id));
        const [successor] = await db
          .select()
          .from(apps)
          .where(
            and(eq(apps.sourceId, sourceId), eq(apps.manifestId, "successor")),
          );
        assert(successor);
        const next = await seedRelease(successor);
        await db.delete(releases).where(eq(releases.deploymentId, next.id));
        await db.transaction(async (transaction) => {
          await lockDomainClaims(transaction, workspaceId);
          await reserveDeploymentDomains(transaction, next);
          const handoffs = await deploymentDomainHandoffs(transaction, next);
          assert.equal(handoffs[0]?.previousAppId, replacement.id);
        });
      },
    );
    await t.test(
      "history is paginated without dropping failed or old attempts",
      async () => {
        const page = await listServerCleanups({
          serverId: first.id,
          workspaceId,
          page: 1,
          limit: 1,
        });
        assert(page.pagination.total >= 2);
        const next = await listServerCleanups({
          serverId: first.id,
          workspaceId,
          page: 2,
          limit: 1,
        });
        assert.notEqual(page.operations[0]?.id, next.operations[0]?.id);
        await db.transaction(async (transaction) => {
          await lockDomainClaims(transaction, workspaceId);
          await synchronizeDomainClaims(transaction, workspaceId, {
            sourceEnvironmentId: environment.id,
          });
        });
      },
    );
    await t.test(
      "an actual sync re-add protects the stable workload identity before queued cleanup",
      async () => {
        desired = ["successor", "returning"];
        await sync();
        const [before] = await db
          .select()
          .from(apps)
          .where(
            and(eq(apps.sourceId, sourceId), eq(apps.manifestId, "returning")),
          );
        assert(before);
        desired = ["successor"];
        await sync();
        assert(
          (await getCleanupExpected(first.id)).retiring?.some(
            (app) => app.deployableId === before.id,
          ),
        );
        desired = ["successor", "returning"];
        await sync();
        const [after] = await db
          .select()
          .from(apps)
          .where(eq(apps.id, before.id));
        assert(after && !after.archivedAt);
        assert(
          !(await getCleanupExpected(first.id)).retiring?.some(
            (app) => app.deployableId === before.id,
          ),
        );
      },
    );
  },
);
