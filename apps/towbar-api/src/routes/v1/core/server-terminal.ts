import { Hono } from "hono";
import { issueTerminalTicket } from "../../../areas/servers/terminal.js";
import { operation } from "../../../http/operation.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";
import { forbidden } from "../../../http/errors.js";

export const serverTerminalRoutes = new Hono<TowbarHonoEnvironment>();
serverTerminalRoutes.post(
  "/:serverId/terminal",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    freshSession: true,
    summary: "Open a server terminal",
    responseSchema: 'server-terminal.ts:post:"/:serverId/terminal"',
    response: "One-use browser terminal connection ticket.",
  }),
  async (context) => {
    context.header("Cache-Control", "no-store");
    const user = context.get("user");
    const sessionId = context.get("currentSessionId");
    if (!user.id || !sessionId) throw forbidden("Sign in to open a terminal");
    return context.json(
      await issueTerminalTicket(user, sessionId, context.req.param("serverId")),
    );
  },
);
