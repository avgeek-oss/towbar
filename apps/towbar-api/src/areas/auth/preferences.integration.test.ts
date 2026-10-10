import { installationSetupSecret } from "./setup-secret.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { z } from "zod";
import { Hono } from "hono";
import type { TowbarHonoEnvironment } from "../../http/types.js";
import { eq } from "drizzle-orm";
import {
  authPasskeys,
  servers,
  users,
} from "@workspace/towbar-database/schema";
import {
  dateTimeLocalizationSchema,
  dateTimePreferencesSchema,
  defaultDateTimePreferences,
} from "@workspace/towbar-core/date-time";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
const preferencesReply = z.object({
  preferences: dateTimePreferencesSchema,
  options: z.object({ timeZones: z.array(z.string()) }),
});
const localizedReply = z.object({ localization: dateTimeLocalizationSchema });
void test(
  "saved preferences govern browser, personal-key, and MCP labels while team keys stay in UTC",
  { skip: !url },
  async () => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} });
    const databaseName = `towbar_preferences_${randomUUID().replaceAll("-", "")}_test`;
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const isolated = new URL(url);
    isolated.pathname = `/${databaseName}`;
    process.env.DATABASE_TOWBAR_URL = isolated.href;
    process.env.TOWBAR_PASSWORD_BREACH_CHECK = "false";
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    process.env.TOWBAR_APP_BASE_URL = "https://app.towbar.test";
    process.env.TOWBAR_API_BASE_URL = "https://api.towbar.test";
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl: isolated.href,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { createInitialAdmin, getUserIdentity } =
      await import("./service.js");
    const { createApiKey, resolveApiKeyPrincipal } =
      await import("../api-keys/service.js");
    const { streamStillAuthorized } =
      await import("../../http/stream-authorization.js");
    const { requestDateTimePreferences } =
      await import("../../http/localization.js");
    const { seedApiServers } =
      await import("../external-api/environment-test-helper.js");
    const { issueTestMcpToken } =
      await import("../mcp-oauth/token-test-helper.js");
    const { connectTestMcpClient } =
      await import("../external-api/scout-access-test-helper.js");
    const { createApp } = await import("../../app.js");
    const db = getTowbarDatabase();
    const app = createApp();
    try {
      for (const setupSecret of [undefined, "", "wrong-installation-secret"]) {
        const response = await app.request("/v1/public/auth/setup", {
          method: "POST",
          headers: {
            origin: "https://app.towbar.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            setupSecret,
            teamName: "Test team",
            displayName: "Admin",
            email: "admin@example.test",
            password: "A secure setup passphrase 2026!",
            confirmPassword: "A secure setup passphrase 2026!",
            dateTimePreferences: defaultDateTimePreferences,
          }),
        });
        assert.equal(response.status, setupSecret ? 403 : 400);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal((await db.select().from(users)).length, 0);
      }
      const login = await createInitialAdmin({
        setupSecret: installationSetupSecret(),
        teamName: "Time preferences",
        displayName: "Test admin",
        email: "date-time@example.test",
        password: randomBytes(24).toString("base64url"),
      });
      assert.equal(login.status, 200);
      const cookies = login.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const signedIn = (await login.json()) as { user: { id: string } };
      const user = await getUserIdentity(signedIn.user.id);
      assert(user);
      const otherId = randomUUID();
      await db.insert(users).values({
        id: otherId,
        email: "other-date-time@example.test",
        displayName: "Other user",
      });
      const browser = (path: string, method = "GET", body?: unknown) =>
        app.request(`/v1/core${path}`, {
          method,
          headers: {
            cookie: cookies,
            origin: "https://app.towbar.test",
            "content-type": "application/json",
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      const defaults = await browser("/profile/preferences");
      assert.equal(defaults.status, 200, await defaults.clone().text());
      const initial = preferencesReply.parse(await defaults.json());
      assert.deepEqual(initial.preferences, defaultDateTimePreferences);
      assert(initial.options.timeZones.includes("Asia/Kolkata"));
      const preferences = {
        dateFormat: "year-month-day",
        timeFormat: "12-hour-seconds",
        timeZone: "Asia/Kolkata",
      };
      const saved = await browser("/profile/preferences", "PUT", preferences);
      assert.equal(saved.status, 200, await saved.clone().text());
      assert.deepEqual(
        preferencesReply.parse(
          await (await browser("/profile/preferences")).json(),
        ).preferences,
        preferences,
      );
      for (const input of [
        { ...preferences, timeZone: "Invalid/Zone" },
        { ...preferences, dateFormat: "custom" },
        { ...preferences, userId: otherId },
      ])
        assert.equal(
          (await browser("/profile/preferences", "PUT", input)).status,
          400,
        );
      assert.equal(
        (await app.request("/v1/core/profile/preferences")).status,
        401,
      );
      assert.equal(
        (
          await app.request("/v1/core/profile/preferences", {
            method: "PUT",
            headers: {
              cookie: cookies,
              origin: "https://other.test",
              "content-type": "application/json",
            },
            body: JSON.stringify(preferences),
          })
        ).status,
        403,
      );
      const [other] = await db
        .select({ preferences: users.dateTimePreferences })
        .from(users)
        .where(eq(users.id, otherId));
      assert.deepEqual(other!.preferences, defaultDateTimePreferences);

      const timestamp = "2026-09-16T23:30:45.000Z";
      const serverId = randomUUID();
      await seedApiServers([
        { id: serverId, workspaceId: user.workspaceId, ip: "192.0.2.90" },
      ]);
      await db
        .update(servers)
        .set({ createdAt: new Date(timestamp), updatedAt: new Date(timestamp) })
        .where(eq(servers.id, serverId));
      await db.insert(authPasskeys).values(
        [user.id, otherId].map((userId) => ({
          userId,
          name: userId === user.id ? "My passkey" : "Other passkey",
          publicKey: "test",
          credentialID: randomUUID(),
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
          createdAt: new Date(timestamp),
        })),
      );
      const passkeys = localizedReply
        .extend({ passkeys: z.array(z.object({ name: z.string() })) })
        .parse(await (await browser("/profile/passkeys")).json());
      assert.equal(passkeys.passkeys.length, 1);
      assert.equal(passkeys.passkeys[0]?.name, "My passkey");
      assert.equal(
        passkeys.localization.timestamps[timestamp]?.dateTime,
        "5:00:45 AM, 2026-09-17",
      );

      const personal = await createApiKey(user, {
        name: "Personal dates",
        scope: "personal",
        access: "read",
      });
      const team = await createApiKey(user, {
        name: "Team dates",
        scope: "team",
        access: "read",
      });
      assert(personal.token && team.token);
      const streamPrincipal = await resolveApiKeyPrincipal(personal.key.id);
      assert(streamPrincipal);
      const request = (token: string, path = `/servers/${serverId}`) =>
        app.request(`/v1/api${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
      for (const [token, expected, timeZone] of [
        [personal.token, "5:00:45 AM, 2026-09-17", "Asia/Kolkata"],
        [team.token, "23:30, 16 Sept 2026", "UTC"],
      ] as const) {
        const response = await request(token);
        assert.equal(response.status, 200, await response.clone().text());
        const payload = localizedReply
          .extend({ server: z.object({ createdAt: z.string() }) })
          .parse(await response.json());
        assert.equal(payload.server.createdAt, timestamp);
        const localization = dateTimeLocalizationSchema.parse(
          payload.localization,
        );
        assert.equal(localization.timeZone, timeZone);
        assert.equal(localization.timestamps[timestamp]?.dateTime, expected);
        assert.match(response.headers.get("cache-control") ?? "", /no-store/);
        assert.equal(
          (await request(token, "/profile/preferences")).status,
          404,
        );
      }
      const oauth = await issueTestMcpToken(user, "read");
      const mcp = await connectTestMcpClient(oauth.token, (request) =>
        app.fetch(request),
      );
      try {
        const tools = await mcp.listTools();
        assert.match(
          JSON.stringify(
            tools.tools.find((tool) => tool.name === "towbar_server_inspect")
              ?.outputSchema,
          ),
          /localization/,
        );
        const result = await mcp.callTool({
          name: "towbar_server_inspect",
          arguments: { serverId },
        });
        assert.equal(result.isError, false, JSON.stringify(result.content));
        const structured = result.structuredContent as {
          result: { localization: unknown };
        };
        assert.equal(
          dateTimeLocalizationSchema.parse(structured.result.localization)
            .timestamps[timestamp]?.dateTime,
          "5:00:45 AM, 2026-09-17",
        );
      } finally {
        await mcp.close();
      }

      assert.equal(
        (
          await browser("/profile/preferences", "PUT", {
            ...preferences,
            timeZone: "America/New_York",
          })
        ).status,
        200,
      );
      assert.equal(
        localizedReply.parse(await (await request(personal.token)).json())
          .localization.timestamps[timestamp]?.dateTime,
        "7:30:45 PM, 2026-09-16",
      );
      assert.equal(
        localizedReply.parse(await (await request(team.token)).json())
          .localization.timeZone,
        "UTC",
      );
      const streamProbe = new Hono<TowbarHonoEnvironment>();
      streamProbe.get("/:kind", async (context) => {
        context.set("user", streamPrincipal.user);
        context.set("actor", streamPrincipal.actor);
        if (context.req.param("kind") === "key")
          context.set("apiKey", streamPrincipal.key);
        const allowed = await streamStillAuthorized(context, [
          "deployment.read",
        ]);
        return context.json({
          allowed,
          preferences: requestDateTimePreferences(context),
        });
      });
      for (const kind of ["key", "session"]) {
        const refreshed = z
          .object({
            allowed: z.boolean(),
            preferences: dateTimePreferencesSchema,
          })
          .parse(
            await (
              await streamProbe.request(`/${kind}`, {
                headers: { cookie: cookies },
              })
            ).json(),
          );
        assert.equal(refreshed.allowed, true);
        assert.equal(refreshed.preferences.timeZone, "America/New_York");
      }
    } finally {
      await closeDatabase();
      await admin.unsafe(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    }
  },
);
