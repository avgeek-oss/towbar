import { Hono } from "hono";
import type { WorkspaceRole } from "@workspace/towbar-access";
import { normalizeError } from "../../http/error-response.js";
import type { TowbarHonoEnvironment } from "../../http/types.js";
import { upgradeRoutes } from "../../routes/v1/core/upgrades.js";

// The upgrade routes mounted behind a fixed session actor.
export function app(
  role: WorkspaceRole,
  apiKey = false,
  sessionId: string | null = null,
  userId = "00000000-0000-4000-8000-000000000001",
) {
  const app = new Hono<TowbarHonoEnvironment>();
  app.use("*", async (context, next) => {
    context.set("actor", {
      kind: "session",
      role,
      userId,
      workspaceId: "00000000-0000-4000-8000-000000000002",
    });
    context.set("currentSessionId", sessionId);
    if (apiKey) context.set("apiKey", { id: "key", access: "edit" });
    await next();
  });
  app.onError((error, context) => {
    const result = normalizeError(error);
    return context.json(result, result.status);
  });
  app.route("/", upgradeRoutes);
  return app;
}
