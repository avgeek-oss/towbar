import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { isScope } from "@workspace/towbar-access";
import { operation, operationDescription } from "./operation.js";
import { requireDeclaredPolicy } from "./declared-policy.js";
import type { TowbarHonoEnvironment } from "./types.js";

void test("every protected route has explicit valid permissions", async () => {
  process.env.DATABASE_TOWBAR_URL ??=
    "postgres://localhost/towbar_contract_test";
  process.env.TOWBAR_CREDENTIALS_KEY ??= Buffer.alloc(32, 1).toString("base64");
  process.env.TOWBAR_INTERNAL_HMAC_SECRET ??=
    "contract-test-secret-at-least-32-characters";
  const { controlPlaneRoutes } = await import("../routes/v1/core/index.js");
  const { sessionRoutes } = await import("../routes/v1/core/session.js");
  for (const router of [controlPlaneRoutes, sessionRoutes]) {
    const routes = new Map<string, typeof router.routes>();
    for (const route of router.routes) {
      if (route.method === "ALL") continue;
      const key = `${route.method} ${route.path}`;
      routes.set(key, [...(routes.get(key) ?? []), route]);
    }
    for (const [key, handlers] of routes) {
      const policies = handlers.flatMap(
        (route) => operationDescription(route.handler) ?? [],
      );
      assert.equal(policies.length, 1, key);
      assert(policies[0]!.permissions.length > 0, key);
      assert(policies[0]!.permissions.every(isScope), key);
      if (/\/(reveal(?:-all)?|secret|configuration\/secrets)$/.test(key)) {
        assert.equal(policies[0]!.browserOnly, true, key);
        assert.equal(policies[0]!.freshSession, true, key);
      }
    }
  }
});
void test("a newly mounted route with no policy fails closed at runtime", async () => {
  const app = new Hono<TowbarHonoEnvironment>();
  app.use("*", requireDeclaredPolicy);
  app.get("/unprotected", (context) =>
    context.json({ sensitive: "must not be reached" }),
  );
  app.get(
    "/protected",
    operation({
      permissions: ["viewer"],
      responseSchema: "test",
      summary: "test",
      response: "test",
    }),
    (context) => context.json({ ok: true }),
  );
  const response = await app.request("/unprotected");
  assert.equal(response.status, 404);
  assert(
    !(await response
      .text()
      .then((text) => text.includes("must not be reached"))),
  );
});
