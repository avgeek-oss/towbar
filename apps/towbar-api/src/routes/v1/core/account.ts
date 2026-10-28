import {
  cancelEmailChange,
  pendingEmailChange,
  requestEmailChange,
} from "../../../areas/auth/email-change.js";
import { regenerateRecoveryCodes } from "../../../areas/auth/recovery-codes.js";
import { requireRecentAuthentication } from "../../../areas/auth/recent-authentication.js";
import { sessionUser } from "../../../http/session-user.js";
import { operation } from "../../../http/operation.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  changePassword,
  listUserSessions,
  revokeUserSession,
  updateProfile,
} from "../../../areas/auth/service.js";
import { readJson } from "../../../http/requests.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

const profileSchema = z
  .object({ displayName: z.string().trim().min(1).max(120) })
  .strict();
const passwordSchema = z
  .object({
    currentPassword: z.string().max(1_024).optional(),
    confirmPassword: z.string().min(15).max(1_024),
    newPassword: z.string().min(15).max(1_024),
  })
  .refine((input) => input.newPassword === input.confirmPassword, {
    message: "New passwords do not match",
    path: ["confirmPassword"],
  })
  .strict();
export const accountRoutes = new Hono<TowbarHonoEnvironment>();

accountRoutes.get(
  "/sessions",
  operation({
    permissions: ["viewer"],
    responseSchema: 'account.ts:get:"/sessions"',
    summary: "List user sessions",
    browserOnly: true,
    response: "JSON object containing currentSessionId, sessions.",
    status: 200,
  }),
  async (context) =>
    context.json({
      currentSessionId: context.get("currentSessionId"),
      sessions: await listUserSessions(sessionUser(context).id),
    }),
);
accountRoutes.delete(
  "/sessions/:sessionId",
  operation({
    permissions: ["viewer"],
    responseSchema: 'account.ts:delete:"/sessions/:sessionId"',
    summary: "Revoke user session",
    browserOnly: true,
    response: "No response body.",
    status: 204,
  }),
  async (context) => {
    const sessionId = context.req.param("sessionId");
    await revokeUserSession({
      currentSessionId: context.get("currentSessionId"),
      sessionId,
      userId: sessionUser(context).id,
    });
    return context.body(null, 204);
  },
);
accountRoutes.get(
  "/profile",
  operation({
    permissions: ["viewer"],
    responseSchema: 'account.ts:get:"/profile"',
    summary: "Get current profile",
    browserOnly: true,
    response: "JSON object containing user.",
    status: 200,
  }),
  (context) => context.json({ user: sessionUser(context) }),
);
accountRoutes.patch(
  "/profile",
  operation({
    permissions: ["viewer"],
    responseSchema: 'account.ts:patch:"/profile"',
    summary: "Update profile",
    browserOnly: true,
    body: profileSchema,
    response: "JSON object containing user.",
    status: 200,
  }),
  async (context) => {
    const body = await readJson(context, profileSchema);
    const currentUser = sessionUser(context);
    const updatedUser = await updateProfile({
      displayName: body.displayName,
      userId: currentUser.id,
    });
    return context.json({
      user: {
        ...updatedUser,
        workspaceId: currentUser.workspaceId,
        workspaceRole: currentUser.workspaceRole,
      },
    });
  },
);
accountRoutes.put(
  "/profile/password",
  operation({
    permissions: ["viewer"],
    responseSchema: 'account.ts:put:"/profile/password"',
    summary: "Change password",
    browserOnly: true,
    body: passwordSchema,
    response: "No response body.",
    status: 204,
  }),
  async (context) => {
    const body = await readJson(context, passwordSchema);
    const headers = await changePassword({
      headers: context.req.raw.headers,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      userId: sessionUser(context).id,
    });
    for (const cookie of headers.getSetCookie())
      context.header("Set-Cookie", cookie, { append: true });
    return context.body(null, 204);
  },
);

accountRoutes.get(
  "/identity",
  operation({
    permissions: ["viewer"],
    summary: "Get current actor and team",
    responseSchema: 'account.ts:get:"/identity"',
    response: "Actor kind, team ID, and effective permissions.",
  }),
  (context) =>
    context.json({
      actor: context.get("actor").kind,
      workspaceId: context.get("user").workspaceId,
      capabilities: context.get("user").capabilities ?? [],
    }),
);

const emailChangeSchema = z.object({ email: z.email().max(320) }).strict();
accountRoutes.get(
  "/profile/email-change",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    summary: "Get pending email change",
    responseSchema: 'account.ts:get:"/profile/email-change"',
    response: "Pending email and expiry.",
  }),
  async (c) => c.json({ pending: await pendingEmailChange(sessionUser(c).id) }),
);
accountRoutes.post(
  "/profile/email-change",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    summary: "Request email change",
    responseSchema: 'account.ts:post:"/profile/email-change"',
    response: "Pending email and expiry.",
    body: emailChangeSchema,
  }),
  async (c) => {
    await requireRecentAuthentication(
      sessionUser(c).id,
      c.get("currentSessionId"),
    );
    return c.json(
      await requestEmailChange(
        sessionUser(c),
        (await readJson(c, emailChangeSchema)).email,
      ),
    );
  },
);
accountRoutes.delete(
  "/profile/email-change",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    summary: "Cancel email change",
    responseSchema: 'account.ts:delete:"/profile/email-change"',
    response: "No response body.",
    status: 204,
  }),
  async (c) => {
    await cancelEmailChange(sessionUser(c).id);
    return c.body(null, 204);
  },
);
accountRoutes.post(
  "/profile/passkeys/recovery-codes",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    summary: "Replace passkey recovery codes",
    responseSchema: 'account.ts:post:"/profile/passkeys/recovery-codes"',
    response: "New one-use recovery codes. Previous codes stop working.",
    body: z.object({}).strict(),
  }),
  async (c) => {
    await readJson(c, z.object({}).strict());
    await requireRecentAuthentication(
      sessionUser(c).id,
      c.get("currentSessionId"),
    );
    c.header("Cache-Control", "no-store");
    return c.json(await regenerateRecoveryCodes(sessionUser(c).id));
  },
);
