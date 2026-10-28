import { agentRoutes } from "@avgeek-oss/agent-core/hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type AssistantPrincipal,
  assistantProvider,
  configuredAssistant,
} from "../../areas/assistant/service.js";
import { externalRateLimit } from "../../http/api-authentication.js";
import {
  requireAuthenticatedUser,
  requireTrustedMutationOrigin,
} from "../../http/authentication.js";
import { unauthorized } from "../../http/errors.js";
import type { TowbarHonoEnvironment } from "../../http/types.js";

export function assistantRoutes(
  dispatch: (request: Request) => Promise<Response>,
) {
  const routes = new Hono<TowbarHonoEnvironment>();
  routes.use(
    "*",
    requireTrustedMutationOrigin,
    requireAuthenticatedUser,
    externalRateLimit,
    bodyLimit({ maxSize: 1_000_000 }),
  );
  routes.use("*", async (c, next) => {
    if (c.req.header("authorization"))
      throw unauthorized("Sign in to use the assistant");
    c.header("Cache-Control", "no-store, no-transform");
    await next();
  });
  routes.get("/status", (c) => c.json({ enabled: !!assistantProvider() }));
  routes.use("*", async (c) => {
    const agent = configuredAssistant(dispatch);
    if (!agent) return c.notFound();
    const user = c.get("user");
    if (!user.id) throw unauthorized("Sign in to continue");
    const principal: AssistantPrincipal = {
      id: `${user.id}:${user.workspaceId}`,
      userId: user.id,
      workspaceId: user.workspaceId,
      request: c.req.raw,
    };
    const response = await agentRoutes<
      AssistantPrincipal,
      TowbarHonoEnvironment
    >({ agent, principal: () => principal }).fetch(
      new Request(c.req.raw.url.replace(/\/v1\/agent(?=\/)/, ""), {
        method: c.req.method,
        headers: c.req.raw.headers,
        signal: c.req.raw.signal,
        body: ["GET", "HEAD"].includes(c.req.method)
          ? undefined
          : await c.req.arrayBuffer(),
      }),
    );
    return c.newResponse(response.body, response);
  });
  return routes;
}
