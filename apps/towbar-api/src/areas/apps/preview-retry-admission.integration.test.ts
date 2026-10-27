import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import test from "node:test";
import { Connection, WorkflowClient } from "@temporalio/client";
import { eq } from "drizzle-orm";
import {
  digestValue,
  isNormalizedCompose,
  isNormalizedResource,
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
  previewHostname,
  requiredSecretsSchema,
} from "@workspace/towbar-core";
import { serverCoordinatorWorkflowId } from "@workspace/towbar-core/temporal";
import {
  apps,
  deployments,
  previewEnvironments,
  servers,
  sourceEntities,
  sourceEnvironments,
  sourceSyncs,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { seedConnectedEnvironment } from "../external-api/environment-test-helper.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "fresh Preview retries validate current PR inputs and dispatch consistently through dedicated build servers",
  { skip: !url },
  async (t) => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.TOWBAR_GITHUB_ENABLED = "true";
    process.env.TOWBAR_GITHUB_APP_ID = "1001";
    process.env.TOWBAR_GITHUB_APP_SLUG = "retry-admission-test";
    process.env.TOWBAR_GITHUB_PRIVATE_KEY_BASE64 = Buffer.from(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ).toString("base64");
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
    const { mutateSecret } = await import("../secrets/store.js");
    const { createWorkspacePrivateKey } =
      await import("../private-keys/service.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      appId = randomUUID();
    const serverId = randomUUID(),
      buildServerId = randomUUID(),
      previewId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: workspaceId,
      name: "Fresh Preview retry",
    });
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.com`,
      displayName: "Test",
    });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId, userId, role: "admin" });
    t.after(async () => {
      await db
        .delete(deployments)
        .where(eq(deployments.workspaceId, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, userId));
      await closeTemporalClient();
      await closeDatabase();
    });
    const { sourceId, environmentId } =
      await seedConnectedEnvironment(workspaceId);
    const mappingRevision = randomUUID();
    const [sync] = await db
      .insert(sourceSyncs)
      .values({
        sourceId,
        sourceEnvironmentId: environmentId,
        mappingRevision,
        status: "succeeded",
      })
      .returning();
    await db
      .update(sourceEnvironments)
      .set({
        mappingRevision,
        previewsEnabled: true,
        latestSuccessfulSyncId: sync!.id,
        latestCommitSha: "a".repeat(40),
        latestManifestDigest: "synced",
      })
      .where(eq(sourceEnvironments.id, environmentId));
    const runtime = normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "ubuntu" },
      buildConcurrency: 2,
      previewBuildConcurrency: 1,
    });
    const builder = normalizeServerConfiguration({
      ip: "192.0.2.20",
      ssh: { username: "ubuntu" },
      buildConcurrency: 7,
    });
    const key = await createWorkspacePrivateKey({
      name: "Build server key",
      algorithm: "ed25519",
      requestedBy: userId,
      workspaceId,
    });
    for (const [id, config] of [
      [serverId, runtime],
      [buildServerId, builder],
    ] as const) {
      await db.insert(servers).values({
        id,
        workspaceId,
        canonicalIp: config.ip,
        config,
        configDigest: digestValue(config),
        preparedAt: new Date(),
        preparedConfigDigest: digestValue(config),
        privateKeyId: key.id,
      });
    }
    const config = normalizeDeploymentManifest({
      version: 2,
      apps: [
        {
          id: "site",
          name: "Site",
          server: runtime.ip,
          dockerfile: "Dockerfile.old",
          container: { port: 3000 },
          domains: { primary: "site.example.com" },
          tls: { mode: "direct" },
          preview: { enabled: true, domain: "preview.example.com" },
        },
      ],
    }).apps[0]!;
    const [entity] = await db
      .insert(sourceEntities)
      .values({ sourceId, entityType: "app", manifestId: config.id })
      .returning();
    const declarations = requiredSecretsSchema.parse({ runtime: ["TOKEN"] });
    await db.insert(apps).values({
      id: appId,
      workspaceId,
      sourceId,
      serverId,
      entityId: entity!.id,
      sourceEnvironmentId: environmentId,
      manifestId: config.id,
      name: config.name,
      config,
      configDigest: digestValue(config),
      sourceRevision: "a".repeat(40),
      requiredSecrets: declarations,
    });
    const hostname = previewHostname({
      appId,
      sourceId,
      pullRequestNumber: 42,
      domain: "preview.example.com",
    });
    await db.insert(previewEnvironments).values({
      id: previewId,
      workspaceId,
      sourceId,
      appId,
      serverId,
      pullRequestNumber: 42,
      branch: "feature",
      gitRef: "refs/pull/42/head",
      hostname,
      runtimeId: previewId,
      latestCommitSha: "a".repeat(40),
      status: "failed",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const originalId = randomUUID();
    await db.insert(deployments).values({
      id: originalId,
      workspaceId,
      sourceId,
      appId,
      serverId,
      state: "failed",
      environment: "preview",
      previewEnvironmentId: previewId,
      hostname,
      gitRef: "refs/pull/42/head",
      commitSha: "a".repeat(40),
      manifestDigest: "old",
      requiredSecrets: declarations,
      appSnapshot: config,
      serverSnapshot: runtime,
      targetEnvironment: {
        id: environmentId,
        name: "production",
        branch: "main",
        mappingRevision,
      },
      idempotencyKey: randomUUID(),
      temporalWorkflowId: randomUUID(),
    });
    await db
      .update(previewEnvironments)
      .set({ latestDeploymentId: originalId })
      .where(eq(previewEnvironments.id, previewId));

    let closed = false,
      previewEnabled = true,
      dedicated = false,
      revisionChanges = false;
    let pullReads = 0,
      loseAcknowledgement = false;
    const headSha = "b".repeat(40),
      rootSha = "3".repeat(40),
      appSha = "4".repeat(40);
    const root = JSON.stringify({
      version: 2,
      environments: { production: { previews: { enabled: true } } },
    });
    const manifest = () =>
      JSON.stringify({
        id: "site",
        name: "PR Site",
        environments: { production: {} },
        server: runtime.ip,
        dockerfile: "Dockerfile.preview",
        container: { port: 3000 },
        domains: { primary: "site.example.com" },
        tls: { mode: "direct" },
        ...(previewEnabled
          ? { preview: { enabled: true, domain: "preview.example.com" } }
          : {}),
        ...(dedicated ? { buildServer: { ip: builder.ip } } : {}),
        secrets: { runtime: ["TOKEN"] },
      });
    t.mock.method(globalThis, "fetch", (value: string, init: RequestInit) => {
      const address = new URL(value);
      assert.equal(address.hostname, "api.github.com");
      const path = address.pathname;
      if (path.endsWith("/access_tokens"))
        return Promise.resolve(
          Response.json({
            token: "fixture-token",
            expires_at: "2099-01-01T00:00:00Z",
          }),
        );
      if (path.endsWith("/pulls/42")) {
        pullReads++;
        return Promise.resolve(
          Response.json({
            number: 42,
            state: closed ? "closed" : "open",
            merged: false,
            draft: false,
            changed_files: 1,
            base: { ref: "main", repo: { full_name: "api-test/platform" } },
            head: {
              ref: "feature",
              sha:
                revisionChanges && pullReads % 2 === 0
                  ? "c".repeat(40)
                  : headSha,
              repo: { full_name: "api-test/platform" },
            },
          }),
        );
      }
      if (path.includes("/git/commits/"))
        return Promise.resolve(
          Response.json({ tree: { sha: "2".repeat(40) } }),
        );
      if (path.includes("/git/trees/"))
        return Promise.resolve(
          Response.json({
            truncated: false,
            tree: [
              {
                path: "towbar.yml",
                type: "blob",
                mode: "100644",
                sha: rootSha,
              },
              {
                path: ".towbar/services/site.service.yml",
                type: "blob",
                mode: "100644",
                sha: appSha,
              },
            ],
          }),
        );
      if (path.includes("/git/blobs/")) {
        const content = path.endsWith(rootSha) ? root : manifest();
        return Promise.resolve(
          Response.json({
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
            size: Buffer.byteLength(content),
          }),
        );
      }
      if (path.endsWith("/deployments") && init.method === "GET")
        return Promise.resolve(Response.json([]));
      if (path.endsWith("/deployments") || path.endsWith("/statuses"))
        return Promise.resolve(Response.json({ id: 1 }));
      throw new Error(`Unexpected fixture request: ${init.method} ${path}`);
    });
    const { requestDeploymentRetry, listAppDeployments } =
      await import("./service.js");
    const { withActor } = await import("../auth/actor-context.js");
    const retry = (input: Parameters<typeof requestDeploymentRetry>[0]) =>
      withActor({ kind: "session", workspaceId, userId, role: "admin" }, () =>
        requestDeploymentRetry(input),
      );
    const dispatches: Parameters<WorkflowClient["signalWithStart"]>[1][] = [];
    t.mock.method(Connection, "connect", () =>
      Promise.resolve(Connection.lazy()),
    );
    t.mock.method(
      WorkflowClient.prototype,
      "signalWithStart",
      function (
        this: WorkflowClient,
        _workflow: Parameters<WorkflowClient["signalWithStart"]>[0],
        options: Parameters<WorkflowClient["signalWithStart"]>[1],
      ) {
        dispatches.push(options);
        if (loseAcknowledgement)
          return Promise.reject(new Error("acknowledgement lost"));
        return Promise.resolve(
          Object.assign(this.getHandle(options.workflowId), {
            signaledRunId: "test-run",
          }),
        );
      },
    );
    const request = {
      deploymentId: originalId,
      idempotencyKey: randomUUID(),
      workspaceId,
      requestedBy: userId,
    };
    const count = async () =>
      (await listAppDeployments(appId, workspaceId, "preview")).length;
    closed = true;
    await assert.rejects(retry(request), /no longer eligible/);
    closed = false;
    previewEnabled = false;
    await assert.rejects(retry(request), /does not enable previews/);
    previewEnabled = true;
    await assert.rejects(retry(request), /Required secrets missing.*TOKEN/);
    assert.equal(await count(), 1);
    await mutateSecret(
      {
        type: "app",
        id: appId,
        workspaceId,
        environment: "preview:production",
        stage: "deployment",
      },
      {
        expectedRevision: null,
        set: { TOKEN: "fixture-preview-value" },
        delete: [],
      },
      null,
    );
    revisionChanges = true;
    pullReads = 0;
    await assert.rejects(retry(request), /pull request changed/);
    assert.equal(await count(), 1);
    revisionChanges = false;
    const created = await retry(request);
    assert.equal(created.replayed, false);
    assert.equal(created.deployment.environment, "preview");
    assert.equal(created.deployment.commitSha, headSha);
    assert.equal(created.deployment.hostname, hostname);
    const [persisted] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, created.deployment.id));
    assert.equal(persisted!.appSnapshot.name, "PR Site");
    assert(
      !isNormalizedCompose(persisted!.appSnapshot) &&
        !isNormalizedResource(persisted!.appSnapshot),
    );
    assert.equal(persisted!.appSnapshot.dockerfile, "Dockerfile.preview");
    assert.deepEqual(persisted!.requiredSecrets.runtime, ["TOKEN"]);
    assert.equal(
      persisted!.idempotencyKey,
      `preview:retry:${digestValue(JSON.stringify({ deploymentId: originalId, key: request.idempotencyKey }))}`,
    );
    assert.equal(persisted!.previewEnvironmentId, previewId);
    assert.equal((await retry(request)).deployment.id, created.deployment.id);
    assert.equal(await count(), 2);
    assert.deepEqual(dispatches[1], dispatches[0]);
    await db
      .update(deployments)
      .set({ state: "succeeded" })
      .where(eq(deployments.id, created.deployment.id));

    dedicated = true;
    const dedicatedRequest = { ...request, idempotencyKey: randomUUID() };
    loseAcknowledgement = true;
    await assert.rejects(retry(dedicatedRequest), /acknowledgement lost/);
    const [queued] = await db
      .select()
      .from(deployments)
      .where(
        eq(
          deployments.idempotencyKey,
          `preview:retry:${digestValue(JSON.stringify({ deploymentId: originalId, key: dedicatedRequest.idempotencyKey }))}`,
        ),
      );
    assert.equal(queued!.buildServerId, buildServerId);
    assert.equal(queued!.state, "queued");
    assert.equal(queued!.buildServerSnapshot!.buildConcurrency, 7);
    await db
      .update(servers)
      .set({ config: { ...builder, buildConcurrency: 23 } })
      .where(eq(servers.id, buildServerId));
    loseAcknowledgement = false;
    const recovered = await retry(dedicatedRequest);
    assert.equal(recovered.deployment.id, queued!.id);
    assert.equal(recovered.replayed, true);
    assert.deepEqual(dispatches[3], dispatches[2]);
    assert.equal(
      dispatches[2]!.workflowId,
      serverCoordinatorWorkflowId(
        createHash("sha256").update(builder.ip).digest("hex").slice(0, 32),
      ),
    );
    assert.deepEqual(dispatches[2]!.signalArgs, [
      {
        appId,
        id: queued!.id,
        kind: "deployment",
        buildConcurrency: 7,
        previewBuildConcurrency: 1,
        priority: "preview",
      },
    ]);
    assert.equal(await count(), 3);
    assert.deepEqual(await listAppDeployments(appId, workspaceId), []);
  },
);
