import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  apps,
  deployments,
  previewEnvironments,
  sourceEntities,
  workspaces,
} from "@workspace/towbar-database/schema";
import {
  digestValue,
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
  "Preview retries remain Preview deployments, replay safely, and respect workspace boundaries",
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
    const { listAppDeployments, requestDeploymentRetry } =
      await import("./service.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      appId = randomUUID(),
      serverId = randomUUID(),
      previewId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: workspaceId,
      name: "Preview retry test",
    });
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
          server: "192.0.2.10",
          dockerfile: "Dockerfile",
          container: { port: 3000 },
        },
      ],
    }).apps[0]!;
    const entityId = randomUUID(),
      requiredSecrets = requiredSecretsSchema.parse({});
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
    const hostname = "pr-42.preview.example.com",
      gitRef = "refs/pull/42/head";
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
    const base = {
      workspaceId,
      sourceId,
      appId,
      serverId,
      commitSha: "a".repeat(40),
      manifestDigest: "b".repeat(64),
      requiredSecrets,
      appSnapshot: config,
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
    };
    const originalId = randomUUID(),
      retryId = randomUUID(),
      productionId = randomUUID(),
      key = randomUUID();
    await db.insert(deployments).values([
      {
        ...base,
        id: originalId,
        state: "failed",
        environment: "preview",
        previewEnvironmentId: previewId,
        hostname,
        gitRef,
        idempotencyKey: randomUUID(),
        temporalWorkflowId: randomUUID(),
      },
      {
        ...base,
        id: retryId,
        state: "queued",
        environment: "preview",
        previewEnvironmentId: previewId,
        hostname,
        gitRef,
        idempotencyKey: `preview:retry:${digestValue(JSON.stringify({ deploymentId: originalId, key }))}`,
        temporalWorkflowId: randomUUID(),
      },
      {
        ...base,
        id: productionId,
        state: "succeeded",
        idempotencyKey: randomUUID(),
        temporalWorkflowId: randomUUID(),
      },
    ]);
    const input = {
      deploymentId: originalId,
      idempotencyKey: key,
      workspaceId,
      requestedBy: null,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await requestDeploymentRetry(input);
      assert.equal(result.deployment.id, retryId);
      assert.equal(result.deployment.environment, "preview");
      assert.equal(result.deployment.hostname, hostname);
      assert.equal(result.replayed, true);
    }
    await assert.rejects(
      requestDeploymentRetry({ ...input, idempotencyKey: randomUUID() }),
      /Preview is no longer enabled/,
    );
    await db
      .update(deployments)
      .set({ state: "cancelled" })
      .where(eq(deployments.id, originalId));
    const cancelledRetry = await requestDeploymentRetry(input);
    assert.equal(cancelledRetry.deployment.id, retryId);
    assert.equal(cancelledRetry.deployment.environment, "preview");
    assert.equal(cancelledRetry.replayed, true);
    assert.deepEqual(
      (await listAppDeployments(appId, workspaceId)).map((d) => d.id),
      [productionId],
    );
    assert.equal(
      (await listAppDeployments(appId, workspaceId, "preview")).length,
      2,
    );
    await assert.rejects(
      requestDeploymentRetry({ ...input, workspaceId: randomUUID() }),
      /not found/i,
    );
    await assert.rejects(
      requestDeploymentRetry({ ...input, deploymentId: retryId }),
      /Only failed or cancelled/,
    );
  },
);
