import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { eq } from "drizzle-orm";
import {
  apiKeyPolicies,
  mcpOAuthRequests,
  sessions,
  workspaceMembers,
} from "@workspace/towbar-database/schema";
import type { getTowbarDatabase } from "../../infrastructure/database.js";
import type { createApp } from "../../app.js";
import type { AuthenticatedUser } from "../../http/types.js";
import { connectTestMcpClient } from "../external-api/scout-access-test-helper.js";
import type { settingsTestClient } from "../team/settings-test-client.js";
import * as keys from "../api-keys/service.js";

export async function assertAdminConsent(
  t: TestContext,
  context: {
    app: ReturnType<typeof createApp>;
    db: ReturnType<typeof getTowbarDatabase>;
    user: AuthenticatedUser;
    headers: Headers;
    request: ReturnType<typeof settingsTestClient>["request"];
    ok: ReturnType<typeof settingsTestClient>["ok"];
    issue: (scope: string) => Promise<{ access_token: string }>;
    start: () => Promise<{ id: string }>;
    grant: () => Promise<() => Promise<Response>>;
  },
) {
  const { app, db, user, headers, request, ok, issue, start, grant } = context;
  await t.test(
    "ordinary edit consent excludes deployments; explicit admin consent exposes deployment tools and stays scoped",
    async () => {
      for (const scope of ["member", "admin"]) {
        const issued = await issue(scope);
        const principal = await keys.findApiKey(issued.access_token);
        assert(principal);
        const admin = scope === "admin";
        assert.deepEqual(
          principal.user.capabilities,
          admin ? ["viewer", "member", "admin"] : ["viewer", "member"],
        );
        assert.equal(principal.user.workspaceRole, admin ? "admin" : "member");
        const key = (await keys.listApiKeys(user)).find(
          (key) => key.id === principal.key.id,
        )!;
        assert.equal(key.includeAdmin, admin);
        if (admin) {
          await db
            .update(apiKeyPolicies)
            .set({
              grants: key.grants.filter((permission) => permission !== "admin"),
            })
            .where(eq(apiKeyPolicies.keyId, key.id));
          const narrowed = await keys.findApiKey(issued.access_token);
          assert(narrowed);
          assert(!narrowed.user.capabilities.includes("admin"));
          await db
            .update(apiKeyPolicies)
            .set({ grants: key.grants })
            .where(eq(apiKeyPolicies.keyId, key.id));
        }
        const mcp = await connectTestMcpClient(issued.access_token, (r) =>
          app.fetch(r),
        );
        try {
          const list = await mcp.listTools();
          assert.equal(
            list.tools.some((tool) => tool.name === "towbar_workload_deploy"),
            admin,
          );
          if (!admin) {
            const response = await app.request("/v1/mcp", {
              method: "POST",
              headers: {
                authorization: `Bearer ${issued.access_token}`,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "towbar_workload_deploy", arguments: {} },
              }),
            });
            assert.equal(response.status, 403);
            assert.match(response.headers.get("www-authenticate")!, /admin/);
          }
        } finally {
          await mcp.close();
        }
        await keys.revokeApiKey(user, principal.key.id);
      }
    },
  );
  await t.test(
    "admin consent requires recent authentication and non-admins cannot approve or exchange it",
    async () => {
      const started = await start();
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, user.id));
      assert(session);
      await db
        .update(sessions)
        .set({ authenticatedAt: new Date(0) })
        .where(eq(sessions.id, session.id));
      try {
        const response = await request(
          `/v1/oauth/consent/${started.id}`,
          headers,
          { allow: true, accessLevel: "admin" },
        );
        assert.equal(response.status, 403);
        assert.equal(
          ((await response.json()) as { code: string }).code,
          "REAUTHENTICATION_REQUIRED",
        );
        const [pending] = await db
          .select()
          .from(mcpOAuthRequests)
          .where(eq(mcpOAuthRequests.id, started.id));
        assert.equal(pending!.codeHash, null);
        assert.equal(
          (
            await request("/v1/core/session/reauthenticate", headers, {
              password: "OAuth integration password 91 unique",
            })
          ).status,
          200,
        );
        const approved = await ok(
          await request(`/v1/oauth/consent/${started.id}`, headers, {
            allow: true,
            accessLevel: "admin",
          }),
        );
        assert(
          new URL(
            ((await approved.json()) as { redirectTo: string }).redirectTo,
          ).searchParams.get("code"),
        );
      } finally {
        await db
          .update(sessions)
          .set({ authenticatedAt: new Date() })
          .where(eq(sessions.id, session.id));
      }
      for (const role of ["member", "viewer"] as const) {
        const exchange = await grant();
        await db
          .update(workspaceMembers)
          .set({ role })
          .where(eq(workspaceMembers.userId, user.id));
        try {
          const denied = await start();
          assert.equal(
            (
              await request(`/v1/oauth/consent/${denied.id}`, headers, {
                allow: true,
                accessLevel: "admin",
              })
            ).status,
            400,
          );
          assert.equal((await exchange()).status, 400);
          assert.equal(
            (
              await request(`/v1/oauth/consent/${denied.id}`, headers, {
                allow: false,
              })
            ).status,
            200,
          );
        } finally {
          await db
            .update(workspaceMembers)
            .set({ role: "admin" })
            .where(eq(workspaceMembers.userId, user.id));
        }
      }
      const issued = await issue("admin");
      const principal = await keys.findApiKey(issued.access_token);
      assert(principal);
      await db
        .update(workspaceMembers)
        .set({ role: "member" })
        .where(eq(workspaceMembers.userId, user.id));
      try {
        assert.equal(await keys.findApiKey(issued.access_token), null);
      } finally {
        await db
          .update(workspaceMembers)
          .set({ role: "admin" })
          .where(eq(workspaceMembers.userId, user.id));
      }
      await keys.revokeApiKey(user, principal.key.id);
    },
  );
}

