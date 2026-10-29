import { Hono } from "hono";
import { z } from "zod";

import {
  deliveriesQuery,
  listNotificationDeliveries,
} from "../../../areas/event-history/deliveries.js";
import { listNotificationDestinations } from "../../../areas/notifications/service.js";
import { notificationProviderAvailability } from "../../../areas/notifications/configuration.js";
import { operation } from "../../../http/operation.js";
import { readJson } from "../../../http/requests.js";
import {
  emailDestinationsSchema,
  listEmailDestinations,
  saveEmailDestinations,
} from "../../../areas/notifications/email-destinations.js";
import { sendTestEmailDestination } from "../../../areas/notifications/email-test.js";
import { sendTestSlackDestination } from "../../../areas/notifications/slack-test.js";
import {
  listWebhookDestinations,
  saveWebhookDestinations,
  webhookDestinationsSchema,
} from "../../../areas/notifications/webhook-destinations.js";
import { sendTestWebhookDestination } from "../../../areas/notifications/webhook-test.js";
import {
  listSlackDestinations,
  saveSlackDestinations,
  slackDestinationsSchema,
} from "../../../areas/notifications/slack-destinations.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const notificationRoutes = new Hono<TowbarHonoEnvironment>();

notificationRoutes.get(
  "/webhook/destinations",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:get:"/webhook/destinations"',
    summary: "List webhook push destinations",
    response:
      "Runtime-configured webhook endpoints and workspace subscriptions.",
    status: 200,
  }),
  async (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({
      destinations: await listWebhookDestinations(
        context.get("user").workspaceId,
      ),
    });
  },
);

notificationRoutes.put(
  "/webhook/destinations",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:put:"/webhook/destinations"',
    body: webhookDestinationsSchema,
    summary: "Save webhook push subscriptions",
    response: "Updated subscriptions for webhook endpoints.",
    status: 200,
  }),
  async (context) => {
    const body = await readJson(context, webhookDestinationsSchema);
    context.header("Cache-Control", "no-store");
    return context.json({
      destinations: await saveWebhookDestinations(
        context.get("user").workspaceId,
        body.destinations,
      ),
    });
  },
);

const testWebhookDestinationSchema = z
  .object({ routeId: z.string().min(1).max(255) })
  .strict();

notificationRoutes.post(
  "/webhook/destinations/test",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:post:"/webhook/destinations/test"',
    body: testWebhookDestinationSchema,
    summary: "Send a test webhook push notification",
    response: "The endpoint accepted a sample notification.",
    status: 200,
  }),
  async (context) => {
    const body = await readJson(context, testWebhookDestinationSchema);
    return context.json(await sendTestWebhookDestination(body.routeId));
  },
);

notificationRoutes.get(
  "/slack/destinations",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:get:"/slack/destinations"',
    summary: "List Slack notification destinations",
    response: "Workspace Slack channels and event subscriptions.",
    status: 200,
  }),
  async (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({
      destinations: await listSlackDestinations(
        context.get("user").workspaceId,
      ),
    });
  },
);

notificationRoutes.put(
  "/slack/destinations",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:put:"/slack/destinations"',
    body: slackDestinationsSchema,
    summary: "Save Slack notification destinations",
    response: "Updated workspace Slack channels and event subscriptions.",
    status: 200,
  }),
  async (context) => {
    const body = await readJson(context, slackDestinationsSchema);
    context.header("Cache-Control", "no-store");
    return context.json({
      destinations: await saveSlackDestinations(
        context.get("user").workspaceId,
        body.destinations,
      ),
    });
  },
);

const testSlackDestinationSchema = z
  .object({ channelId: z.string().regex(/^[A-Z][A-Z0-9]{1,79}$/) })
  .strict();

notificationRoutes.post(
  "/slack/destinations/test",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:post:"/slack/destinations/test"',
    body: testSlackDestinationSchema,
    summary: "Send a test Slack notification",
    response: "Slack accepted a sample notification for the selected channel.",
    status: 200,
  }),
  async (context) => {
    const body = await readJson(context, testSlackDestinationSchema);
    return context.json(
      await sendTestSlackDestination(
        context.get("user").workspaceId,
        body.channelId,
      ),
    );
  },
);

notificationRoutes.get(
  "/email/destinations",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:get:"/email/destinations"',
    summary: "List email notification destinations",
    response: "Workspace email recipients and event subscriptions.",
    status: 200,
  }),
  async (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({
      destinations: await listEmailDestinations(
        context.get("user").workspaceId,
      ),
    });
  },
);

notificationRoutes.put(
  "/email/destinations",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:put:"/email/destinations"',
    body: emailDestinationsSchema,
    summary: "Save email notification destinations",
    response: "Updated workspace email recipients and event subscriptions.",
    status: 200,
  }),
  async (context) => {
    const body = await readJson(context, emailDestinationsSchema);
    context.header("Cache-Control", "no-store");
    return context.json({
      destinations: await saveEmailDestinations(
        context.get("user").workspaceId,
        body.destinations,
      ),
    });
  },
);

const testEmailDestinationSchema = z
  .object({ email: z.string().trim().email().max(320) })
  .strict();

notificationRoutes.post(
  "/email/destinations/test",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:post:"/email/destinations/test"',
    body: testEmailDestinationSchema,
    summary: "Send a test email notification",
    response:
      "The SMTP provider accepted a sample notification for the selected email destination.",
    status: 200,
  }),
  async (context) => {
    const body = await readJson(context, testEmailDestinationSchema);
    return context.json(
      await sendTestEmailDestination(
        context.get("user").workspaceId,
        body.email,
      ),
    );
  },
);

notificationRoutes.get(
  "/destinations",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'notifications.ts:get:"/destinations"',
    summary: "List environment-configured notification routes",
    response: "Configured routes and provider availability without secrets.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json({
      canManageNotifications: false,
      destinations: await listNotificationDestinations({
        sourceId: context.req.param("sourceId"),
        serverId: context.req.param("serverId"),
        workspaceId: user.workspaceId,
      }),
      providers: await notificationProviderAvailability(user.workspaceId),
    });
  },
);

notificationRoutes.get(
  "/deliveries",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    query: deliveriesQuery,
    summary: "List notification deliveries",
    responseSchema: 'notifications.ts:get:"/deliveries"',
    response: "Paginated notification deliveries and delivery state.",
  }),
  async (context) => {
    context.header("Cache-Control", "no-store");
    return context.json(
      await listNotificationDeliveries({
        ...deliveriesQuery.parse(context.req.query()),
        workspaceId: context.get("user").workspaceId,
      }),
    );
  },
);
