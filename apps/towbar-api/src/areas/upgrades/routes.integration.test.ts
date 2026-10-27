import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions, users } from "@workspace/towbar-database/schema";
import { app } from "./routes-test-app.js";

void test(
  "stale Admin sessions cannot prepare or start; fresh sessions validate targets before the host call",
  { skip: !process.env.TOWBAR_TEST_DATABASE_URL },
  async () => {
    const databaseUrl = process.env.TOWBAR_TEST_DATABASE_URL!;
    assert(new URL(databaseUrl).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = databaseUrl;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const database = getTowbarDatabase();
    const userId = randomUUID();
    const sessionId = randomUUID();
    try {
      await database.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Upgrade test",
      });
      await database.insert(sessions).values({
        id: sessionId,
        userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3600000),
        authenticatedAt: new Date(0),
      });
      const application = app("admin", false, sessionId, userId);
      for (const path of ["/plan", "/jobs"]) {
        const response = await application.request(path, {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        });
        assert.equal(response.status, 403);
        assert.equal(
          ((await response.json()) as { code: string }).code,
          "REAUTHENTICATION_REQUIRED",
        );
      }
      await database
        .update(sessions)
        .set({ authenticatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
      for (const targetVersion of ["latest", "v2.0.17-rc.1", "v2.0.17; id"]) {
        const response = await application.request("/plan", {
          method: "POST",
          body: JSON.stringify({ targetVersion }),
          headers: { "content-type": "application/json" },
        });
        assert.equal(response.status, 400);
      }
      const response = await application.request("/plan", {
        method: "POST",
        body: JSON.stringify({ targetVersion: "v2.0.17" }),
        headers: { "content-type": "application/json" },
      });
      assert.equal(response.status, 409);
    } finally {
      await database.delete(users).where(eq(users.id, userId));
      await closeDatabase();
    }
  },
);
