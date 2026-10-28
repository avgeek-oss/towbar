import assert from "node:assert/strict";
import { assertAdminCollectorKeyAccess } from "./admin-collector-key-test-helper.js";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  digestValue,
  isNormalizedApp,
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  previewEnvironments,
  releases,
  servers,
  sourceEntities,
  sourceEnvironments,
  sourceSyncs,
  sources,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { seedEnvironmentTeam } from "../sources/environment-server-tests.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "queued collectors recheck server opt-in, captured authority and the live role, including rollback",
  {
    skip: !url || !process.env.TOWBAR_TEST_TEMPORAL_ADDRESS,
    timeout: 120_000,
  },
  async (t) => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TEMPORAL_ADDRESS = process.env.TOWBAR_TEST_TEMPORAL_ADDRESS!;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.TOWBAR_GITHUB_ENABLED = "true";
    process.env.TOWBAR_GITHUB_APP_ID = "1001";
    process.env.TOWBAR_GITHUB_APP_SLUG = "towbar-test";
    process.env.TOWBAR_GITHUB_PRIVATE_KEY_BASE64 = Buffer.from(
      privateKey.export({ type: "pkcs8", format: "pem" }),
    ).toString("base64");
    t.mock.method(globalThis, "fetch", (url: string) => {
      assert.match(
        url,
        /^https:\/\/api\.github\.com\/app\/installations\/[^/]+\/access_tokens$/u,
      );
      return Promise.resolve(
        Response.json({
          token: "fixture-installation-token",
          expires_at: "2099-01-01T00:00:00Z",
        }),
      );
    });
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
    t.after(async () => {
      await Promise.all([closeTemporalClient(), closeDatabase()]);
    });
    const { getDeploymentExecutionContext } =
      await import("../deployments/service.js");
    const { requestAppRollback } = await import("./service.js");
    const { captureQueuedActor, withActor } =
      await import("../auth/actor-context.js");
    const { hostLogDeploymentPermissions, requireHostLogCollection } =
      await import("./host-log-collection.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      sourceId = randomUUID(),
      appId = randomUUID();
    const serverId = randomUUID(),
      entityId = randomUUID(),
      environmentId = randomUUID();
    const config = normalizeDeploymentManifest({
      version: 2,
      source: { branch: "main" },
      apps: [
        {
          id: "host-logs",
          name: "Host logs",
          server: "192.0.2.10",
          dockerfile: "Dockerfile",
          rollout: {
            type: "recreate",
            maintenanceMode: true,
            reason: "One buffer writer",
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
    const plain = { ...config, container: { port: 2020 } };
    const enabled = normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "root" },
      hostLogCollection: true,
    });
    const disabled = normalizeServerConfiguration({
      ...enabled,
      hostLogCollection: false,
    });
    const secrets = { build: [], runtime: [], preDeploy: [], postDeploy: [] };
    const attribution = {
      kind: "session" as const,
      workspaceId,
      userId,
      grants: ["admin"],
    };
    try {
      await seedEnvironmentTeam({ workspaceId, userId, sourceId });
      await db.insert(servers).values({
        id: serverId,
        workspaceId,
        canonicalIp: enabled.ip,
        config: enabled,
        configDigest: "test",
      });
      await db.insert(sourceEnvironments).values({
        id: environmentId,
        sourceId,
        name: "production",
        branch: "main",
      });
      await db.insert(sourceEntities).values({
        id: entityId,
        sourceId,
        entityType: "app",
        manifestId: "host-logs",
      });
      await db.insert(apps).values({
        id: appId,
        workspaceId,
        sourceId,
        serverId,
        entityId,
        sourceEnvironmentId: environmentId,
        manifestId: "host-logs",
        name: "Host logs",
        config,
        configDigest: "test",
        sourceRevision: "a".repeat(40),
        requiredSecrets: secrets,
      });
      const originalId = randomUUID();
      const common = {
        workspaceId,
        sourceId,
        serverId,
        appId,
        commitSha: "a".repeat(40),
        manifestDigest: "b".repeat(64),
        requiredSecrets: secrets,
        serverSnapshot: enabled,
        targetEnvironment: {
          id: environmentId,
          name: "production",
          branch: "main",
          mappingRevision: randomUUID(),
        },
        requestedByActor: attribution,
      };
      await db.insert(deployments).values({
        ...common,
        id: originalId,
        idempotencyKey: randomUUID(),
        temporalWorkflowId: randomUUID(),
        appSnapshot: config,
        state: "succeeded",
      });
      const queuedId = randomUUID();
      await db.insert(deployments).values({
        ...common,
        id: queuedId,
        idempotencyKey: randomUUID(),
        temporalWorkflowId: randomUUID(),
        appSnapshot: config,
        kind: "rollback",
        rollbackReleaseSnapshot: {
          sourceDeploymentId: originalId,
          releaseId: randomUUID(),
          commitSha: common.commitSha,
          containerName: "previous-collector",
          imageTag: "collector:retained",
        },
      });
      await t.test(
        "admission needs server consent and scoped authority",
        () => {
          assert.throws(
            () => requireHostLogCollection(disabled, config),
            /Admin must allow/,
          );
          assert.doesNotThrow(() => requireHostLogCollection(disabled, plain));
          const key = {
            kind: "team-key" as const,
            workspaceId,
            keyId: randomUUID(),
            policy: {
              scope: "team" as const,
              access: "edit" as const,
              includeAdmin: true,
              grants: ["admin" as const],
            },
          };
          assert.throws(
            () =>
              withActor(key, () =>
                captureQueuedActor(
                  workspaceId,
                  hostLogDeploymentPermissions(config),
                ),
              ),
            /not permitted/,
          );
          assert.doesNotThrow(() =>
            withActor(
              {
                ...key,
                policy: {
                  ...key.policy,
                  grants: hostLogDeploymentPermissions(config),
                },
              },
              () =>
                captureQueuedActor(
                  workspaceId,
                  hostLogDeploymentPermissions(config),
                ),
            ),
          );
        },
      );
      await t.test(
        "authorized collector returns its execution context",
        async () => {
          const context = await getDeploymentExecutionContext(queuedId);
          assert(isNormalizedApp(context.app));
          assert.equal(context.app.container.hostLogs?.dockerJsonFiles, true);
        },
      );
      await t.test(
        "new and already queued rollbacks restore the collector mode and state-volume contract",
        async () => {
          const [environment] = await db
            .select()
            .from(sourceEnvironments)
            .where(eq(sourceEnvironments.id, environmentId));
          assert(environment);
          const syncId = randomUUID(),
            releaseId = randomUUID();
          await db.insert(sourceSyncs).values({
            id: syncId,
            sourceId,
            sourceEnvironmentId: environmentId,
            mappingRevision: environment.mappingRevision,
            status: "succeeded",
            commitSha: common.commitSha,
          });
          await db
            .update(sourceEnvironments)
            .set({
              latestSuccessfulSyncId: syncId,
              latestCommitSha: common.commitSha,
              latestManifestDigest: common.manifestDigest,
            })
            .where(eq(sourceEnvironments.id, environmentId));
          await db
            .update(servers)
            .set({ preparedAt: new Date(), preparedConfigDigest: "test" })
            .where(eq(servers.id, serverId));
          await db
            .update(apps)
            .set({
              config: plain,
              configDigest: digestValue(plain),
              deploymentDigest: "c".repeat(64),
            })
            .where(eq(apps.id, appId));
          await db.insert(releases).values({
            id: releaseId,
            appId,
            deploymentId: originalId,
            status: "previous",
            commitSha: common.commitSha,
            imageTag: "collector:retained",
            containerName: "previous-collector",
          });
          const result = await withActor(
            { kind: "session", workspaceId, userId, role: "admin" },
            () =>
              requestAppRollback({
                appId,
                workspaceId,
                requestedBy: userId,
                releaseId,
                idempotencyKey: randomUUID(),
              }),
          );
          for (const id of [result.deployment.id, queuedId]) {
            if (id === queuedId)
              await db
                .update(deployments)
                .set({ appSnapshot: plain })
                .where(eq(deployments.id, queuedId));
            const execution = await getDeploymentExecutionContext(id);
            assert(isNormalizedApp(execution.app));
            assert.deepEqual(
              execution.app.container.hostLogs,
              config.container.hostLogs,
            );
            assert.deepEqual(
              execution.app.container.resources,
              config.container.resources,
            );
            assert.deepEqual(
              execution.app.container.volumes,
              config.container.volumes,
            );
            assert.deepEqual(execution.app.rollout, config.rollout);
          }
          await db
            .update(deployments)
            .set({ appSnapshot: plain })
            .where(eq(deployments.id, originalId));
          const plainRollback = await getDeploymentExecutionContext(queuedId);
          assert(isNormalizedApp(plainRollback.app));
          assert.equal(plainRollback.app.container.hostLogs, undefined);
          await db
            .update(deployments)
            .set({ appSnapshot: config })
            .where(eq(deployments.id, originalId));
          await db
            .update(deployments)
            .set({ appSnapshot: config })
            .where(eq(deployments.id, queuedId));
        },
      );
      await t.test(
        "revoking the server opt-in invalidates a queued snapshot",
        async () => {
          await db
            .update(servers)
            .set({ config: disabled })
            .where(eq(servers.id, serverId));
          await assert.rejects(
            getDeploymentExecutionContext(queuedId),
            /Admin must allow/,
          );
          await db
            .update(servers)
            .set({ config: enabled })
            .where(eq(servers.id, serverId));
        },
      );
      await t.test(
        "old deployment grants and a demoted Admin cannot acquire access",
        async () => {
          await db
            .update(deployments)
            .set({
              requestedByActor: {
                ...attribution,
                grants: ["admin"],
              },
            })
            .where(eq(deployments.id, queuedId));
          await assert.rejects(
            getDeploymentExecutionContext(queuedId),
            /Access changed/,
          );
          await db
            .update(deployments)
            .set({ requestedByActor: attribution })
            .where(eq(deployments.id, queuedId));
          await db
            .update(workspaceMembers)
            .set({ role: "member" })
            .where(eq(workspaceMembers.userId, userId));
          await assert.rejects(
            getDeploymentExecutionContext(queuedId),
            /Access changed/,
          );
          await db
            .update(workspaceMembers)
            .set({ role: "admin" })
            .where(eq(workspaceMembers.userId, userId));
        },
      );
      await t.test(
        "Preview and rollback to a collector remain gated after removing the capability",
        async () => {
          const previewId = randomUUID();
          await db.insert(previewEnvironments).values({
            id: previewId,
            workspaceId,
            sourceId,
            appId,
            serverId,
            pullRequestNumber: 1,
            branch: "preview",
            gitRef: "refs/pull/1/head",
            hostname: "pr-1.example.com",
            runtimeId: previewId,
            latestCommitSha: common.commitSha,
            expiresAt: new Date(Date.now() + 86400_000),
          });
          await db
            .update(deployments)
            .set({
              environment: "preview",
              previewEnvironmentId: previewId,
              gitRef: "refs/pull/1/head",
              hostname: "pr-1.example.com",
            })
            .where(eq(deployments.id, queuedId));
          await assert.rejects(
            getDeploymentExecutionContext(queuedId),
            /cannot run in Preview/,
          );
          await db
            .update(deployments)
            .set({
              environment: "production",
              previewEnvironmentId: null,
              gitRef: null,
              hostname: null,
              appSnapshot: plain,
            })
            .where(eq(deployments.id, queuedId));
          await db
            .update(servers)
            .set({ config: disabled })
            .where(eq(servers.id, serverId));
          await assert.rejects(
            getDeploymentExecutionContext(queuedId),
            /Admin must allow/,
          );
          await db
            .update(servers)
            .set({ config: enabled })
            .where(eq(servers.id, serverId));
          await db
            .update(deployments)
            .set({
              requestedByActor: {
                ...attribution,
                grants: ["admin"],
              },
            })
            .where(eq(deployments.id, queuedId));
          await assert.rejects(
            getDeploymentExecutionContext(queuedId),
            /Access changed/,
          );
        },
      );
      await t.test(
        "old full admin keys admit collectors and revalidate captured permissions, expiry and revocation",
        () =>
          assertAdminCollectorKeyAccess({ appId, workspaceId, userId, config }),
      );
    } finally {
      await db.delete(releases).where(eq(releases.appId, appId));
      await db.delete(deployments).where(eq(deployments.appId, appId));
      await db.delete(apps).where(eq(apps.id, appId));
      await db.delete(sources).where(eq(sources.id, sourceId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
);
