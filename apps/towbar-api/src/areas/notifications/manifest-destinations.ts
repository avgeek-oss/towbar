import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type {
  ManifestNotifications,
  NotificationCategory,
  NotificationProvider,
} from "@workspace/towbar-core";
import { apps } from "@workspace/towbar-database/schema";

import { getTowbarDatabase } from "../../infrastructure/database.js";
import { getRuntimeNotifications } from "../../infrastructure/runtime-notifications.js";

type ManifestRoute = {
  id: string;
  provider: NotificationProvider;
  categories: NotificationCategory[];
  config: object;
};

function categories(row: {
  deployments: boolean;
  deploymentFailures?: boolean;
  backupsAndRestores: boolean;
  alertsAndIncidents: boolean;
}): NotificationCategory[] {
  return [
    ...(row.deployments ? ["deployments" as const] : []),
    ...(row.deploymentFailures && !row.deployments
      ? ["deploymentFailures" as const]
      : []),
    ...(row.backupsAndRestores
      ? ["backups" as const, "restores" as const]
      : []),
    ...(row.alertsAndIncidents ? ["health" as const, "scout" as const] : []),
  ];
}

function routeId(appId: string, provider: string, destination: string) {
  const hash = createHash("sha256")
    .update(`${provider}:${destination}`)
    .digest("hex")
    .slice(0, 16);
  return `manifest-${appId.replaceAll("-", "")}-${hash}`;
}

export function manifestNotificationAppId(destinationId: string) {
  const match = /^manifest-([a-f0-9]{32})-[a-f0-9]{16}$/u.exec(destinationId);
  if (!match) return null;
  const compactId = match[1]!;
  return `${compactId.slice(0, 8)}-${compactId.slice(8, 12)}-${compactId.slice(12, 16)}-${compactId.slice(16, 20)}-${compactId.slice(20)}`;
}

export function manifestNotificationLabels(
  appId: string,
  notifications: ManifestNotifications | undefined,
) {
  const labels = new Map<string, string>();
  for (const row of notifications?.email ?? [])
    labels.set(routeId(appId, "smtp", row.address), row.address);
  for (const row of notifications?.slack ?? [])
    labels.set(routeId(appId, "slack", row.channelId), row.channelId);
  return labels;
}

export function manifestNotificationRoutes(
  appId: string,
  notifications: ManifestNotifications | undefined,
  runtime = getRuntimeNotifications(),
): ManifestRoute[] {
  if (!notifications) return [];
  return [
    ...(runtime.providers.smtp
      ? (notifications.email ?? []).map((row) => ({
          id: routeId(appId, "smtp", row.address),
          provider: "smtp" as const,
          categories: categories(row),
          config: { recipients: [row.address] },
        }))
      : []),
    ...(runtime.providers.slack
      ? (notifications.slack ?? []).map((row) => ({
          id: routeId(appId, "slack", row.channelId),
          provider: "slack" as const,
          categories: categories(row),
          config: { channelId: row.channelId },
        }))
      : []),
  ];
}

export async function manifestNotificationRoutesForApp(
  appId: string,
  workspaceId: string,
  runtime = getRuntimeNotifications(),
) {
  const [app] = await getTowbarDatabase()
    .select({ config: apps.config })
    .from(apps)
    .where(
      and(
        eq(apps.id, appId),
        eq(apps.workspaceId, workspaceId),
        isNull(apps.archivedAt),
      ),
    )
    .limit(1);
  return manifestNotificationRoutes(appId, app?.config.notifications, runtime);
}

export async function manifestNotificationRoute(
  workspaceId: string,
  destinationId: string,
) {
  const appId = manifestNotificationAppId(destinationId);
  if (!appId) return null;
  return (
    (await manifestNotificationRoutesForApp(appId, workspaceId)).find(
      (route) => route.id === destinationId,
    ) ?? null
  );
}
