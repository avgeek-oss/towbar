import { z } from "zod";
import { reauthenticate } from "../../../areas/auth/recent-authentication.js";
import { sessionUser } from "../../../http/session-user.js";
import { readJson } from "../../../http/requests.js";
import { operation } from "../../../http/operation.js";
import { Hono } from "hono";
import { getIdentityAuth } from "../../../areas/auth/identity.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";
export const sessionRoutes = new Hono<TowbarHonoEnvironment>();
sessionRoutes.get(
  "/",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    responseSchema: 'session.ts:get:"/"',
    summary: "Read current session",
    response: "Current user and capabilities.",
  }),
  (context) => context.json({ user: context.get("user") }),
);
sessionRoutes.delete(
  "/",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    responseSchema: 'session.ts:delete:"/"',
    summary: "Sign out",
    response: "No response body.",
    status: 204,
  }),
  async (context) => {
    const response = await getIdentityAuth().api.signOut({
      headers: context.req.raw.headers,
      asResponse: true,
    });
    return new Response(null, { status: 204, headers: response.headers });
  },
);

sessionRoutes.post(
  "/reauthenticate",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    responseSchema: 'session.ts:post:"/reauthenticate"',
    summary: "Confirm recent authentication",
    response: "Authentication confirmed.",
    body: z
      .object({
        password: z.string().min(1).max(1024),
      })
      .strict(),
  }),
  async (context) => {
    const user = sessionUser(context);
    const input = await readJson(
      context,
      z
        .object({
          password: z.string().min(1).max(1024),
        })
        .strict(),
    );
    await reauthenticate({
      ...input,
      userId: user.id,
      sessionId: context.get("currentSessionId")!,
      headers: context.req.raw.headers,
    });
    return context.json({ authenticated: true });
  },
);
