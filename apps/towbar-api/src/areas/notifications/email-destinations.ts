import { createHash } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import {
  notificationEmailDestinations,
  notificationEmailRouting,
} from "@workspace/towbar-database/schema";
import { badRequest } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { getRuntimeNotifications } from "../../infrastructure/runtime-notifications.js";
import { slackNotificationRoutes } from "./slack-destinations.js";
import { webhookNotificationRoutes } from "./webhook-destinations.js";
import {
  deploymentSubscriptionCategories,
  hasOneDeploymentSubscription,
} from "./deployment-subscriptions.js";

export const emailDestinationsSchema = z
  .object({
    destinations: z
      .array(
        z
          .object({
            email: z.string().trim().email().max(320),
            deployments: z.boolean(),
            deploymentFailures: z.boolean(),
            backupsAndRestores: z.boolean(),
            scout: z.boolean(),
          })
          .strict()
          .refine(
            hasOneDeploymentSubscription,
            "Choose one deployment subscription",
          ),
      )
      .max(100)
      .refine(
        (rows) =>
          new Set(rows.map((row) => row.email.toLowerCase())).size ===
          rows.length,
        "Each email address can appear only once",
      ),
  })
  .strict();

type EmailDestinationInput = z.infer<
  typeof emailDestinationsSchema
>["destinations"][number];

function legacyEmailDestinations(): EmailDestinationInput[] {
  const byEmail = new Map<string, EmailDestinationInput>();
  for (const route of getRuntimeNotifications().routes) {
    if (route.provider !== "smtp") continue;
    for (const recipient of route.config.recipients) {
      const email = recipient.toLowerCase();
      const row = byEmail.get(email) ?? {
        email,
        deployments: false,
        deploymentFailures: false,
        backupsAndRestores: false,
        scout: false,
      };
      row.deployments ||= route.categories.includes("deployments");
      row.deploymentFailures ||=
        route.categories.includes("deploymentFailures");
      if (row.deployments) row.deploymentFailures = false;
      row.backupsAndRestores ||=
        route.categories.includes("backups") ||
        route.categories.includes("restores");
      row.scout ||=
        route.categories.includes("health") ||
        route.categories.includes("scout");
      byEmail.set(email, row);
    }
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export async function emailRoutingMigrated(workspaceId: string) {
  const [row] = await getTowbarDatabase()
    .select({ workspaceId: notificationEmailRouting.workspaceId })
    .from(notificationEmailRouting)
    .where(eq(notificationEmailRouting.workspaceId, workspaceId))
    .limit(1);
  return Boolean(row);
}

export async function listEmailDestinations(workspaceId: string) {
  if (!(await emailRoutingMigrated(workspaceId))) {
    return legacyEmailDestinations().map((row) => ({
      ...row,
      id: `legacy-${createHash("sha256").update(row.email).digest("hex").slice(0, 16)}`,
    }));
  }
  const rows = await getTowbarDatabase()
    .select()
    .from(notificationEmailDestinations)
    .where(eq(notificationEmailDestinations.workspaceId, workspaceId));
  return rows.map(({ health, ...row }) => ({
    ...row,
    scout: row.scout || health,
  }));
}

export async function saveEmailDestinations(
  workspaceId: string,
  destinations: EmailDestinationInput[],
) {
  if (!getRuntimeNotifications().providers.smtp)
    throw badRequest(
      "Configure SMTP in the runtime before adding email destinations",
      "SMTP_NOT_CONFIGURED",
    );
  const normalized = destinations.map((row) => ({
    ...row,
    email: row.email.toLowerCase(),
    health: row.scout,
  }));
  await getTowbarDatabase().transaction(async (tx) => {
    await tx
      .insert(notificationEmailRouting)
      .values({ workspaceId })
      .onConflictDoNothing();
    const existing = await tx
      .select()
      .from(notificationEmailDestinations)
      .where(eq(notificationEmailDestinations.workspaceId, workspaceId));
    const byEmail = new Map(existing.map((row) => [row.email, row]));
    for (const row of normalized) {
      const current = byEmail.get(row.email);
      if (current)
        await tx
          .update(notificationEmailDestinations)
          .set(row)
          .where(eq(notificationEmailDestinations.id, current.id));
      else
        await tx
          .insert(notificationEmailDestinations)
          .values({ ...row, workspaceId });
    }
    await tx.delete(notificationEmailDestinations).where(
      and(
        eq(notificationEmailDestinations.workspaceId, workspaceId),
        normalized.length
          ? notInArray(
              notificationEmailDestinations.email,
              normalized.map((row) => row.email),
            )
          : undefined,
      ),
    );
  });
  return listEmailDestinations(workspaceId);
}

export async function emailNotificationRoutes(workspaceId: string) {
  if (!getRuntimeNotifications().providers.smtp) return [];
  if (!(await emailRoutingMigrated(workspaceId))) {
    return getRuntimeNotifications().routes.filter(
      (route) => route.provider === "smtp",
    );
  }
  const rows = await getTowbarDatabase()
    .select()
    .from(notificationEmailDestinations)
    .where(eq(notificationEmailDestinations.workspaceId, workspaceId));
  return rows.map((row) => ({
    id: `email-${row.id}`,
    provider: "smtp" as const,
    enabled: true,
    categories: [
      ...deploymentSubscriptionCategories(row),
      ...(row.backupsAndRestores
        ? ["backups" as const, "restores" as const]
        : []),
      ...(row.scout || row.health ? ["health" as const, "scout" as const] : []),
    ],
    config: { recipients: [row.email] },
  }));
}

export async function notificationRoutesForWorkspace(workspaceId: string) {
  return [
    ...getRuntimeNotifications().routes.filter(
      (route) =>
        route.provider !== "smtp" &&
        route.provider !== "slack" &&
        route.provider !== "webhook",
    ),
    ...(await emailNotificationRoutes(workspaceId)),
    ...(await slackNotificationRoutes(workspaceId)),
    ...(await webhookNotificationRoutes(workspaceId)),
  ];
}

export async function emailNotificationRoute(
  workspaceId: string,
  destinationId: string,
) {
  if (!destinationId.startsWith("email-")) return null;
  const id = destinationId.slice(6);
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await getTowbarDatabase()
    .select()
    .from(notificationEmailDestinations)
    .where(
      and(
        eq(notificationEmailDestinations.id, id),
        eq(notificationEmailDestinations.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: destinationId,
    provider: "smtp" as const,
    enabled: true,
    categories: [
      ...deploymentSubscriptionCategories(row),
      ...(row.backupsAndRestores
        ? ["backups" as const, "restores" as const]
        : []),
      ...(row.scout || row.health ? ["health" as const, "scout" as const] : []),
    ],
    config: { recipients: [row.email] },
  };
}
