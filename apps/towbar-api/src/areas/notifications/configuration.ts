import type { NotificationProvider } from "@workspace/towbar-core";

import {
  getRuntimeNotificationProvider,
  getRuntimeNotifications,
} from "../../infrastructure/runtime-notifications.js";

export type NotificationProviderConfiguration = NonNullable<
  ReturnType<typeof getRuntimeNotificationProvider>
>;

export function getNotificationProviderState(_workspaceId: string) {
  const runtime = getRuntimeNotifications();
  const configured = (provider: NotificationProvider) =>
    Boolean(runtime.providers[provider]);
  return Promise.resolve({
    configurations: {
      slack: configured("slack") ? { source: "environment" as const } : null,
      smtp: configured("smtp") ? { source: "environment" as const } : null,
    },
    providers: {
      slack: configured("slack"),
      smtp: configured("smtp"),
      webhook: configured("webhook"),
    },
  });
}

export async function notificationProviderAvailability(workspaceId: string) {
  return (await getNotificationProviderState(workspaceId)).providers;
}

export function getNotificationProviderConfiguration(
  _workspaceId: string,
  provider: NotificationProvider,
): Promise<NotificationProviderConfiguration | null> {
  return Promise.resolve(getRuntimeNotificationProvider(provider));
}
