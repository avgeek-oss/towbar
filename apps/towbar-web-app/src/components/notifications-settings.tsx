"use client";

import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  notificationDeliveries,
  notificationProviders,
  type ProviderGroup,
} from "./integration-catalog";
import { ProviderPage } from "./integrations";

type Provider = "slack" | "smtp" | "webhook";

export function NotificationsSettings({
  notification,
}: {
  notification: string;
}) {
  const query = useApiQuery<{ providers: Record<Provider, boolean> }>(
    "/v1/core/notifications/providers",
    30_000,
  );
  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;

  const providers = notificationProviders;
  const groups: ProviderGroup[] = [
    { value: "providers", label: "Providers", providers: [...providers] },
    { value: "health", label: "Health", providers: [notificationDeliveries] },
  ];
  const statuses = Object.fromEntries(
    providers
      .filter((item) => query.data!.providers[item.provider])
      .map((item) => [item.value, "Configured"]),
  );
  return (
    <ProviderPage
      groups={groups}
      provider={notification}
      statuses={statuses}
      basePath="/manage/notifications"
    />
  );
}
