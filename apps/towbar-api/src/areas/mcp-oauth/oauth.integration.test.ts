import { installationSetupSecret } from "../auth/setup-secret.js";
import { assertAdminConsent } from "./admin-consent-test-helper.js";
import { assertOAuthDiscovery, assertSdkOAuthFlow } from "./sdk-test-helper.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  apiKeyPolicies,
  apiKeys,
  auditEvents,
  mcpOAuthClients,
  mcpOAuthRequests,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import {
  configureSettingsTestEnv,
  settingsTestClient,
} from "../team/settings-test-client.js";
import { connectTestMcpClient } from "../external-api/scout-access-test-helper.js";
import { digest, secret, tokenLifetimeSeconds } from "./protocol.js";

const databaseUrl = process.env.TOWBAR_OAUTH_TEST_DATABASE_URL;
void test(
  "MCP OAuth discovery, consent, token lifecycle, and OAuth-only access",
  { skip: !databaseUrl, timeout: 120000 },
  async (t) => {
    configureSettingsTestEnv(databaseUrl);
    process.env.TOWBAR_APP_BASE_URL = "https://oauth.towbar.test";
    process.env.TOWBAR_API_BASE_URL = "https://oauth-api.towbar.test";
    process.env.TOWBAR_API_RATE_LIMIT_MAX = "1000";
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { createApp } = await import("../../app.js");
    const auth = await import("../auth/service.js");
    const keys = await import("../api-keys/service.js");
    const { withActor } = await import("../auth/actor-context.js");
    const { recordAuditEvent } = await import("../../infrastructure/audit.js");
    const db = getTowbarDatabase(),
      app = createApp(),
      origin = process.env.TOWBAR_API_BASE_URL,
      uiOrigin = process.env.TOWBAR_APP_BASE_URL;
    const { cookies, request, ok } = settingsTestClient(app, uiOrigin);
    const signup = await auth.createInitialAdmin({
      setupSecret: installationSetupSecret(),
      teamName: "OAuth tests",
      displayName: "OAuth admin",
      email: "oauth-admin@example.test",
      password: "OAuth integration password 91 unique",
    });
    const headers = cookies(signup),
      user = (await auth.findSession(headers))!.user;
    const resource = `${origin}/v1/mcp`,
      redirect = "http://127.0.0.1:4312/callback";
    const register = async (extra: Record<string, unknown> = {}) => {
      const response = await ok(
        await request("/v1/oauth/register", new Headers(), {
          client_name: "Claude",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
          ...extra,
        }),
      );
      return (await response.json()) as {
        client_id: string;
        client_secret?: string;
      };
    };
    const client = await register();
    const start = async (extra: Record<string, string> = {}) => {
      const verifier = secret();
      const params = {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirect,
        resource,
        scope: "mcp:read",
        state: secret(),
        code_challenge: digest(verifier),
        code_challenge_method: "S256",
        ...extra,
      };
      const response = await app.request(
        `/v1/oauth/authorize?${new URLSearchParams(params)}`,
      );
      return {
        response,
        params,
        verifier,
        id:
          response.status === 302
            ? new URL(response.headers.get("location")!).searchParams.get(
                "request",
              )!
            : "",
      };
    };
    const consent = async (extra: Record<string, string> = {}) => {
      const started = await start(extra);
      assert.equal(started.response.status, 302, await started.response.text());
      assert.equal(
        new URL(started.response.headers.get("location")!).origin,
        uiOrigin,
      );
      const response = await ok(
        await request(`/v1/oauth/consent/${started.id}`, headers, {
          allow: true,
        }),
      );
      const callback = new URL(
        ((await response.json()) as { redirectTo: string }).redirectTo,
      );
      assert.equal(callback.searchParams.get("state"), started.params.state);
      assert.equal(callback.searchParams.get("iss"), origin);
      return { ...started, code: callback.searchParams.get("code")! };
    };
    const token = async (
      grant: Awaited<ReturnType<typeof consent>>,
      extra: Record<string, string> = {},
      authorization?: string,
    ) =>
      app.request("/v1/oauth/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(authorization ? { authorization } : {}),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: grant.params.client_id,
          redirect_uri: redirect,
          resource,
          code: grant.code,
          code_verifier: grant.verifier,
          ...extra,
        }),
      });
    const issue = async (extra: Record<string, string> = {}) => {
      const grant = await consent(extra),
        response = await ok(await token(grant));
      const body = (await response.json()) as {
        access_token: string;
        expires_in: number;
        scope: string;
      };
      return { ...body, grant };
    };
    try {
      await t.test(
        "installed MCP SDK completes discovery, DCR, PKCE, consent, and tool access",
        () => assertSdkOAuthFlow(app, origin, headers),
      );
      await t.test(
        "discovery advertises PKCE, CIMD, issuer responses, and MCP resource",
        () => assertOAuthDiscovery(app, origin, resource),
      );
      await t.test(
        "MCP rejects personal and team API keys at every protocol entry point while REST accepts them",
        async () => {
          for (const scope of ["personal", "team"] as const) {
            for (const permission of ["read", "edit", "admin"] as const) {
              const created = await keys.createApiKey(user, {
                name: `${scope} ${permission} REST`,
                scope,
                access: permission === "read" ? "read" : "edit",
                includeAdmin: permission === "admin",
              });
              assert(created.token);
              for (const method of ["GET", "POST", "DELETE"]) {
                const response = await app.request("/v1/mcp", {
                  method,
                  headers: {
                    authorization: `Bearer ${created.token}`,
                    "content-type": "application/json",
                  },
                  ...(method === "POST"
                    ? {
                        body: JSON.stringify({
                          jsonrpc: "2.0",
                          id: 1,
                          method: "tools/list",
                        }),
                      }
                    : {}),
                });
                assert.equal(response.status, 401);
                assert.match(
                  response.headers.get("www-authenticate")!,
                  /invalid_token/,
                );
                assert.match(
                  response.headers.get("www-authenticate")!,
                  /oauth-protected-resource/,
                );
              }
              assert.equal(
                (
                  await app.request("/v1/api/identity", {
                    headers: { authorization: `Bearer ${created.token}` },
                  })
                ).status,
                200,
              );
              await keys.revokeApiKey(user, created.key.id, scope);
            }
          }
          assert.equal((await app.request("/v1/mcp", { headers })).status, 401);
        },
      );
      await t.test(
        "OAuth tokens with another resource audience are rejected by MCP and REST",
        async () => {
          const issued = await issue();
          const principal = await keys.findApiKey(issued.access_token);
          assert(principal);
          await db
            .update(apiKeyPolicies)
            .set({ oauthResource: "https://another.example/v1/mcp" })
            .where(eq(apiKeyPolicies.keyId, principal.key.id));
          for (const path of ["/v1/mcp", "/v1/api/identity"]) {
            const response = await app.request(path, {
              headers: { authorization: `Bearer ${issued.access_token}` },
            });
            assert.equal(response.status, 401);
          }
          await keys.revokeApiKey(user, principal.key.id);
        },
      );
      await t.test(
        "rejects bad callbacks, resource, scope, PKCE, duplicate fields, and missing session",
        async () => {
          for (const extra of [
            { redirect_uri: "https://attacker.example/cb" },
            { resource: "https://other.example/mcp" },
            { scope: "mcp:unknown" },
            { code_challenge_method: "plain" },
            { code_challenge: "short" },
          ] as Record<string, string>[]) {
            const result = await start(extra);
            if (extra.redirect_uri) {
              assert.equal(result.response.status, 400);
              assert.equal(result.response.headers.get("location"), null);
            } else {
              assert.equal(result.response.status, 302);
              const callback = new URL(
                result.response.headers.get("location")!,
              );
              assert(callback.searchParams.get("error"));
              assert.equal(callback.searchParams.get("iss"), origin);
            }
          }
          const started = await start();
          const duplicate = await app.request(
            `/v1/oauth/authorize?${new URLSearchParams(started.params)}&client_id=other`,
          );
          assert.equal(duplicate.status, 400);
          assert.equal(
            (
              await request(`/v1/oauth/consent/${started.id}`, new Headers(), {
                allow: true,
              })
            ).status,
            401,
          );
          const crossOrigin = new Headers(headers);
          crossOrigin.set("origin", "https://attacker.example");
          assert.equal(
            (
              await request(`/v1/oauth/consent/${started.id}`, crossOrigin, {
                allow: true,
              })
            ).status,
            403,
          );
          const details = (await (
            await ok(await request(`/v1/oauth/consent/${started.id}`, headers))
          ).json()) as {
            clientName: string;
            clientTrust: string;
            clientLogo: string | null;
          };
          assert.equal(details.clientName, "Claude");
          assert.equal(details.clientTrust, "unverified");
          assert.equal(details.clientLogo, null);
          const denied = (await (
            await ok(
              await request(`/v1/oauth/consent/${started.id}`, headers, {
                allow: false,
              }),
            )
          ).json()) as { redirectTo: string };
          const callback = new URL(denied.redirectTo);
          assert.equal(callback.searchParams.get("error"), "access_denied");
          assert.equal(callback.searchParams.get("iss"), origin);
          assert.equal(
            (
              await request(`/v1/oauth/consent/${started.id}`, headers, {
                allow: true,
              })
            ).status,
            400,
          );
        },
      );
      await t.test(
        "issues hashed 30-day MCP-only tokens with truthful attribution and permission ceilings",
        async () => {
          const issued = await issue();
          assert.equal(issued.expires_in, tokenLifetimeSeconds);
          const listed = await keys.listApiKeys(user),
            key = listed.find((key) => key.tokenType === "mcp-oauth")!;
          assert(key);
          assert.equal(key.oauthClientId, client.client_id);
          assert.equal(key.oauthClientTrust, "unverified");
          assert.equal(key.oauthClientLogo, null);
          assert.equal(key.includeAdmin, false);
          assert.equal(key.permissionMode, "scoped");
          assert(key.expiresAt);
          assert(
            Math.abs(
              key.expiresAt.getTime() -
                Date.now() -
                tokenLifetimeSeconds * 1000,
            ) < 5000,
          );
          const [stored] = await db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, key.id));
          assert.notEqual(stored!.key, issued.access_token);
          const mcp = await connectTestMcpClient(issued.access_token, (r) =>
            app.fetch(r),
          );
          try {
            const list = await mcp.listTools();
            assert(list.tools.length > 0);
            assert(list.tools.every((tool) => tool.annotations?.readOnlyHint));
          } finally {
            await mcp.close();
          }
          const { mcpTools } = await import("../external-api/mcp-tools.js");
          const writeTool = mcpTools.find((tool) => !tool.readOnly)!;
          const insufficient = await app.request("/v1/mcp", {
            method: "POST",
            headers: {
              authorization: `Bearer ${issued.access_token}`,
              "Content-Type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: writeTool.name, arguments: {} },
            }),
          });
          assert.equal(insufficient.status, 403);
          assert.match(
            insufficient.headers.get("www-authenticate")!,
            /insufficient_scope/,
          );
          assert.match(
            insufficient.headers.get("www-authenticate")!,
            /mcp:write/,
          );
          const apiResponse = await app.request("/v1/api/session", {
            headers: { authorization: `Bearer ${issued.access_token}` },
          });
          assert.equal(apiResponse.status, 401);
          const principal = await keys.findApiKey(issued.access_token);
          assert(principal);
          await withActor(principal.actor, () =>
            recordAuditEvent(db, {
              workspaceId: user.workspaceId,
              action: "scout.rule_created",
              targetType: "repository",
              targetId: randomUUID(),
            }),
          );
          const events = await db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.workspaceId, user.workspaceId));
          assert(
            events.some(
              (event) =>
                event.action === "api-key.created" &&
                event.metadata.tokenType === "mcp-oauth" &&
                event.metadata.oauthClientId === client.client_id,
            ),
          );
          assert(
            events.some(
              (event) =>
                event.action === "scout.rule_created" &&
                event.metadata.oauthClientId === client.client_id,
            ),
          );
          assert(!JSON.stringify(events).includes(issued.access_token));
          await keys.revokeApiKey(user, key.id);
          assert.equal(await keys.findApiKey(issued.access_token), null);
        },
      );
      await assertAdminConsent(t, {
        app,
        db,
        user,
        headers,
        request,
        ok,
        issue: (scope) => issue({ scope }),
        start: () => start({ scope: "mcp:admin" }),
        grant: async () => {
          const granted = await consent({ scope: "mcp:admin" });
          return () => token(granted);
        },
      });
      await t.test(
        "PKCE, client, callback, resource, expiry and single-use code binding",
        async () => {
          const grant = await consent();
          for (const extra of [
            { code_verifier: secret() },
            { redirect_uri: "http://127.0.0.1:4312/other" },
            { resource: "https://other.example/mcp" },
            { client_id: (await register()).client_id },
          ] as Record<string, string>[])
            assert.equal((await token(grant, extra)).status, 400);
          const exchanged = await ok(await token(grant)),
            body = (await exchanged.json()) as { access_token: string };
          assert(await keys.findApiKey(body.access_token));
          assert.equal((await token(grant)).status, 400);
          assert.equal(
            await keys.findApiKey(body.access_token),
            null,
            "Replayed code revokes the token",
          );
          const expired = await consent();
          await db
            .update(mcpOAuthRequests)
            .set({ expiresAt: new Date(0) })
            .where(eq(mcpOAuthRequests.id, expired.id));
          assert.equal((await token(expired)).status, 400);
          const parallel = await consent();
          const responses = await Promise.all([
            token(parallel),
            token(parallel),
          ]);
          assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
        },
      );
      await t.test(
        "confidential clients authenticate; RFC7009 revokes only the owning client's OAuth token",
        async () => {
          const confidential = await register({
            token_endpoint_auth_method: "client_secret_basic",
          });
          assert(confidential.client_secret);
          const grant = await consent({ client_id: confidential.client_id });
          assert.equal((await token(grant)).status, 401);
          const basic = `Basic ${Buffer.from(`${confidential.client_id}:${confidential.client_secret}`).toString("base64")}`;
          const response = await ok(await token(grant, {}, basic)),
            issued = (await response.json()) as { access_token: string };
          const revoke = (clientId: string, authorization?: string) =>
            app.request("/v1/oauth/revoke", {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                ...(authorization ? { authorization } : {}),
              },
              body: new URLSearchParams({
                client_id: clientId,
                token: issued.access_token,
              }),
            });
          assert.equal((await revoke(client.client_id)).status, 200);
          assert(await keys.findApiKey(issued.access_token));
          assert.equal(
            (await revoke(confidential.client_id, basic)).status,
            200,
          );
          assert.equal(await keys.findApiKey(issued.access_token), null);
          assert.equal(
            (await revoke(confidential.client_id, basic)).status,
            200,
          );
        },
      );
      await t.test(
        "role changes, expiry, and account disable immediately constrain tokens; REST API keys are rejected by MCP",
        async () => {
          const legacy = await keys.createApiKey(user, {
            name: "Existing automation",
            access: "read",
            expiresAt: null,
          });
          assert(legacy.token);
          assert.equal(legacy.key.tokenType, "api-key");
          assert.equal(legacy.key.expiresAt, null);
          const issued = await issue({ scope: "mcp:read mcp:write" }),
            principal = await keys.findApiKey(issued.access_token);
          assert(principal);
          await db
            .update(workspaceMembers)
            .set({ role: "viewer" })
            .where(eq(workspaceMembers.userId, user.id));
          try {
            const current = await keys.findApiKey(issued.access_token);
            assert(current);
            assert(!current.user.capabilities.includes("secret.update"));
            const started = await start({ scope: "mcp:write" });
            assert.equal(
              (
                await request(`/v1/oauth/consent/${started.id}`, headers, {
                  allow: true,
                })
              ).status,
              400,
            );
          } finally {
            await db
              .update(workspaceMembers)
              .set({ role: "admin" })
              .where(eq(workspaceMembers.userId, user.id));
          }
          await db
            .update(apiKeys)
            .set({ expiresAt: new Date(0) })
            .where(eq(apiKeys.id, principal.key.id));
          assert.equal(await keys.findApiKey(issued.access_token), null);
          await assert.rejects(() =>
            connectTestMcpClient(legacy.token!, (r) => app.fetch(r)),
          );
          assert.equal(
            (
              await app.request("/v1/api/identity", {
                headers: { authorization: `Bearer ${legacy.token}` },
              })
            ).status,
            200,
          );
          assert(await keys.findApiKey(legacy.token));
          const active = await issue();
          await db
            .update(users)
            .set({ disabledAt: new Date() })
            .where(eq(users.id, user.id));
          assert.equal(await keys.findApiKey(active.access_token), null);
          await db
            .update(users)
            .set({ disabledAt: null })
            .where(eq(users.id, user.id));
          assert.equal(
            (await keys.listApiKeys(user)).find(
              (key) => key.id === legacy.key.id,
            )!.tokenType,
            "api-key",
          );
        },
      );
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, user.workspaceId));
      await db.delete(apiKeys).where(eq(apiKeys.referenceId, user.id));
      await db.delete(users).where(eq(users.id, user.id));
      await db.delete(mcpOAuthClients);
      await closeDatabase();
    }
  },
);
