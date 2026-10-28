import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import {
  authAccounts,
  servers,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { configureSettingsTestEnv } from "../team/settings-test-client.js";
import { seedApiServers } from "../external-api/environment-test-helper.js";
import { assistantProviderFixture } from "./provider-test-helper.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "assistant keeps human/workspace history private and requires current authority for approved tools",
  { skip: !url },
  async (t) => {
    configureSettingsTestEnv(url);
    process.env.TOWBAR_APP_BASE_URL = "https://app.towbar.test";
    process.env.TOWBAR_API_BASE_URL = "https://api.towbar.test";
    const provider = await assistantProviderFixture();
    delete process.env.AGENT_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AGENT_HEADERS = "{}";
    process.env.AGENT_API_KEY = "assistant-local-fixture";
    process.env.AGENT_BASE_URL = provider.url;
    process.env.AGENT_MODEL = "fixture-model";
    process.env.AGENT_PROFILE = "compatible";
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl: url!,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { closeAssistant } = await import("./service.js");
    const { createApp } = await import("../../app.js");
    const { getIdentityAuth } = await import("../auth/identity.js");
    const db = getTowbarDatabase();
    const app = createApp();
    let server: ReturnType<typeof serve>;
    const origin = await new Promise<string>((resolve) => {
      server = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        (info) => resolve(`http://127.0.0.1:${info.port}`),
      );
    });
    const workspaceId = randomUUID(),
      otherWorkspaceId = randomUUID();
    const userId = randomUUID(),
      otherUserId = randomUUID();
    const serverId = randomUUID(),
      foreignServerId = randomUUID();
    const password = "Towbar local assistant fixture passphrase 42379!";
    const request = (
      path: string,
      cookie?: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${origin}/v1/agent${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: process.env.TOWBAR_APP_BASE_URL!,
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      await db.insert(workspaces).values([
        { id: workspaceId, name: "Assistant fixture", slug: workspaceId },
        {
          id: otherWorkspaceId,
          name: "Private other workspace",
          slug: otherWorkspaceId,
        },
      ]);
      await db.insert(users).values([
        {
          id: userId,
          email: `${userId}@example.test`,
          displayName: "Assistant owner",
          emailVerified: true,
        },
        {
          id: otherUserId,
          email: `${otherUserId}@example.test`,
          displayName: "Other owner",
          emailVerified: true,
        },
      ]);
      await db.insert(workspaceMembers).values([
        { workspaceId, userId, role: "admin" },
        { workspaceId: otherWorkspaceId, userId: otherUserId, role: "admin" },
      ]);
      const hashed = await hashPassword(password);
      await db.insert(authAccounts).values([
        {
          userId,
          providerId: "credential",
          accountId: userId,
          password: hashed,
        },
        {
          userId: otherUserId,
          providerId: "credential",
          accountId: otherUserId,
          password: hashed,
        },
      ]);
      await seedApiServers([
        { id: serverId, workspaceId, ip: "192.0.2.10" },
        {
          id: foreignServerId,
          workspaceId: otherWorkspaceId,
          ip: "192.0.2.11",
        },
      ]);
      const signIn = async (id: string) => {
        const response = await getIdentityAuth().api.signInEmail({
          body: { email: `${id}@example.test`, password },
          asResponse: true,
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
      };
      const cookie = await signIn(userId),
        otherCookie = await signIn(otherUserId);
      const stream = async (body: unknown) => {
        const response = await request("/steps", cookie, body);
        assert.equal(response.status, 200, await response.clone().text());
        assert.match(
          response.headers.get("cache-control") ?? "",
          /no-transform/,
        );
        const events = (await response.text())
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
        assert.equal(
          events.some((event) => event.type === "error"),
          false,
          JSON.stringify(events),
        );
        const id = events.find(
          (event) => event.type === "step_started",
        )?.conversationId;
        assert.equal(typeof id, "string");
        return { id: String(id), events };
      };
      const decide = (id: string, approved: boolean) => ({
        type: "resolve_tool_calls",
        conversationId: id,
        resolutions: [
          { kind: "confirmation", toolUseId: "fixture-call", approved },
        ],
      });
      const propose = async (buildConcurrency: number) => {
        provider.reply({
          name: "towbar_server_configure",
          input: {
            serverId,
            ip: "192.0.2.10",
            ssh: { username: "ubuntu" },
            buildConcurrency,
            hostLogCollection: false,
          },
        });
        const result = await stream({
          type: "user_message",
          text: "Change the fixture server build concurrency.",
        });
        assert(
          result.events.some((event) => event.type === "awaiting_input"),
          JSON.stringify(result.events),
        );
        return result;
      };
      const concurrency = async () =>
        (
          await db
            .select({ config: servers.config })
            .from(servers)
            .where(eq(servers.id, serverId))
        )[0]!.config.buildConcurrency;
      await t.test(
        "feature is off without credentials and cannot be reached by bearer or cross-origin callers",
        async () => {
          assert.equal((await request("/status")).status, 401);
          assert.equal(
            (
              await request("/status", cookie, undefined, {
                Authorization: "Bearer cannot-borrow-cookie",
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await request(
                "/steps",
                cookie,
                { type: "user_message", text: "Hello" },
                { Origin: "https://untrusted.example" },
              )
            ).status,
            403,
          );
          delete process.env.AGENT_API_KEY;
          assert.deepEqual(await (await request("/status", cookie)).json(), {
            enabled: false,
          });
          assert.equal((await request("/conversations", cookie)).status, 404);
          process.env.AGENT_API_KEY = "assistant-local-fixture";
          assert.equal(provider.requests.length, 0);
        },
      );
      await t.test(
        "a real MCP recipe waits for approval then uses the authenticated control-plane API",
        async () => {
          const proposed = await propose(2);
          assert.equal(await concurrency(), 1);
          const approved = await stream(decide(proposed.id, true));
          assert(
            approved.events.some(
              (event) =>
                event.type === "tool_result" && event.isError === false,
            ),
            JSON.stringify(approved.events),
          );
          assert.equal(await concurrency(), 2);
          await closeAssistant();
          assert.equal(
            (await request(`/conversations/${proposed.id}`, cookie)).status,
            200,
          );
          assert.equal(
            (await request(`/conversations/${proposed.id}`, otherCookie))
              .status,
            404,
          );
          assert.equal(
            (await request("/steps", otherCookie, decide(proposed.id, true)))
              .status,
            404,
          );
          const declined = await propose(3);
          await stream(decide(declined.id, false));
          assert.equal(await concurrency(), 2);
        },
      );
      await t.test(
        "a permitted read recipe cannot inspect another workspace's resource",
        async () => {
          provider.reply({
            name: "towbar_server_inspect",
            input: { serverId: foreignServerId },
          });
          const turn = await stream({
            type: "user_message",
            text: "Inspect this server.",
          });
          assert(
            turn.events.some(
              (event) => event.type === "tool_result" && event.isError === true,
            ),
            JSON.stringify(turn.events),
          );
          assert.equal(
            JSON.stringify(turn.events).includes("192.0.2.11"),
            false,
          );
        },
      );
      await t.test(
        "a changed role and expired session cannot approve earlier actions",
        async () => {
          const proposed = await propose(4);
          await db
            .update(workspaceMembers)
            .set({ role: "viewer" })
            .where(eq(workspaceMembers.userId, userId));
          const denied = await stream(decide(proposed.id, true));
          assert(
            denied.events.some(
              (event) => event.type === "tool_result" && event.isError === true,
            ),
            JSON.stringify(denied.events),
          );
          assert.equal(await concurrency(), 2);
          await db.delete(sessions).where(eq(sessions.userId, userId));
          assert.equal(
            (
              await request("/steps", cookie, {
                type: "user_message",
                text: "Try again",
              })
            ).status,
            401,
          );
          assert.equal(await concurrency(), 2);
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await closeAssistant();
      await provider.close();
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(users).where(eq(users.id, otherUserId));
      await closeDatabase();
    }
  },
);
