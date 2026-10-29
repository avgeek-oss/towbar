import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  digestValue,
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apiKeyPolicies,
  apiKeys,
  apps,
  deployments,
  previewEnvironments,
  servers,
  sourceEntities,
  sourceEnvironments,
  sourceSyncs,
  sources,
  users,
  workspaces,
} from "@workspace/towbar-database/schema";
import { seedEnvironmentTeam } from "../sources/environment-server-tests.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "automatic collectors retain sync authority and blocked candidates allow post-sync work",
  {
    skip: !url || !process.env.TOWBAR_TEST_TEMPORAL_ADDRESS,
    timeout: 120_000,
  },
  async (t) => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    // A private database: admitResumedAutomaticDeployments()
    // resumes every deferred app in its database, including other suites' apps.
    const admin = postgres(url, { max: 1, onnotice() {} });
    const privateDatabase = `towbar_automatic_deployments_${randomUUID().replaceAll("-", "")}_test`;
    await admin.unsafe(`CREATE DATABASE "${privateDatabase}"`);
    t.after(async () => {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${privateDatabase}" WITH (FORCE)`,
      );
      await admin.end();
    });
    const isolated = new URL(url);
    isolated.pathname = `/${privateDatabase}`;
    process.env.DATABASE_TOWBAR_URL = isolated.href;
    process.env.TEMPORAL_ADDRESS = process.env.TOWBAR_TEST_TEMPORAL_ADDRESS!;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl: isolated.href,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { closeTemporalClient } =
      await import("../../infrastructure/temporal.js");
    t.after(async () => {
      await Promise.all([closeTemporalClient(), closeDatabase()]);
    });
    const { captureQueuedActor, withActor } =
      await import("../auth/actor-context.js");
    const { createApiKey, resolveApiKeyPrincipal } =
      await import("../api-keys/service.js");
    const {
      scheduleSourceAutomaticDeployments,
      scheduleLatestAutomaticDeploymentsForSource,
      admitResumedAutomaticDeployments,
    } = await import("./automatic-deployments.js");
    const { updateSourceAutoDeployControl, updateDeployableAutoDeployControl } =
      await import("../auto-deploy-controls/service.js");
    const { requestAppDeployment } = await import("./service.js");
    const { requestDisabledPreviewCleanups } =
      await import("../previews/cleanup.js");
    const { scheduleSourcePreviewReconciliations } =
      await import("../previews/reconciliation-scheduler.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      sourceId = randomUUID();
    const serverId = randomUUID(),
      appId = randomUUID(),
      environmentId = randomUUID(),
      entityId = randomUUID(),
      syncId = randomUUID();
    const mappingRevision = randomUUID(),
      commitSha = "a".repeat(40);
    const config = normalizeDeploymentManifest({
      version: 2,
      source: { branch: "main" },
      apps: [
        {
          id: "collector",
          name: "Collector",
          server: "192.0.2.10",
          dockerfile: "Dockerfile",
          autoDeploy: true,
          rollout: {
            type: "recreate",
            maintenanceMode: true,
            reason: "One state writer",
          },
          container: {
            port: 2020,
            hostLogs: { dockerJsonFiles: true },
            resources: { cpus: 0.25, memory: "256m" },
            volumes: [{ name: "state", mountPath: "/var/lib/fluent-bit" }],
          },
        },
      ],
    }).apps[0]!;
    const enabled = normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "root" },
      hostLogCollection: true,
    });
    const actor = {
      kind: "session" as const,
      role: "admin" as const,
      userId,
      workspaceId,
    };
    const effects: string[] = [];
    const reconciled: number[] = [];
    const dependencies = {
      requestDeployment: requestAppDeployment,
      cleanupPreviews: (sourceId: string, environmentId: string) => {
        effects.push("cleanup");
        return requestDisabledPreviewCleanups(sourceId, environmentId);
      },
      reconcilePreviews: (sourceId: string) => {
        effects.push("reconcile");
        return scheduleSourcePreviewReconciliations(sourceId, {
          listPullRequests: () => Promise.resolve([]),
          enqueue: ({ pullRequestNumber }) => {
            reconciled.push(pullRequestNumber);
            return Promise.resolve({
              workflowId: `preview-test-${pullRequestNumber}`,
            });
          },
        });
      },
    };
    try {
      await seedEnvironmentTeam({ workspaceId, userId, sourceId });
      await db.insert(servers).values({
        id: serverId,
        workspaceId,
        canonicalIp: enabled.ip,
        config: enabled,
        configDigest: digestValue(enabled),
        preparedConfigDigest: digestValue(enabled),
        preparedAt: new Date(),
      });
      await db.insert(sourceEnvironments).values({
        id: environmentId,
        sourceId,
        name: "production",
        branch: "main",
        mappingRevision,
        latestCommitSha: commitSha,
        latestManifestDigest: "b".repeat(64),
      });
      await db.insert(sourceEntities).values({
        id: entityId,
        sourceId,
        entityType: "app",
        manifestId: "collector",
      });
      await db.insert(apps).values({
        id: appId,
        workspaceId,
        sourceId,
        serverId,
        entityId,
        sourceEnvironmentId: environmentId,
        manifestId: "collector",
        name: "Collector",
        config,
        configDigest: digestValue(config),
        deploymentDigest: "c".repeat(64),
        sourceRevision: commitSha,
        requiredSecrets: {
          build: [],
          runtime: [],
          preDeploy: [],
          postDeploy: [],
        },
      });
      const key = await withActor(actor, () =>
        createApiKey(
          {
            id: userId,
            name: "Admin",
            email: `${userId}@example.com`,
            workspaceId,
            workspaceRole: "admin",
          },
          {
            name: "Scoped sync",
            scope: "team",
            access: "edit",
            includeAdmin: true,
          },
        ),
      );
      await db
        .update(apiKeyPolicies)
        .set({
          grants: ["admin"],
        })
        .where(eq(apiKeyPolicies.keyId, key.key.id));
      const principal = await resolveApiKeyPrincipal(key.key.id);
      assert(principal);
      const attribution = withActor(principal.actor, () =>
        captureQueuedActor(workspaceId, ["admin"]),
      );
      await db.insert(sourceSyncs).values({
        id: syncId,
        sourceId,
        sourceEnvironmentId: environmentId,
        mappingRevision,
        commitSha,
        status: "succeeded",
        deployAfterSync: true,
        ...attribution,
      });
      await db
        .update(sourceEnvironments)
        .set({ latestSuccessfulSyncId: syncId })
        .where(eq(sourceEnvironments.id, environmentId));
      const queued = () =>
        db.select().from(deployments).where(eq(deployments.appId, appId));
      const clearDeployments = () =>
        db.delete(deployments).where(eq(deployments.appId, appId));
      await t.test(
        "a key reduced to write access cannot defer or resume administrator operations",
        async () => {
          await db
            .update(apiKeyPolicies)
            .set({ grants: ["viewer", "member"] })
            .where(eq(apiKeyPolicies.keyId, key.key.id));
          const limited = await resolveApiKeyPrincipal(key.key.id);
          assert(limited);
          assert.equal(limited.user.capabilities.includes("admin"), false);
          assert.equal(limited.user.capabilities.includes("member"), true);
          await db
            .update(sourceSyncs)
            .set(attribution)
            .where(eq(sourceSyncs.id, syncId));
          for (const scope of ["source", "app"] as const) {
            if (scope === "source")
              await updateSourceAutoDeployControl({
                sourceId,
                workspaceId,
                paused: true,
              });
            else
              await updateDeployableAutoDeployControl({
                deployableId: appId,
                expectedType: "app",
                workspaceId,
                paused: true,
              });
            await assert.rejects(
              scheduleSourceAutomaticDeployments(syncId, dependencies),
              /Access changed/,
            );
            const [app] = await db
              .select()
              .from(apps)
              .where(eq(apps.id, appId));
            assert.equal(app?.deferredAutomaticDeployment, null);
            await db
              .update(apps)
              .set({
                deferredAutomaticDeployment: {
                  commitSha,
                  deploymentDigest: "c".repeat(64),
                  deferredAt: new Date().toISOString(),
                  manifestId: appId,
                  reason: "paused",
                  scope: scope === "source" ? "source" : "deployable",
                },
              })
              .where(eq(apps.id, appId));
            if (scope === "source")
              await updateSourceAutoDeployControl({
                sourceId,
                workspaceId,
                paused: false,
              });
            else
              await updateDeployableAutoDeployControl({
                deployableId: appId,
                expectedType: "app",
                workspaceId,
                paused: false,
              });
            await admitResumedAutomaticDeployments();
            assert.equal((await queued()).length, 0);
            await db
              .update(apps)
              .set({ deferredAutomaticDeployment: null })
              .where(eq(apps.id, appId));
          }
        },
      );
      await t.test(
        "deferred authority is rechecked against live key grants and retained on successful admission",
        async () => {
          await db
            .update(apiKeyPolicies)
            .set({
              grants: ["admin"],
            })
            .where(eq(apiKeyPolicies.keyId, key.key.id));
          await db
            .update(sourceSyncs)
            .set(attribution)
            .where(eq(sourceSyncs.id, syncId));
          await updateSourceAutoDeployControl({
            sourceId,
            workspaceId,
            paused: true,
          });
          assert.deepEqual(
            (await scheduleSourceAutomaticDeployments(syncId, dependencies))
              .deploymentIds,
            [],
          );
          const [deferred] = await db
            .select()
            .from(apps)
            .where(eq(apps.id, appId));
          assert.equal(
            deferred?.deferredAutomaticDeployment?.commitSha,
            commitSha,
          );
          await updateSourceAutoDeployControl({
            sourceId,
            workspaceId,
            paused: false,
          });
          await db
            .update(apiKeyPolicies)
            .set({ grants: ["viewer", "member"] })
            .where(eq(apiKeyPolicies.keyId, key.key.id));
          const denied = await scheduleLatestAutomaticDeploymentsForSource({
            sourceId,
            workspaceId,
          });
          assert.equal(denied.skippedDeployments?.[0]?.code, "FORBIDDEN");
          await admitResumedAutomaticDeployments();
          assert.equal((await queued()).length, 0);
          await db
            .update(apiKeyPolicies)
            .set({
              grants: ["admin"],
            })
            .where(eq(apiKeyPolicies.keyId, key.key.id));
          await db
            .update(apiKeyPolicies)
            .set({ revokedAt: new Date() })
            .where(eq(apiKeyPolicies.keyId, key.key.id));
          await admitResumedAutomaticDeployments();
          assert.equal((await queued()).length, 0);
          await db
            .update(apiKeyPolicies)
            .set({ revokedAt: null })
            .where(eq(apiKeyPolicies.keyId, key.key.id));
          await admitResumedAutomaticDeployments();
          assert.equal((await queued()).length, 1);
          const [deployment] = await queued();
          assert.equal(deployment?.requestedByActor?.kind, "team-key");
          assert.equal(deployment?.requestedByActor?.keyId, key.key.id);
          assert(deployment?.requestedByActor?.grants?.includes("admin"));
          await clearDeployments();
        },
      );
      await t.test(
        "disabled and unauthorized collectors report skips while Preview follow-ups and other candidates continue",
        async () => {
          const plainId = randomUUID(),
            plainEntityId = randomUUID();
          const { hostLogs: _hostLogs, ...container } = config.container;
          const plain = { ...config, id: "plain", name: "Plain", container };
          await db.insert(sourceEntities).values({
            id: plainEntityId,
            sourceId,
            entityType: "app",
            manifestId: "plain",
          });
          await db.insert(apps).values({
            id: plainId,
            workspaceId,
            sourceId,
            serverId,
            entityId: plainEntityId,
            sourceEnvironmentId: environmentId,
            manifestId: "plain",
            name: "Plain",
            config: plain,
            configDigest: digestValue(plain),
            deploymentDigest: "d".repeat(64),
            sourceRevision: commitSha,
            requiredSecrets: {
              build: [],
              runtime: [],
              preDeploy: [],
              postDeploy: [],
            },
          });
          effects.length = 0;
          const previewId = randomUUID();
          await db.insert(previewEnvironments).values({
            id: previewId,
            workspaceId,
            sourceId,
            appId: plainId,
            serverId,
            pullRequestNumber: 7,
            branch: "preview",
            gitRef: "refs/pull/7/head",
            hostname: "pr-7.example.com",
            runtimeId: previewId,
            status: "healthy",
            latestCommitSha: commitSha,
            expiresAt: new Date(Date.now() + 86400_000),
          });
          await db
            .update(servers)
            .set({ config: { ...enabled, hostLogCollection: false } })
            .where(eq(servers.id, serverId));
          const result = await scheduleSourceAutomaticDeployments(
            syncId,
            dependencies,
          );
          assert.equal(result.deploymentIds.length, 1);
          const [ordinary] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.appId, plainId));
          assert.equal(ordinary?.id, result.deploymentIds[0]);
          assert.equal(
            result.skippedDeployments?.[0]?.code,
            "HOST_LOG_COLLECTION_DISABLED",
          );
          assert.deepEqual(effects, ["cleanup", "reconcile"]);
          const [preview] = await db
            .select()
            .from(previewEnvironments)
            .where(eq(previewEnvironments.id, previewId));
          assert.equal(preview?.status, "deleting");
          assert(reconciled.includes(7));
          await db.delete(deployments).where(eq(deployments.appId, plainId));
          await db
            .update(apps)
            .set({ archivedAt: new Date() })
            .where(eq(apps.id, plainId));
          await db
            .update(servers)
            .set({ config: enabled })
            .where(eq(servers.id, serverId));
          await db
            .update(apiKeyPolicies)
            .set({ grants: ["viewer", "member"] })
            .where(eq(apiKeyPolicies.keyId, key.key.id));
          effects.length = 0;
          await assert.rejects(
            scheduleSourceAutomaticDeployments(syncId, dependencies),
            /Access changed/,
          );
          assert.deepEqual(effects, []);
          await db
            .update(apiKeyPolicies)
            .set({
              grants: ["admin"],
            })
            .where(eq(apiKeyPolicies.keyId, key.key.id));
          effects.length = 0;
          await assert.rejects(
            scheduleSourceAutomaticDeployments(syncId, {
              ...dependencies,
              requestDeployment: () =>
                Promise.reject(new Error("unexpected admission failure")),
            }),
            /unexpected admission failure/,
          );
          assert.deepEqual(effects, []);
        },
      );
    } finally {
      await db.delete(deployments).where(eq(deployments.sourceId, sourceId));
      await db.delete(apps).where(eq(apps.sourceId, sourceId));
      await db.delete(sources).where(eq(sources.id, sourceId));
      await db
        .delete(apiKeys)
        .where(
          and(
            eq(apiKeys.configId, "team"),
            eq(apiKeys.referenceId, workspaceId),
          ),
        );
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
);
