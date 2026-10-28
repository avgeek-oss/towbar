import { Hono } from "hono";
import { createKeySchema } from "../../../areas/api-keys/create-key-contract.js";
import { z } from "zod";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../../../areas/api-keys/service.js";
import { requireRecentAuthentication } from "../../../areas/auth/recent-authentication.js";
import { getEnv } from "../../../env.js";
import { requireHttpsExternalAccess } from "../../../http/external-access.js";
import { operation } from "../../../http/operation.js";
import { readJson, readUuidPathParameter } from "../../../http/requests.js";
import { sessionUser } from "../../../http/session-user.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";
export const apiKeyRoutes = new Hono<TowbarHonoEnvironment>();
apiKeyRoutes.use("*", requireHttpsExternalAccess);
apiKeyRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
apiKeyRoutes.get(
  "/personal",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    summary: "List personal API keys",
    responseSchema: 'api-keys.ts:get:"/personal"',
    response: "Personal keys, API and MCP URLs, and rate limits.",
  }),
  async (c) => {
    const env = getEnv();
    return c.json({
      keys: await listApiKeys(sessionUser(c)),
      apiUrl: `${env.TOWBAR_API_BASE_URL}/v1/api`,
      mcpUrl: `${env.TOWBAR_API_BASE_URL}/v1/mcp`,
      rateLimit: {
        requests: env.TOWBAR_API_RATE_LIMIT_MAX,
        windowSeconds: env.TOWBAR_API_RATE_LIMIT_WINDOW_SECONDS,
      },
    });
  },
);
apiKeyRoutes.post(
  "/personal",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    summary: "Create personal API key",
    idempotencyKey: true,
    responseSchema: 'api-keys.ts:post:"/personal"',
    body: createKeySchema,
    response: "Key metadata and one-time token.",
    status: 201,
  }),
  async (c) => {
    const input = await readJson(c, createKeySchema);
    const user = sessionUser(c);
    if (input.includeAdmin)
      await requireRecentAuthentication(user.id, c.get("currentSessionId"));
    return c.json(
      await createApiKey(user, {
        ...input,
        scope: "personal",
        requestId: z.uuid().parse(c.req.header("Idempotency-Key")),
      }),
      201,
    );
  },
);
apiKeyRoutes.delete(
  "/personal/:keyId",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    summary: "Revoke personal API key",
    responseSchema: 'api-keys.ts:delete:"/personal/:keyId"',
    response: "No response body.",
    status: 204,
  }),
  async (c) => {
    await revokeApiKey(
      sessionUser(c),
      readUuidPathParameter(c.req.param("keyId"), "keyId"),
    );
    return c.body(null, 204);
  },
);
apiKeyRoutes.get(
  "/team",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    summary: "List team API keys",
    responseSchema: 'api-keys.ts:get:"/team"',
    response: "Team API keys.",
  }),
  async (c) => c.json({ keys: await listApiKeys(sessionUser(c), "team") }),
);
apiKeyRoutes.post(
  "/team",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    freshSession: true,
    summary: "Create team API key",
    idempotencyKey: true,
    responseSchema: 'api-keys.ts:post:"/team"',
    body: createKeySchema,
    response: "Key metadata and one-time token.",
    status: 201,
  }),
  async (c) =>
    c.json(
      await createApiKey(sessionUser(c), {
        ...(await readJson(c, createKeySchema)),
        scope: "team",
        requestId: z.uuid().parse(c.req.header("Idempotency-Key")),
      }),
      201,
    ),
);
apiKeyRoutes.delete(
  "/team/:keyId",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    freshSession: true,
    summary: "Revoke team API key",
    responseSchema: 'api-keys.ts:delete:"/team/:keyId"',
    response: "No response body.",
    status: 204,
  }),
  async (c) => {
    await revokeApiKey(
      sessionUser(c),
      readUuidPathParameter(c.req.param("keyId"), "keyId"),
      "team",
    );
    return c.body(null, 204);
  },
);
