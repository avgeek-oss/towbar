import { z } from "zod";
import { Hono } from "hono";

import { getNotificationProviderState } from "../../../areas/notifications/configuration.js";
import {
  listNotificationCenter,
  markAllNotificationsRead,
  notificationCenterQuery,
} from "../../../areas/notifications/center.js";
import { unauthorized } from "../../../http/errors.js";
import { operation } from "../../../http/operation.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const notificationCenterRoutes = new Hono<TowbarHonoEnvironment>();

notificationCenterRoutes.get(
  "/providers",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notification-center.ts:get:"/providers"',
    summary: "Get environment-configured notification providers",
    response: "Configured providers without environment values or secrets.",
    status: 200,
  }),
  async (context) => {
    context.header("Cache-Control", "no-store");
    return context.json(
      await getNotificationProviderState(context.get("user").workspaceId),
    );
  },
);

notificationCenterRoutes.get(
  "/",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    responseSchema: 'notification-center.ts:get:"/"',
    summary: "List unread and recently read notifications",
    query: notificationCenterQuery,
    response: "JSON object containing notifications.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    if (!user.id) throw unauthorized();
    context.header("Cache-Control", "no-store");
    return context.json(
      await listNotificationCenter(
        { workspaceId: user.workspaceId, userId: user.id },
        notificationCenterQuery.parse(context.req.query()),
      ),
    );
  },
);

notificationCenterRoutes.post(
  "/read-all",
  operation({
    permissions: ["viewer"],
    browserOnly: true,
    responseSchema: 'notification-center.ts:post:"/read-all"',
    summary: "Mark all notifications as read for the signed-in user",
    body: z.object({}).strict(),
    response: "Read receipts saved without deleting notification history.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    if (!user.id) throw unauthorized();
    context.header("Cache-Control", "no-store");
    z.object({})
      .strict()
      .parse(await context.req.json());
    return context.json(
      await markAllNotificationsRead({
        workspaceId: user.workspaceId,
        userId: user.id,
      }),
    );
  },
);
