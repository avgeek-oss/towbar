import {
  type EmailConnectionInput,
  type NotificationDestinationInput,
  type NotificationProvider,
  type SlackConnectionInput,
  emailConnectionInputSchema,
  notificationDestinationInputSchema,
  slackConnectionInputSchema,
  webhookNotificationConfigSchema,
} from "@workspace/towbar-core";
import { z } from "zod";

type RuntimeNotificationProviderConfiguration =
  | (SlackConnectionInput & { appBaseUrl: string; provider: "slack" })
  | (EmailConnectionInput & { provider: "smtp"; subjectPrefix: "Towbar" })
  | { provider: "webhook" };

type RuntimeNotificationRoute = NotificationDestinationInput & {
  id: string;
};

type RuntimeNotifications = {
  providers: Partial<
    Record<NotificationProvider, RuntimeNotificationProviderConfiguration>
  >;
  routes: RuntimeNotificationRoute[];
};

const routeSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      .max(64),
  })
  .and(notificationDestinationInputSchema);

const runtimeNotificationsSchema = z
  .object({
    providers: z
      .object({
        slack: slackConnectionInputSchema.optional(),
        smtp: emailConnectionInputSchema.optional(),
        webhook: z
          .array(
            webhookNotificationConfigSchema.extend({
              id: z
                .string()
                .trim()
                .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
                .max(56),
              label: z.string().trim().min(1).max(100),
              signingSecret: z.string().min(32).max(512),
            }),
          )
          .max(100)
          .refine(
            (endpoints) =>
              new Set(endpoints.map((endpoint) => endpoint.id)).size ===
              endpoints.length,
            "Configure each webhook endpoint ID only once",
          )
          .optional(),
      })
      .strict(),
    routes: z.array(routeSchema).max(100).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, route] of value.routes.entries()) {
      if (ids.has(route.id))
        context.addIssue({
          code: "custom",
          message: "Notification route identifiers must be unique",
          path: ["routes", index, "id"],
        });
      ids.add(route.id);
      if (route.provider !== "webhook" && !value.providers[route.provider])
        context.addIssue({
          code: "custom",
          message: `The ${route.provider} provider is required by this route`,
          path: ["routes", index, "provider"],
        });
    }
    for (const [index, endpoint] of (value.providers.webhook ?? []).entries()) {
      const id = `webhook-${endpoint.id}`;
      if (ids.has(id))
        context.addIssue({
          code: "custom",
          message: "Notification route identifiers must be unique",
          path: ["providers", "webhook", index, "id"],
        });
      ids.add(id);
    }
  });

let cached: RuntimeNotifications | undefined;

function hasWebhookRoutes(value: z.infer<typeof runtimeNotificationsSchema>) {
  return (
    (value.providers.webhook?.length ?? 0) > 0 ||
    value.routes.some((route) => route.provider === "webhook")
  );
}

export function getRuntimeNotifications(
  environment: Record<string, string | undefined> = process.env,
): RuntimeNotifications {
  if (environment === process.env && cached) return cached;
  const enabled = environment.TOWBAR_NOTIFICATIONS_ENABLED?.trim();
  if (!enabled || enabled === "false") return { providers: {}, routes: [] };
  if (enabled !== "true")
    throw new Error("TOWBAR_NOTIFICATIONS_ENABLED must be true or false");
  const raw = environment.TOWBAR_NOTIFICATION_CONFIG_JSON?.trim();
  if (!raw)
    throw new Error(
      "TOWBAR_NOTIFICATION_CONFIG_JSON is required when TOWBAR_NOTIFICATIONS_ENABLED=true",
    );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("TOWBAR_NOTIFICATION_CONFIG_JSON must contain valid JSON", {
      cause: error,
    });
  }
  normalizePreviewRouteCategories(value);
  const parsed = runtimeNotificationsSchema.parse(value);
  const providers: RuntimeNotifications["providers"] = {
    webhook: hasWebhookRoutes(parsed) ? { provider: "webhook" } : undefined,
    slack: parsed.providers.slack
      ? {
          ...parsed.providers.slack,
          appBaseUrl:
            environment.TOWBAR_APP_BASE_URL ?? "http://localhost:4021",
          provider: "slack",
        }
      : undefined,
    smtp: parsed.providers.smtp
      ? {
          ...parsed.providers.smtp,
          provider: "smtp",
          subjectPrefix: "Towbar",
        }
      : undefined,
  };
  const result = {
    providers,
    routes: [
      ...parsed.routes.filter((route) => route.enabled),
      ...(parsed.providers.webhook ?? []).map((endpoint) => ({
        id: `webhook-${endpoint.id}`,
        provider: "webhook" as const,
        enabled: true,
        categories: [],
        config: {
          url: endpoint.url,
          headers: endpoint.headers,
          signingSecret: endpoint.signingSecret,
          label: endpoint.label,
        },
      })),
    ],
  };
  if (environment === process.env) cached = result;
  return result;
}

function normalizePreviewRouteCategories(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "routes" in value &&
    Array.isArray(value.routes)
  ) {
    for (const route of value.routes) {
      if (
        route &&
        typeof route === "object" &&
        "categories" in route &&
        Array.isArray(route.categories)
      ) {
        const categories = new Set(
          route.categories.map((category: unknown) =>
            category === "previews" ? "deployments" : category,
          ),
        );
        if (categories.has("health") || categories.has("scout")) {
          categories.add("health");
          categories.add("scout");
        }
        route.categories = [...categories];
      }
    }
  }
}

export function getRuntimeNotificationRoute(id: string) {
  return (
    getRuntimeNotifications().routes.find((route) => route.id === id) ?? null
  );
}

export function getRuntimeNotificationProvider(provider: NotificationProvider) {
  return getRuntimeNotifications().providers[provider] ?? null;
}
