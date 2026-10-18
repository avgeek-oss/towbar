import { testInstanceLinks } from "../sources/instance-test-helper.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  auditEvents,
  deployments,
  integrationInstallations,
  releases,
  servers,
  sessions,
  sources,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import type { TowbarHonoEnvironment } from "../../http/types.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "managed secrets: database, API boundaries, execution, and lifecycle",
  { skip: !url },
  async (t) => {
    assert(
      url && new URL(url).pathname.endsWith("_test"),
      "Use a dedicated database ending in _test",
    );
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
    const { mutateSecret, readSecretMetadata, resolveServerCredentials } =
      await import("./store.js");
    const { listEnvironmentSecrets } = await import("../apps/secrets.js");
    const { environmentSecretRoutes } =
      await import("../../routes/v1/core/environment-secrets.js");
    const { serverCredentialRoutes } =
      await import("../../routes/v1/core/server-credentials.js");
    const { createServer } = await import("../servers/lifecycle.js");
    const { listServerApps } = await import("../servers/service.js");
    const { HttpError } = await import("../../http/errors.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      otherWorkspaceId = randomUUID(),
      actorUserId = randomUUID(),
      sourceId = randomUUID(),
      serverId = randomUUID(),
      appId = randomUUID();
    const manifest = normalizeDeploymentManifest({
      version: 2,
      apps: [
        {
          id: "app",
          name: "App",
          server: "192.0.2.10",
          dockerfile: "Dockerfile",
          context: ".",
          container: { port: 3000 },
          domains: { primary: "app.example.com" },
          tls: { mode: "cloudflare-dns" },
          preview: {
            enabled: true,
            domain: "preview.example.com",
            ttlHours: 24,
          },
          hooks: {
            preDeploy: { command: ["echo", "pre"] },
            postDeploy: { command: ["echo", "post"] },
          },
        },
      ],
      resources: [
        { id: "db", name: "DB", type: "postgres", server: "192.0.2.10" },
      ],
    });
    const serverConfig = normalizeServerConfiguration({
        ip: "192.0.2.10",
        ssh: { username: "deploy" },
      }),
      appConfig = manifest.apps[0]!;
    const workspaceOwner = { type: "workspace" as const, workspaceId };
    const appOwner = { type: "app" as const, id: appId, workspaceId };
    const slot = {
      ...appOwner,
      environment: "production" as const,
      stage: "deployment",
    };
    const globalSlot = {
      ...workspaceOwner,
      environment: "production" as const,
      stage: "deployment",
    };
    let workspaceRole: "admin" | "member" | "viewer" = "admin",
      requestWorkspace: string = workspaceId;
    const sessionId = randomUUID();
    const api = new Hono<TowbarHonoEnvironment>();
    api.use("*", async (context, next) => {
      context.set("user", {
        id: actorUserId,
        workspaceId: requestWorkspace,
        workspaceRole,
        email: "test@example.com",
        name: "Test",
      });
      context.set("actor", {
        kind: "session",
        workspaceId: requestWorkspace,
        userId: actorUserId,
        role: workspaceRole,
      });
      context.set("currentSessionId", sessionId);
      await next();
    });
    api.onError((error, context) =>
      context.json(
        {
          error:
            error instanceof HttpError
              ? error.publicMessage
              : "Invalid request",
        },
        error instanceof HttpError ? error.status : 400,
      ),
    );
    api.route("/apps/:ownerId/secrets", environmentSecretRoutes("app"));
    api.route(
      "/resources/:ownerId/secrets",
      environmentSecretRoutes("resource"),
    );
    api.route("/settings/secrets", environmentSecretRoutes("workspace"));
    api.route(
      "/sources/:ownerId/secrets",
      environmentSecretRoutes("repository"),
    );
    api.route("/servers/:serverId/credentials", serverCredentialRoutes);
    const patch = async (path: string, body: unknown) =>
      await api.request(path, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      await db.insert(workspaces).values([
        { id: workspaceId, slug: workspaceId, name: "Test" },
        { id: otherWorkspaceId, slug: otherWorkspaceId, name: "Other" },
      ]);
      await db.insert(users).values({
        id: actorUserId,
        email: `${actorUserId}@example.com`,
        displayName: "Test",
      });
      await db
        .insert(workspaceMembers)
        .values({ workspaceId, userId: actorUserId, role: "admin" });
      await db.insert(sessions).values({
        id: sessionId,
        userId: actorUserId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 86400_000),
      });
      const [installation] = await db
        .insert(integrationInstallations)
        .values({
          provider: "github",
          workspaceId,
          externalId: randomUUID(),
          principalName: "test",
          principalType: "Organization",
        })
        .returning();
      await db.insert(sources).values({
        id: sourceId,
        workspaceId,
        integrationInstallationId: installation!.id,
        repositoryOwner: "test",
        repositoryName: "test",
      });
      await db.insert(servers).values({
        id: serverId,
        workspaceId,
        canonicalIp: serverConfig.ip,
        config: serverConfig,
        configDigest: "digest",
      });
      const { createSecretTestEnvironment } =
        await import("./execution-tests.js");
      const environment = await createSecretTestEnvironment(db, sourceId);
      await db.insert(apps).values({
        id: appId,
        ...(await testInstanceLinks(sourceId, "app")),
        sourceEnvironmentId: environment!.id,
        requiredSecrets: {
          build: ["BUILD", "PREVIEW_ONLY"],
          runtime: [
            "TOKEN",
            "MULTILINE",
            "EMPTY",
            "COMMON",
            "GLOBAL_ONLY",
            "PREVIEW_ONLY",
            "GLOBAL_PREVIEW",
          ],
          preDeploy: ["MIGRATION", "PREVIEW_ONLY", "SOURCE_PREVIEW"],
          postDeploy: ["PREVIEW_ONLY"],
        },
        workspaceId,
        sourceId,
        serverId,
        manifestId: "app",
        name: "App",
        kind: "app",
        config: appConfig,
        configDigest: "digest",
        sourceRevision: "1234567",
      });

      await t.test(
        "one workspace server is shared by deployables from multiple Sources",
        async () => {
          const secondSourceId = randomUUID();
          const secondAppId = randomUUID();
          await db.insert(sources).values({
            id: secondSourceId,
            workspaceId,
            integrationInstallationId: installation!.id,
            repositoryOwner: "test",
            repositoryName: "second",
          });
          await db.insert(apps).values({
            id: secondAppId,
            ...(await testInstanceLinks(secondSourceId, "app")),
            workspaceId,
            sourceId: secondSourceId,
            serverId,
            manifestId: "app",
            name: "Second app",
            kind: "app",
            config: appConfig,
            configDigest: "second-digest",
            sourceRevision: "1234567",
          });
          assert.deepEqual(
            (await listServerApps(serverId, workspaceId))
              .map((app) => app.sourceId)
              .sort(),
            [sourceId, secondSourceId].sort(),
          );
          await assert.rejects(
            createServer({ config: serverConfig, workspaceId }),
            /already configured/u,
          );
          await db.delete(sources).where(eq(sources.id, secondSourceId));
        },
      );

      await t.test(
        "empty configuration is editable without AWS; missing server credentials are actionable",
        async () => {
          const bindings = await listEnvironmentSecrets(appOwner, "production");
          assert.equal(bindings.length, 4);
          assert(bindings.every((binding) => binding.revision === null));
          await assert.rejects(
            resolveServerCredentials({ workspaceId, serverId }),
            /Server → Settings → Credentials/u,
          );
        },
      );
      await t.test(
        "workspace secrets use one environment-agnostic slot",
        async () => {
          const connected = await api.request("/settings/secrets");
          assert.equal(connected.status, 200);
          const connectedBody = (await connected.json()) as {
            environments: string[];
          };
          assert.deepEqual(connectedBody.environments, ["production"]);
          const unknown = await api.request(
            "/settings/secrets?environment=staging",
          );
          assert.equal(unknown.status, 200);
          assert.deepEqual(
            ((await unknown.json()) as { environments: string[] }).environments,
            ["production"],
          );
          requestWorkspace = otherWorkspaceId;
          try {
            const empty = await api.request("/settings/secrets");
            assert.equal(empty.status, 200);
            const isolated = (await empty.json()) as {
              environments: string[];
              bindings: unknown[];
              canManageSecrets: boolean;
            };
            assert.deepEqual(isolated.environments, ["production"]);
            assert.equal(isolated.bindings.length, 4);
            assert.equal(isolated.canManageSecrets, true);
          } finally {
            requestWorkspace = workspaceId;
          }
        },
      );
      const { testManagedSecretInheritance } =
        await import("./inheritance-tests.js");
      await testManagedSecretInheritance({
        t,
        db,
        workspaceId,
        actorUserId,
        sourceId,
        appId,
        appOwner,
        globalSlot,
        slot,
      });
      const { testRepositorySecrets } = await import("./repository-tests.js");
      await testRepositorySecrets({
        t,
        db,
        api,
        workspaceId,
        otherWorkspaceId,
        actorUserId,
        sourceId,
        appId,
        setRole: (role) => {
          workspaceRole = role;
        },
        setWorkspace: (id) => {
          requestWorkspace = id;
        },
      });
      await t.test(
        "simultaneous first writes cannot overwrite each other",
        async () => {
          const target = { ...slot, stage: "build" };
          const outcomes = await Promise.allSettled(
            ["one", "two"].map((value) =>
              mutateSecret(
                target,
                { expectedRevision: null, set: { BUILD: value }, delete: [] },
                actorUserId,
              ),
            ),
          );
          assert.equal(
            outcomes.filter((item) => item.status === "fulfilled").length,
            1,
          );
          assert.equal(
            outcomes.filter((item) => item.status === "rejected").length,
            1,
          );
        },
      );
      await t.test(
        "reveal requires an admin; members update values and viewers cannot",
        async () => {
          const path = `/apps/${appId}/secrets/production/deployment`;
          const current = await readSecretMetadata(slot);
          const change = {
            expectedRevision: current.revision,
            set: { TOKEN: "forbidden" },
            delete: [],
          };
          const reveal = () =>
            api.request(`${path}/reveal`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ key: "MULTILINE" }),
            });
          workspaceRole = "member";
          assert.equal((await reveal()).status, 403);
          workspaceRole = "viewer";
          assert.equal((await patch(path, change)).status, 403);
          assert.equal(
            (
              await patch("/settings/secrets/production/deployment", {
                expectedRevision: (await readSecretMetadata(globalSlot))
                  .revision,
                set: { TOKEN: "forbidden-global" },
                delete: [],
              })
            ).status,
            403,
          );
          workspaceRole = "member";
          assert.equal(
            (
              await patch(path, {
                ...change,
                set: { TOKEN: "{{globals.TOKEN}}" },
              })
            ).status,
            200,
          );
          workspaceRole = "admin";
          requestWorkspace = otherWorkspaceId;
          assert.equal((await reveal()).status, 404);
          assert.equal((await patch(path, change)).status, 404);
          requestWorkspace = workspaceId;
          assert.equal(
            (
              await api.request(`/apps/${appId}/secrets/reveal`, {
                method: "POST",
              })
            ).status,
            404,
          );
          const revealed = await reveal();
          assert.equal(revealed.status, 200);
          assert.match(
            revealed.headers.get("cache-control") ?? "",
            /no-store/u,
          );
          assert.equal(
            ((await revealed.json()) as { value: string }).value,
            "line one\nline two",
          );
          const [event] = await db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.action, "secrets.revealed"));
          assert(event);
          assert(!JSON.stringify(event).includes("line one"));
          const response = await api.request(`/apps/${appId}/secrets`);
          assert.match(
            response.headers.get("cache-control") ?? "",
            /no-store/u,
          );
          assert(!(await response.text()).includes("shared-value"));
        },
      );
      const { testBulkReveal } = await import("./bulk-reveal-tests.js");
      await testBulkReveal({
        t,
        db,
        api,
        appId,
        slot,
        globalSlot,
        workspaceId,
        otherWorkspaceId,
        manifest,
        appConfig,
        setRole: (role) => {
          workspaceRole = role;
        },
        setWorkspace: (id) => {
          requestWorkspace = id;
        },
      });
      const { testDeploymentHistory } =
        await import("../deployments/history-tests.js");
      const deploymentContext = {
        t,
        db,
        workspaceId,
        otherWorkspaceId,
        sourceId,
        appId,
        serverId,
        actorUserId,
        appConfig,
        resourceConfig: manifest.resources![0]!,
        serverConfig,
      };
      await testDeploymentHistory(deploymentContext);
      const { testWorkspaceVulnerabilities } =
        await import("../vulnerability-scans/workspace-tests.js");
      await testWorkspaceVulnerabilities(deploymentContext);
      const { testInventory } =
        await import("../inventory/integration-tests.js");
      await testInventory({
        t,
        db,
        workspaceId,
        otherWorkspaceId,
        sourceId,
        serverId,
      });
      const { testManagedSecretExecution } =
        await import("./execution-tests.js");
      await testManagedSecretExecution({
        t,
        db,
        workspaceId,
        actorUserId,
        sourceId,
        serverId,
        appId,
        appConfig,
        serverConfig,
        globalSlot,
        patch,
        api,
        setWorkspaceRole: (role) => {
          workspaceRole = role;
        },
      });
      const { testSecretLifecycle } = await import("./lifecycle-tests.js");
      await testSecretLifecycle({
        t,
        db,
        appId,
        workspaceId,
        otherWorkspaceId,
        serverId,
        serverConfig,
        slot,
      });
    } finally {
      await db.delete(releases).where(eq(releases.appId, appId));
      await db
        .delete(deployments)
        .where(eq(deployments.workspaceId, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
      await db.delete(users).where(eq(users.id, actorUserId));
      await closeDatabase();
    }
  },
);