export async function assertUserSelectedConsent<Grant>(
  t: TestContext,
  context: {
    db: ReturnType<typeof getTowbarDatabase>;
    user: AuthenticatedUser;
    consent: (
      extra: Record<string, string>,
      selected: "read" | "write" | "admin",
    ) => Promise<Grant>;
    token: (grant: Grant) => Promise<Response>;
    ok: ReturnType<typeof settingsTestClient>["ok"];
  },
) {
  const { db, user, consent, token, ok } = context;
  await t.test(
    "user choice overrides requested scope and promotion permanently revokes access and pending codes",
    async () => {
      const adminGrant = await consent({ scope: "viewer" }, "admin");
      const adminTokens = (await (
        await ok(await token(adminGrant))
      ).json()) as { access_token: string; scope: string };
      assert.equal(adminTokens.scope, "viewer member admin");
      assert(
        (
          await keys.findApiKey(adminTokens.access_token)
        )?.user.capabilities.includes("admin"),
      );
      const readGrant = await consent({ scope: "viewer member admin" }, "read");
      const readTokens = (await (await ok(await token(readGrant))).json()) as {
        access_token: string;
        scope: string;
      };
      assert.equal(readTokens.scope, "viewer");
      assert(
        !(
          await keys.findApiKey(readTokens.access_token)
        )?.user.capabilities.includes("admin"),
      );
      await db
        .update(workspaceMembers)
        .set({ role: "member" })
        .where(eq(workspaceMembers.userId, user.id));
      assert.equal(await keys.findApiKey(adminTokens.access_token), null);
      const memberGrant = await consent({}, "read");
      const memberTokens = (await (
        await ok(await token(memberGrant))
      ).json()) as { access_token: string };
      const pending = await consent({}, "read");
      await db
        .update(workspaceMembers)
        .set({ role: "admin" })
        .where(eq(workspaceMembers.userId, user.id));
      assert.equal(await keys.findApiKey(memberTokens.access_token), null);
      assert.equal((await token(pending)).status, 400);
      assert.equal(await keys.findApiKey(adminTokens.access_token), null);
      assert.equal(await keys.findApiKey(readTokens.access_token), null);
    },
  );
}
