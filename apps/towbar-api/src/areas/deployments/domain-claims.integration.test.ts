import { assertUnrelatedLegacyDomains } from "./domain-scope-test-helper.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  apps,
  deployments,
  domainClaims,
  releases,
  servers,
  sourceEnvironments,
  sourceSyncs,
  sources,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import {
  digestValue,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import { seedEnvironmentTeam } from "../sources/environment-server-tests.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "manifest domain moves reserve, publish and protect the deployed owner",
  { skip: !url || !process.env.TOWBAR_TEST_TEMPORAL_ADDRESS, timeout: 120_000 },
  async (t) => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TEMPORAL_ADDRESS = process.env.TOWBAR_TEST_TEMPORAL_ADDRESS!;
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
    const { closeTemporalClient } =
      await import("../../infrastructure/temporal.js");
    const { withActor, captureQueuedActor } =
      await import("../auth/actor-context.js");
    const { executeEnvironmentSync } =
      await import("../sources/environment-sync.js");
    const { requestAppDeployment } = await import("../apps/service.js");
    const {
      continueAutomaticDeployments,
      scheduleLatestAutomaticDeploymentsForSource,
    } = await import("../apps/automatic-deployments.js");
    const { commitDeploymentRelease } = await import("./service.js");
    const {
      deploymentDomainHandoffs,
      lockDomainClaims,
      reserveDeploymentDomains,
      synchronizeDomainClaims,
    } = await import("./domain-claims.js");
    t.after(async () => {
      await closeTemporalClient();
      await closeDatabase();
    });
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      sourceId = randomUUID();
    const actor = {
      kind: "session" as const,
      role: "admin" as const,
      workspaceId,
      userId,
    };
    const server = normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "deploy" },
    });
    const hostname = "move.example.com";
    let owner = "api",
      sequence = 1,
      uiAutoDeploy = false;
    const dependencies = {
      snapshot: () =>
        Promise.resolve({
          commitSha: String(sequence).padStart(40, "0"),
          root: "version: 2\nenvironments:\n  production: {}\n",
          configuration: {
            version: 2 as const,
            environments: { production: {} },
          },
          directories: [".towbar/services"],
          files: ["api", "ui"].map((id) => ({
            path: `.towbar/services/${id}.service.yml`,
            content: JSON.stringify({
              id,
              name: id.toUpperCase(),
              autoDeploy: id === "api" || uiAutoDeploy,
              container: { port: 3000 + sequence },
              deployment: {
                type: "dockerfile",
                context: ".",
                dockerfile: "Dockerfile",
              },
              ...(owner === id ? { domains: { primary: hostname } } : {}),
              environments: { production: { server: server.ip } },
            }),
          })),
        }),
      tree: () =>
        Promise.resolve({
          complete: true,
          entries: [
            {
              path: "Dockerfile",
              sha: "a".repeat(40),
              mode: "100644",
              type: "blob" as const,
            },
          ],
        }),
    };
    try {
      await seedEnvironmentTeam({ workspaceId, userId, sourceId });
      await db.insert(servers).values({
        workspaceId,
        canonicalIp: server.ip,
        config: server,
        configDigest: digestValue(server),
        preparedConfigDigest: digestValue(server),
        preparedAt: new Date(),
      });
      const [environment] = await db
        .insert(sourceEnvironments)
        .values({ sourceId, name: "production", branch: "main" })
        .returning();
      assert(environment);
      const environmentId = environment.id,
        mappingRevision = environment.mappingRevision;
      async function sync(deployAfterSync = true) {
        sequence += 1;
        const [job] = await withActor(actor, () =>
          db
            .insert(sourceSyncs)
            .values({
              sourceId,
              sourceEnvironmentId: environmentId,
              mappingRevision,
              deployAfterSync,
              ...captureQueuedActor(workspaceId, ["admin"]),
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
      const api = instances.find((app) => app.manifestId === "api")!,
        ui = instances.find((app) => app.manifestId === "ui")!;
      const request = (appId: string) =>
        withActor(actor, () =>
          requestAppDeployment({
            appId,
            idempotencyKey: randomUUID(),
            requestedBy: userId,
            workspaceId,
          }),
        );
      async function publish(id: string) {
        await commitDeploymentRelease(id, {
          containerName: `fixture-${id.slice(0, 8)}`,
          containerNames: [],
          imageDigest: `sha256:${"a".repeat(64)}`,
          imagePlatform: "linux/amd64",
          imageTag: "fixture:domain",
        });
        await db
          .update(deployments)
          .set({ state: "succeeded" })
          .where(eq(deployments.id, id));
      }
      const initial = await request(api.id);
      await t.test(
        "unrelated legacy conflicts do not block sync or admission",
        () =>
          assertUnrelatedLegacyDomains({
            database: db,
            instances: [api, ui],
            deploymentId: initial.deployment.id,
            sync: () => sync(false),
          }),
      );
      await db
        .update(deployments)
        .set({ state: "building" })
        .where(eq(deployments.id, initial.deployment.id));
      await sync(false);
      const blockedLatest = await scheduleLatestAutomaticDeploymentsForSource({
        sourceId,
        sourceEnvironmentId: environmentId,
        workspaceId,
      });
      assert.equal(blockedLatest.deploymentIds.length, 0);
      assert.equal(
        blockedLatest.skippedDeployments?.[0]?.code,
        "DOMAIN_DEPLOYMENT_IN_PROGRESS",
      );
      await publish(initial.deployment.id);
      assert.deepEqual(
        await continueAutomaticDeployments(initial.deployment.id),
        { deploymentIds: [] },
        "a non-deploying sync must not be deployed by continuation",
      );
      const authorizedSync = await sync();
      assert(authorizedSync);
      await db
        .update(workspaceMembers)
        .set({ role: "viewer" })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
      await assert.rejects(
        continueAutomaticDeployments(initial.deployment.id),
        /Access changed/,
      );
      await db
        .update(workspaceMembers)
        .set({ role: "admin" })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
      await db
        .update(sourceSyncs)
        .set({
          requestedByActor: {
            ...authorizedSync.requestedByActor!,
            grants: ["member"],
          },
        })
        .where(eq(sourceSyncs.id, authorizedSync.id));
      await assert.rejects(
        continueAutomaticDeployments(initial.deployment.id),
        /Access changed/,
      );
      await db
        .update(sourceSyncs)
        .set({ requestedByActor: authorizedSync.requestedByActor })
        .where(eq(sourceSyncs.id, authorizedSync.id));
      const latest = await continueAutomaticDeployments(initial.deployment.id);
      assert.equal(
        latest.deploymentIds.length,
        1,
        "a newer automatic update resumes when the hostname reservation finishes",
      );
      const [latestDeployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, latest.deploymentIds[0]!));
      assert(latestDeployment);
      await publish(latestDeployment.id);
      const staleUi = await request(ui.id);
      owner = "ui";
      uiAutoDeploy = true;
      await sync();
      // An older target snapshot without this hostname must not release the source's live claim.
      await db.transaction(async (transaction) => {
        await lockDomainClaims(transaction, workspaceId);
        const [stale] = await transaction
          .select()
          .from(deployments)
          .where(eq(deployments.id, staleUi.deployment.id));
        assert(stale);
        await reserveDeploymentDomains(transaction, stale);
      });
      await publish(staleUi.deployment.id);
      const [planned] = await db
        .select()
        .from(domainClaims)
        .where(
          and(
            eq(domainClaims.workspaceId, workspaceId),
            eq(domainClaims.hostname, hostname),
          ),
        );
      assert.equal(planned!.activeAppId, api.id);
      assert.equal(planned!.desiredAppId, ui.id);
      await assert.rejects(request(api.id), /Deploy that workload first/);
      const moved = await continueAutomaticDeployments(latestDeployment.id);
      assert.equal(
        moved.deploymentIds.length,
        1,
        "a moved claim resumes its new owner even though the completed deployment was not itself a handoff",
      );
      const target = { deployment: { id: moved.deploymentIds[0]! } };
      const [queued] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, target.deployment.id));
      assert.equal(queued!.domainHandoffSnapshot[0]!.previousAppId, api.id);
      await db
        .update(deployments)
        .set({ state: "building" })
        .where(eq(deployments.id, queued!.id));
      await assert.rejects(request(ui.id), /deployment in progress/);
      await db
        .update(deployments)
        .set({ state: "failed", errorCode: "DEPLOYMENT_COMMIT_UNCERTAIN" })
        .where(eq(deployments.id, queued!.id));
      await assert.rejects(request(ui.id), /requires reconciliation/);
      await db
        .update(deployments)
        .set({ state: "building", errorCode: null })
        .where(eq(deployments.id, queued!.id));
      owner = "api";
      await assert.rejects(sync(), /deployment in progress/);
      const [unchanged] = await db
        .select()
        .from(domainClaims)
        .where(
          and(
            eq(domainClaims.workspaceId, workspaceId),
            eq(domainClaims.hostname, hostname),
          ),
        );
      assert.equal(unchanged!.generation, planned!.generation);
      assert.equal(
        unchanged!.activeAppId,
        api.id,
        "failed preparation must preserve the deployed owner",
      );
      await publish(queued!.id);
      const [live] = await db
        .select()
        .from(domainClaims)
        .where(
          and(
            eq(domainClaims.workspaceId, workspaceId),
            eq(domainClaims.hostname, hostname),
          ),
        );
      assert.equal(live!.activeAppId, ui.id);
      const [committed] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, queued!.id));
      assert.equal(
        (await deploymentDomainHandoffs(db, committed!))[0]!.previousAppId,
        api.id,
        "recovery retains the original cutover receipt",
      );
      await db.transaction(async (transaction) => {
        await lockDomainClaims(transaction, workspaceId);
        await synchronizeDomainClaims(transaction, workspaceId);
      });
      await assert.rejects(
        db.transaction(async (transaction) => {
          await lockDomainClaims(transaction, workspaceId);
          const [old] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, initial.deployment.id));
          await reserveDeploymentDomains(transaction, old!);
        }),
        /no longer assigned/,
      );
      const continued = await continueAutomaticDeployments(
        target.deployment.id,
      );
      assert.equal(
        continued.deploymentIds.length,
        1,
        "the source workload resumes after a committed handoff",
      );
      const [retired] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, continued.deploymentIds[0]!));
      assert.equal(retired!.appId, api.id);
      await publish(retired!.id);
      const stableUi = await request(ui.id);
      await publish(stableUi.deployment.id);
      owner = "none";
      await sync();
      const removed = await continueAutomaticDeployments(
        stableUi.deployment.id,
      );
      const removalDeployments = await db
        .select()
        .from(deployments)
        .where(inArray(deployments.id, removed.deploymentIds));
      assert(
        removalDeployments.some((row) => row.appId === ui.id),
        "hostname removal resumes from the previous deployed owner's claim",
      );
      for (const row of removalDeployments) await publish(row.id);
      await db
        .delete(domainClaims)
        .where(eq(domainClaims.workspaceId, workspaceId));
      owner = "api";
      await sync();
      const repaired = await request(api.id);
      const [repair] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, repaired.deployment.id));
      assert.equal(
        repair!.domainHandoffSnapshot[0]!.previousAppId,
        ui.id,
        "legacy released comments are repaired from retained releases",
      );
      const foreignWorkspaceId = randomUUID(),
        foreignUserId = randomUUID(),
        foreignSourceId = randomUUID();
      try {
        await seedEnvironmentTeam({
          workspaceId: foreignWorkspaceId,
          userId: foreignUserId,
          sourceId: foreignSourceId,
        });
        await db.insert(servers).values({
          workspaceId: foreignWorkspaceId,
          canonicalIp: server.ip,
          config: server,
          configDigest: digestValue(server),
          preparedConfigDigest: digestValue(server),
          preparedAt: new Date(),
        });
        const [foreignEnvironment] = await db
          .insert(sourceEnvironments)
          .values({
            sourceId: foreignSourceId,
            name: "production",
            branch: "main",
          })
          .returning();
        assert(foreignEnvironment);
        const foreignActor = {
          ...actor,
          workspaceId: foreignWorkspaceId,
          userId: foreignUserId,
        };
        const [foreignSync] = await withActor(foreignActor, () =>
          db
            .insert(sourceSyncs)
            .values({
              sourceId: foreignSourceId,
              sourceEnvironmentId: foreignEnvironment.id,
              mappingRevision: foreignEnvironment.mappingRevision,
              ...captureQueuedActor(foreignWorkspaceId, ["admin"]),
            })
            .returning(),
        );
        assert(foreignSync);
        await assert.rejects(
          withActor(foreignActor, () =>
            executeEnvironmentSync(
              foreignSync.id,
              foreignWorkspaceId,
              dependencies,
            ),
          ),
          /belongs to another Towbar workspace/,
        );
        assert.deepEqual(
          await db
            .select({ id: apps.id })
            .from(apps)
            .where(eq(apps.sourceId, foreignSourceId)),
          [],
          "a foreign claim must roll back materialization",
        );
      } finally {
        await db
          .delete(domainClaims)
          .where(eq(domainClaims.workspaceId, foreignWorkspaceId));
        await db.delete(apps).where(eq(apps.sourceId, foreignSourceId));
        await db.delete(sources).where(eq(sources.id, foreignSourceId));
        await db
          .delete(workspaces)
          .where(eq(workspaces.id, foreignWorkspaceId));
        await db.delete(users).where(eq(users.id, foreignUserId));
      }
    } finally {
      await db
        .delete(domainClaims)
        .where(eq(domainClaims.workspaceId, workspaceId));
      await db
        .delete(releases)
        .where(
          inArray(
            releases.deploymentId,
            db
              .select({ id: deployments.id })
              .from(deployments)
              .where(eq(deployments.sourceId, sourceId)),
          ),
        );
      await db.delete(deployments).where(eq(deployments.sourceId, sourceId));
      await db.delete(apps).where(eq(apps.sourceId, sourceId));
      await db.delete(sources).where(eq(sources.id, sourceId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
);
