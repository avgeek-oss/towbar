/* eslint-disable max-lines -- The parity suite intentionally exercises the complete REST and MCP authorization matrix together. */
import {
  seedApiServers,
  seedConnectedEnvironment,
} from "./environment-test-helper.js";
import {
  assertPublicOperationNames,
  expectedBrowserOnlyRoutes,
} from "./browser-only-routes.test-helper.js";
import {
  assertScoutApiAccess,
  connectTestMcpClient,
} from "./scout-access-test-helper.js";
import { issueTestMcpToken } from "../mcp-oauth/token-test-helper.js";
import { actorAllows } from "@workspace/towbar-access";
import { defaultKeyHasher } from "@better-auth/api-key";
import {
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import { assertServerConfigReadback } from "./server-config-test-helper.js";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  apiKeyPolicies,
  apiKeys,
  apps,
  auditEvents,
  authRateLimitBuckets,
  deploymentSteps,
  deployments,
  sourceEntities,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "API and MCP enforce persistent key, permission, and rate boundaries",
  { skip: !url },
  async (t) => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TOWBAR_PASSWORD_BREACH_CHECK = "false";
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    process.env.TOWBAR_APP_BASE_URL = "https://app.towbar.test";
    process.env.TOWBAR_API_BASE_URL = "https://api.towbar.test";
    delete process.env.TOWBAR_API_RATE_LIMIT_MAX;
    delete process.env.TOWBAR_API_RATE_LIMIT_WINDOW_SECONDS;
    const bucketHash = createHmac(
      "sha256",
      process.env.TOWBAR_INTERNAL_HMAC_SECRET,
    )
      .update("auth-rate-limit:api-address:unknown")
      .digest("hex");
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl: url,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const {
      createApiKey: createKey,
      listApiKeys,
      revokeApiKey,
    } = await import("../api-keys/service.js");
    const createApiKey = async (...args: Parameters<typeof createKey>) => {
      const created = await createKey(...args);
      assert(created.token);
      return { ...created, token: created.token };
    };
    const { createApp } = await import("../../app.js");
    const { operations, createOpenApiDocument } =
      await import("./catalogue.js");
    const { mcpTools } = await import("./mcp-tools.js");
    const { operationDescription } = await import("../../http/operation.js");
    const { controlPlaneRoutes } =
      await import("../../routes/v1/core/index.js");
    const db = getTowbarDatabase(),
      app = createApp();
    const userId = randomUUID(),
      workspaceId = randomUUID(),
      otherId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      displayName: "API test",
    });
    await db.insert(workspaces).values([
      { id: workspaceId, name: "API test", slug: workspaceId },
      { id: otherId, name: "Other workspace", slug: otherId },
    ]);
    await db
      .insert(workspaceMembers)
      .values({ userId, workspaceId, role: "admin" });
    const user = {
      id: userId,
      email: `${userId}@example.test`,
      name: "API test",
      workspaceId,
      workspaceRole: "admin" as const,
    };
    const ownedServerId = randomUUID(),
      foreignServerId = randomUUID();
    await seedApiServers([
      { id: ownedServerId, workspaceId, ip: "192.0.2.10" },
      { id: foreignServerId, workspaceId: otherId, ip: "192.0.2.11" },
    ]);
    const write = await createApiKey(user, {
      name: "Automation",
      access: "edit",
      includeAdmin: true,
    });
    const read = await createApiKey(user, {
      name: "Read",
      access: "read",
    });
    let mcpRead = await issueTestMcpToken(user, "read");
    let mcpWrite = await issueTestMcpToken(user, "edit");
    const request = async (
      path: string,
      token?: string,
      method = "GET",
      body?: unknown,
      extra: Record<string, string> = {},
    ) =>
      await app.request(`/v1/api${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
          ...extra,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const connect = (token: string) =>
      connectTestMcpClient(token, (request) => app.fetch(request));
    let connectedEnvironment:
      Awaited<ReturnType<typeof seedConnectedEnvironment>> | undefined;
    const clearRateBucket = async () => {
      for (const key of [read.key, write.key, mcpRead.key, mcpWrite.key])
        await db
          .update(apiKeys)
          .set({ requestCount: 0, lastRequest: null, rateLimitMax: 1000 })
          .where(eq(apiKeys.id, key.id));
      await db
        .delete(authRateLimitBuckets)
        .where(eq(authRateLimitBuckets.keyHash, bucketHash));
    };
    t.beforeEach(clearRateBucket);
    try {
      await t.test(
        "REST server configuration and OAuth MCP readback enforce effective capabilities",
        async () => {
          await assertServerConfigReadback({
            request,
            connect,
            mcpRead,
            read,
            write,
            ownedServerId,
            foreignServerId,
          });
          const team = await createApiKey(user, {
            name: "Team automation",
            scope: "team",
            access: "edit",
            includeAdmin: true,
          });
          for (const credential of [write, team]) {
            const [stored] = await db
              .select({ grants: apiKeyPolicies.grants })
              .from(apiKeyPolicies)
              .where(eq(apiKeyPolicies.keyId, credential.key.id));
            assert(stored?.grants);
            const original = stored.grants;
            await db
              .update(apiKeyPolicies)
              .set({
                grants: original.filter(
                  (action) => action !== "server.collectLogs",
                ),
              })
              .where(eq(apiKeyPolicies.keyId, credential.key.id));
            try {
              const identity = (await (
                await request("/identity", credential.token)
              ).json()) as { capabilities: string[] };
              assert(identity.capabilities.includes("server.collectLogs"));
              await db
                .update(apiKeyPolicies)
                .set({ permissionMode: "scoped" })
                .where(eq(apiKeyPolicies.keyId, credential.key.id));
              const restrictedIdentity = (await (
                await request("/identity", credential.token)
              ).json()) as { capabilities: string[] };
              assert(
                !restrictedIdentity.capabilities.includes("server.collectLogs"),
              );
            } finally {
              await db
                .update(apiKeyPolicies)
                .set({ grants: original, permissionMode: "full-admin" })
                .where(eq(apiKeyPolicies.keyId, credential.key.id));
            }
          }
        },
      );
      await t.test(
        "manifest lifecycle reads are shared, removals require admin, and conflicts have no mutation",
        async () => {
          assert.equal(
            (await request("/manifest-lifecycle", read.token)).status,
            200,
          );
          const target = `/retirements/${ownedServerId}/actions/remove`;
          const body = {
            expectedRevision: new Date().toISOString(),
            confirmManifestId: "site",
            reason: "Test authorization",
          };
          assert.equal(
            (
              await request(target, read.token, "POST", body, {
                "idempotency-key": randomUUID(),
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(target, write.token, "POST", body, {
                "idempotency-key": randomUUID(),
              })
            ).status,
            404,
          );
          assert(
            operations
              .filter((op) => op.path === "/manifest-lifecycle")
              .every((op) => op.method === "GET"),
          );
          const client = await connect(mcpRead.token);
          try {
            const tools = await client.listTools();
            assert(
              tools.tools.some(
                (tool) => tool.name === "towbar_manifest_lifecycle_list",
              ),
            );
            assert(
              !tools.tools.some(
                (tool) => tool.name === "towbar_retirement_remove",
              ),
            );
            const result = await client.callTool({
              name: "towbar_manifest_lifecycle_list",
              arguments: { tab: "conflicts" },
            });
            assert.equal(result.isError, false);
          } finally {
            await client.close();
          }
        },
      );
      await t.test(
        "public operations have REST schemas and unique operation IDs; browser-only routes are excluded",
        () => {
          const routes = new Set(
            controlPlaneRoutes.routes
              .filter((r) => r.method !== "ALL")
              .map((r) => `${r.method} ${r.path}`),
          );
          const browserOnly = new Set(
            controlPlaneRoutes.routes
              .filter((r) => operationDescription(r.handler)?.browserOnly)
              .map((r) => `${r.method} ${r.path}`),
          );
          assert.deepEqual(browserOnly, expectedBrowserOnlyRoutes);
          for (const route of browserOnly) routes.delete(route);
          assert.deepEqual(
            new Set(operations.map((op) => `${op.method} ${op.path}`)),
            routes,
          );
          assertPublicOperationNames(operations);
          assert.doesNotThrow(() =>
            JSON.stringify(createOpenApiDocument("https://api.test/v1/api")),
          );
          const secrets = operations.find(
            (op) => op.path === "/settings/secrets/:environment/:stage",
          )!;
          assert(
            secrets.input.safeParse({
              path: { environment: "production", stage: "deployment" },
              body: { expectedRevision: null, set: { HELLO: "world" } },
            }).success,
          );
        },
      );
      await t.test(
        "tokens are random, hashed, and absent from metadata",
        async () => {
          assert.notEqual(write.token, read.token);
          const [stored] = await db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, write.key!.id));
          assert.equal(stored!.key, await defaultKeyHasher(write.token));
          assert(!JSON.stringify(stored).includes(write.token));
          const text = JSON.stringify(await listApiKeys(user));
          assert(!text.includes(write.token));
          assert(!text.includes(stored!.key));
          const audit = await db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.workspaceId, workspaceId));
          assert(
            audit.some(
              (event) =>
                event.action === "api-key.created" &&
                event.targetId === write.key.id,
            ),
          );
          assert(!JSON.stringify(audit).includes(write.token));
          assert.equal(
            (await request("/identity", write.token)).headers.get(
              "cache-control",
            ),
            "no-store",
          );
        },
      );
      await t.test(
        "bearer auth is required and browser sessions keep their origin boundary",
        async () => {
          assert.equal((await request("/apps")).status, 401);
          assert.equal((await request("/apps", "twb_invalid")).status, 401);
          assert.equal(
            (
              await request("/apps", write.token, "GET", undefined, {
                origin: "https://evil.example",
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await app.request("/v1/core/apps", {
                headers: { authorization: `Bearer ${write.token}` },
              })
            ).status,
            401,
          );
          const { assertBrowserSessionBoundary } =
            await import("./browser-session-test-helper.js");
          await assertBrowserSessionBoundary({ db, app, userId, user });
        },
      );
      await t.test(
        "browser-only actions are inaccessible to API keys and MCP",
        async () => {
          const excluded: Array<[string, string, string]> = [
            ["GET", "/notifications", "get_notifications"],
            ["GET", "/notifications/providers", "get_notifications_providers"],
            [
              "GET",
              `/sources/${randomUUID()}/notifications/destinations`,
              "get_sources_by_id_notifications_destinations",
            ],
            [
              "GET",
              "/settings/api-keys/personal",
              "get_settings_api_keys_personal",
            ],
            [
              "POST",
              "/settings/api-keys/personal",
              "post_settings_api_keys_personal",
            ],
            [
              "DELETE",
              `/settings/api-keys/personal/${write.key.id}`,
              "delete_settings_api_keys_personal_by_id",
            ],
            ["PATCH", "/profile", "patch_profile"],
            ["PUT", "/profile/password", "put_profile_password"],
            ["GET", "/sessions", "get_sessions"],
            ["DELETE", `/sessions/${randomUUID()}`, "delete_sessions_by_id"],
            [
              "POST",
              "/github/actions/installation-url",
              "post_github_actions_installation_url",
            ],
            [
              "POST",
              "/github/actions/complete-installation",
              "post_github_actions_complete_installation",
            ],
            ["POST", "/gitlab/oauth/start", "post_gitlab_oauth_start"],
            [
              "DELETE",
              "/gitlab/oauth/connection",
              "delete_gitlab_oauth_connection",
            ],
          ];
          connectedEnvironment = await seedConnectedEnvironment(workspaceId);
          const client = await connect(mcpWrite.token);
          try {
            const tools = await client.listTools();
            const spec = createOpenApiDocument("https://api.test/v1/api");
            for (const [method, path, name] of excluded) {
              try {
                assert.equal(
                  (await request(path, write.token, method)).status,
                  404,
                  `${method} ${path} must not be available to API keys`,
                );
                assert(
                  !tools.tools.some((tool) => tool.name === name),
                  `${name} must not be advertised by MCP`,
                );
                assert(
                  !JSON.stringify(spec.paths).includes(
                    `"operationId":"${name}"`,
                  ),
                  `${name} must not be present in OpenAPI`,
                );
              } catch (error) {
                throw new Error(
                  `Browser-only boundary failed for ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
                  { cause: error },
                );
              }
            }
          } finally {
            await client.close();
          }
        },
      );
      await t.test(
        "read-only, ownership, expiry, revocation, and live role checks",
        async () => {
          assert.equal((await request("/identity", read.token)).status, 200);
          assert.equal(
            (
              await request(
                "/settings/secrets/preview/build",
                read.token,
                "PATCH",
                {
                  expectedRevision: null,
                  set: { API_TEST: "Forbidden" },
                },
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await request(
                "/settings/secrets/preview/build",
                write.token,
                "PATCH",
                {
                  expectedRevision: null,
                  set: { API_TEST: "Via API" },
                },
              )
            ).status,
            200,
          );
          assert.equal(
            (await request("/servers/not-a-uuid", write.token)).status,
            400,
          );
          await assert.rejects(
            createApiKey(
              { ...user, workspaceId: otherId },
              { name: "Foreign membership", access: "read" },
            ),
          );
          const otherUserId = randomUUID();
          await db.insert(users).values({
            id: otherUserId,
            email: `${otherUserId}@example.test`,
            displayName: "Other member",
          });
          await db.insert(workspaceMembers).values({
            userId: otherUserId,
            workspaceId: otherId,
            role: "viewer",
          });
          const otherKey = await createApiKey(
            {
              ...user,
              id: otherUserId,
              workspaceId: otherId,
              workspaceRole: "viewer",
            },
            { name: "Other", access: "read" },
          );
          await assert.rejects(() => revokeApiKey(user, otherKey.key.id));
          assert.equal(
            (await request(`/servers/${ownedServerId}`, otherKey.token)).status,
            404,
          );
          const expiring = await createApiKey(user, {
            name: "Expired",
            access: "read",
          });
          await db
            .update(apiKeys)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(apiKeys.id, expiring.key.id));
          assert.equal(
            (await request("/identity", expiring.token)).status,
            401,
          );
          await db
            .update(workspaceMembers)
            .set({ role: "viewer" })
            .where(eq(workspaceMembers.userId, userId));
          try {
            assert.equal(
              (await request("/integrations", write.token)).status,
              403,
            );
            await assert.rejects(() => connect(mcpWrite.token), { code: 401 });
            await assert.rejects(() => connect(mcpRead.token), { code: 401 });
          } finally {
            await db
              .update(workspaceMembers)
              .set({ role: "admin" })
              .where(eq(workspaceMembers.userId, userId));
          }
          await assert.rejects(() => connect(mcpWrite.token), { code: 401 });
          await assert.rejects(() => connect(mcpRead.token), { code: 401 });
          mcpRead = await issueTestMcpToken(user, "read");
          mcpWrite = await issueTestMcpToken(user, "edit");
          await db
            .update(users)
            .set({ disabledAt: new Date() })
            .where(eq(users.id, userId));
          assert.equal((await request("/identity", write.token)).status, 401);
          await db
            .update(users)
            .set({ disabledAt: null })
            .where(eq(users.id, userId));
        },
      );
      await t.test(
        "Scout rules enforce role writes, read-only keys, and tenant boundaries through REST and MCP",
        async () => {
          await assertScoutApiAccess({
            request,
            connect,
            mcpWrite,
            issueMemberToken: () =>
              issueTestMcpToken({ ...user, workspaceRole: "member" }, "edit"),
            read,
            write,
            ownedServerId,
            foreignServerId,
            setRole: (role) =>
              db
                .update(workspaceMembers)
                .set({ role })
                .where(eq(workspaceMembers.userId, userId)),
          });
          mcpRead = await issueTestMcpToken(user, "read");
          mcpWrite = await issueTestMcpToken(user, "edit");
        },
      );
      await t.test(
        "MCP inspects a Compose service through the app read path",
        async () => {
          assert(connectedEnvironment);
          const { sourceId, environmentId } = connectedEnvironment;
          const entityId = randomUUID();
          const composeId = randomUUID();
          const deploymentId = randomUUID();
          const config = normalizeDeploymentManifest({
            version: 2,
            compose: [
              {
                id: "search",
                name: "Search",
                server: "192.0.2.10",
                file: "compose.yml",
                services: {
                  opensearch: {
                    port: 9200,
                    domains: ["search.example.com"],
                  },
                },
              },
            ],
          }).compose![0]!;
          try {
            await db.insert(sourceEntities).values({
              id: entityId,
              sourceId,
              entityType: "compose",
              manifestId: config.id,
            });
            await db.insert(apps).values({
              id: composeId,
              workspaceId,
              sourceId,
              serverId: ownedServerId,
              entityId,
              sourceEnvironmentId: environmentId,
              manifestId: config.id,
              kind: "compose",
              name: config.name,
              config,
              configDigest: "compose-test",
              sourceRevision: "a".repeat(40),
              requiredSecrets: {
                build: [],
                runtime: [],
                preDeploy: [],
                postDeploy: [],
              },
            });
            await db.insert(deployments).values({
              id: deploymentId,
              workspaceId,
              sourceId,
              serverId: ownedServerId,
              appId: composeId,
              deployableKind: "compose",
              state: "provisioning_tls",
              idempotencyKey: randomUUID(),
              temporalWorkflowId: randomUUID(),
              commitSha: "a".repeat(40),
              manifestDigest: "b".repeat(64),
              requiredSecrets: {
                build: [],
                runtime: [],
                preDeploy: [],
                postDeploy: [],
              },
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
            });
            const { recordDeploymentEvent } =
              await import("../deployments/deployment-events.js");
            await recordDeploymentEvent(deploymentId, {
              state: "switching_traffic",
            });
            const [recordedDeployment] = await db
              .select({ state: deployments.state })
              .from(deployments)
              .where(eq(deployments.id, deploymentId));
            assert.equal(recordedDeployment?.state, "switching_traffic");
            const [recordedStep] = await db
              .select({ state: deploymentSteps.state })
              .from(deploymentSteps)
              .where(eq(deploymentSteps.deploymentId, deploymentId));
            assert.equal(recordedStep?.state, "switching_traffic");
            assert.equal(
              (await request(`/apps/${composeId}`, write.token)).status,
              200,
            );
            assert.equal(
              (
                await request(
                  `/apps/${composeId}/auto-deploy-control`,
                  write.token,
                )
              ).status,
              200,
            );
            assert.equal(
              (
                await request(
                  `/resources/${composeId}/auto-deploy-control`,
                  write.token,
                )
              ).status,
              404,
            );
            const client = await connect(mcpWrite.token);
            try {
              const inspection = await client.callTool({
                name: "towbar_workload_inspect",
                arguments: { kind: "app", workloadId: composeId },
              });
              assert.equal(
                inspection.isError,
                false,
                JSON.stringify(inspection.content),
              );
              const { result } = inspection.structuredContent as {
                result: { workload: { app: { kind: string } } };
              };
              assert.equal(result.workload.app.kind, "compose");
            } finally {
              await client.close();
            }
          } finally {
            await db
              .delete(deployments)
              .where(eq(deployments.id, deploymentId));
            await db.delete(apps).where(eq(apps.id, composeId));
            await db
              .delete(sourceEntities)
              .where(eq(sourceEntities.id, entityId));
          }
        },
      );
      await t.test(
        "official MCP client initializes, lists tools, reads and mutates through shared handlers",
        async () => {
          const client = await connect(mcpWrite.token);
          try {
            const list = await client.listTools();
            assert.deepEqual(
              list.tools.map((tool) => tool.name),
              mcpTools
                .filter((tool) => actorAllows(mcpWrite.actor, tool.permissions))
                .map((tool) => tool.name),
            );
            assert(!list.tools.some((tool) => tool.name === "get_apps"));
            const profile = await client.callTool({
              name: "towbar_inventory_search",
              arguments: { kind: "app" },
            });
            assert.equal(
              profile.isError,
              false,
              `App inventory failed: ${JSON.stringify(profile.content)}`,
            );
            const foundServer = await client.callTool({
              name: "towbar_inventory_search",
              arguments: { kind: "server", search: "192.0.2." },
            });
            const { result: searchResult } = foundServer.structuredContent as {
              result: { items: Array<{ id: string; canonicalIp: string }> };
            };
            assert.deepEqual(
              searchResult.items.map((item) => item.id),
              [ownedServerId],
            );
            assert.equal(searchResult.items[0]!.canonicalIp, "192.0.2.10");
            const foreign = await client.callTool({
              name: "towbar_server_inspect",
              arguments: { serverId: foreignServerId },
            });
            assert.equal(
              foreign.isError,
              true,
              "A foreign server must remain inaccessible",
            );
            assert(!JSON.stringify(foreign).includes("192.0.2.11"));
            const invalid = await client.callTool({
              name: "towbar_server_inspect",
              arguments: { serverId: "../../internal" },
            });
            assert.equal(
              invalid.isError,
              true,
              "An invalid server identifier must be rejected",
            );
            const secret = await client.callTool({
              name: "towbar_secrets_update",
              arguments: {
                scope: "workspace",
                environment: "production",
                stage: "deployment",
                expectedRevision: null,
                set: { TEST_VALUE: "do-not-expose" },
              },
            });
            assert.equal(
              secret.isError,
              false,
              `Secret update failed: ${JSON.stringify(secret.content)}`,
            );
            assert(!JSON.stringify(secret).includes("do-not-expose"));
            const readback = await (
              await request("/settings/secrets", write.token)
            ).text();
            assert(readback.includes("TEST_VALUE"));
            assert(!readback.includes("do-not-expose"));
            assert(connectedEnvironment);
            const repositoryId = connectedEnvironment.sourceId;
            const repositorySecret = await client.callTool({
              name: "towbar_secrets_update",
              arguments: {
                scope: "repository",
                targetId: repositoryId,
                environment: "production",
                stage: "build",
                expectedRevision: null,
                set: { PACKAGE_TOKEN: "repository-private-value" },
              },
            });
            assert.equal(repositorySecret.isError, false);
            assert(
              !JSON.stringify(repositorySecret).includes(
                "repository-private-value",
              ),
            );
            const repositoryReadback = await request(
              `/sources/${repositoryId}/secrets`,
              write.token,
            );
            assert.equal(repositoryReadback.status, 200);
            const repositoryText = await repositoryReadback.text();
            assert(repositoryText.includes("PACKAGE_TOKEN"));
            assert(!repositoryText.includes("repository-private-value"));
            assert.equal(
              (
                await request(
                  `/sources/${repositoryId}/secrets/production/build/reveal`,
                  write.token,
                  "POST",
                  { key: "PACKAGE_TOKEN" },
                )
              ).status,
              404,
            );
            const inspect = await client.callTool({
              name: "towbar_secrets_inspect",
              arguments: { scope: "repository", targetId: repositoryId },
            });
            assert.equal(inspect.isError, false);
            assert(
              !JSON.stringify(inspect).includes("repository-private-value"),
            );
          } finally {
            await client.close();
          }
          const reader = await connect(mcpRead.token);
          try {
            const tools = await reader.listTools();
            assert(tools.tools.every((tool) => tool.annotations?.readOnlyHint));
            await assert.rejects(
              () =>
                reader.callTool({
                  name: "towbar_secrets_update",
                  arguments: {
                    scope: "workspace",
                    environment: "preview",
                    stage: "deployment",
                    expectedRevision: null,
                    set: { DENIED: "No" },
                  },
                }),
              /403|insufficient_scope/,
            );
            await revokeApiKey(user, mcpRead.key.id);
            await assert.rejects(() => reader.listTools());
          } finally {
            await reader.close();
          }
        },
      );
      await t.test(
        "default 60 per-IP window is shared by API and MCP and cannot be spoofed",
        async () => {
          await db
            .delete(authRateLimitBuckets)
            .where(eq(authRateLimitBuckets.keyHash, bucketHash));
          await db
            .update(apiKeys)
            .set({ requestCount: 0, lastRequest: null })
            .where(eq(apiKeys.id, write.key.id));
          const results = await Promise.all(
            Array.from({ length: 60 }, (_, i) =>
              request("/identity", write.token, "GET", undefined, {
                "x-forwarded-for": `192.0.2.${i}`,
              }),
            ),
          );
          assert(results.every((result) => result.status === 200));
          const limited = await request("/identity", write.token);
          assert.equal(limited.status, 429);
          assert(Number(limited.headers.get("retry-after")) > 0);
          assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
          const mcp = await app.request("/v1/mcp", {
            method: "POST",
            headers: {
              authorization: `Bearer ${write.token}`,
              "content-type": "application/json",
            },
            body: "{}",
          });
          assert.equal(mcp.status, 429);
          await db
            .update(authRateLimitBuckets)
            .set({ expiresAt: new Date(Date.now() - 1) })
            .where(eq(authRateLimitBuckets.keyHash, bucketHash));
          await db
            .update(apiKeys)
            .set({ requestCount: 0, lastRequest: null })
            .where(eq(apiKeys.id, write.key.id));
          assert.equal((await request("/identity", write.token)).status, 200);
        },
      );
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, otherId));
      await db.delete(users).where(eq(users.id, userId));
      await clearRateBucket();
      await closeDatabase();
    }
  },
);
