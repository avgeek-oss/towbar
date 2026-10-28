import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createIconCache } from "./cache.js";
import { loadIcon } from "./discovery.js";
import { eq } from "drizzle-orm";
import {
  apps,
  deployments,
  previewEnvironments,
  sourceEntities,
  workspaces,
} from "@workspace/towbar-database/schema";
import {
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
  requiredSecretsSchema,
} from "@workspace/towbar-core";
import {
  seedApiServers,
  seedConnectedEnvironment,
} from "../external-api/environment-test-helper.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "workload icons use direct image URLs while enforcing workspace ownership and deployment snapshots",
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
    const { getAppIcon, getDeploymentIcon } = await import("./service.js");
    const { appRoutes } = await import("../../routes/v1/core/apps.js");
    const { deploymentRoutes } =
      await import("../../routes/v1/core/deployments.js");
    const { operationDescription } = await import("../../http/operation.js");
    const requests: string[] = [];
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWNkAAAAASUVORK5CYII=",
      "base64",
    );
    const cache = createIconCache((source) =>
      loadIcon(source, (url) => {
        requests.push(url.href);
        return Promise.resolve(
          new Response(image, {
            headers: { "content-type": "image/png" },
          }),
        );
      }),
    );
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      otherWorkspace = randomUUID(),
      appId = randomUUID(),
      serverId = randomUUID(),
      entityId = randomUUID(),
      deploymentId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: "Icon test" });
    t.after(async () => {
      await db
        .delete(deployments)
        .where(eq(deployments.workspaceId, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await closeDatabase();
    });
    const { sourceId, environmentId } =
      await seedConnectedEnvironment(workspaceId);
    await seedApiServers([{ id: serverId, workspaceId, ip: "192.0.2.10" }]);
    const config = normalizeDeploymentManifest({
      version: 2,
      apps: [
        {
          id: "site",
          name: "Site",
          iconUrl: "https://branding.example.com/worker.png?v=2",
          server: "192.0.2.10",
          dockerfile: "Dockerfile",
          container: { port: 3000 },
        },
      ],
    }).apps[0]!;
    const requiredSecrets = requiredSecretsSchema.parse({});
    await db.insert(sourceEntities).values({
      id: entityId,
      sourceId,
      entityType: "app",
      manifestId: config.id,
    });
    await db.insert(apps).values({
      id: appId,
      workspaceId,
      sourceId,
      serverId,
      entityId,
      sourceEnvironmentId: environmentId,
      manifestId: config.id,
      name: config.name,
      config,
      configDigest: "test",
      sourceRevision: "a".repeat(40),
      requiredSecrets,
    });
    const previewId = randomUUID();
    const hostname = `${previewId}.internal`;
    const gitRef = "refs/pull/42/head";
    await db.insert(previewEnvironments).values({
      id: previewId,
      workspaceId,
      sourceId,
      appId,
      serverId,
      pullRequestNumber: 42,
      branch: "feature",
      gitRef,
      hostname,
      runtimeId: previewId,
      latestCommitSha: "a".repeat(40),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(deployments).values({
      id: deploymentId,
      workspaceId,
      sourceId,
      appId,
      serverId,
      idempotencyKey: randomUUID(),
      temporalWorkflowId: randomUUID(),
      commitSha: "a".repeat(40),
      manifestDigest: "b".repeat(64),
      requiredSecrets,
      environment: "preview",
      previewEnvironmentId: previewId,
      hostname,
      gitRef,
      appSnapshot: {
        ...config,
        domains: { primary: "production.example.com", redirects: [] },
      },
      serverSnapshot: normalizeServerConfiguration({
        ip: "192.0.2.10",
        ssh: { username: "ubuntu" },
      }),
      targetEnvironment: {
        id: environmentId,
        name: "production",
        branch: "main",
        mappingRevision: randomUUID(),
      },
    });

    await t.test(
      "private services and previews fetch the direct image and share its cached result",
      async () => {
        const expected = `data:image/png;base64,${image.toString("base64")}`;
        assert.equal(
          (await getAppIcon(appId, workspaceId, cache)).icon,
          expected,
        );
        assert.equal(
          (await getDeploymentIcon(deploymentId, workspaceId, cache)).icon,
          expected,
        );
        assert.deepEqual(requests, [
          "https://branding.example.com/worker.png?v=2",
        ]);
        await db
          .update(apps)
          .set({
            config: {
              ...config,
              iconUrl: "https://branding.example.com/worker-v3.png",
            },
          })
          .where(eq(apps.id, appId));
        assert.equal(
          (await getAppIcon(appId, workspaceId, cache)).icon,
          expected,
        );
        assert.equal(
          (await getDeploymentIcon(deploymentId, workspaceId, cache)).icon,
          expected,
        );
        assert.deepEqual(requests, [
          "https://branding.example.com/worker.png?v=2",
          "https://branding.example.com/worker-v3.png",
        ]);
      },
    );
    await t.test(
      "another workspace cannot resolve existing or previously requested entity IDs",
      async () => {
        const requestCount = requests.length;
        for (const id of [appId, randomUUID()])
          await assert.rejects(
            getAppIcon(id, otherWorkspace, cache),
            /not found/u,
          );
        for (const id of [deploymentId, randomUUID()])
          await assert.rejects(
            getDeploymentIcon(id, otherWorkspace, cache),
            /not found/u,
          );
        assert.equal(requests.length, requestCount);
      },
    );
    await t.test(
      "discovery routes remain browser-only and require entity read permissions",
      () => {
        for (const [router, permission] of [
          [appRoutes, "read"],
          [deploymentRoutes, "read"],
        ] as const) {
          const policy = router.routes
            .filter((route) => route.path.endsWith("/favicon"))
            .flatMap((route) => operationDescription(route.handler) ?? []);
          assert.equal(policy.length, 1);
          assert.equal(policy[0]!.browserOnly, true);
          assert.deepEqual(policy[0]!.permissions, [permission]);
        }
      },
    );
  },
);
