import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { QueryLoading } from "@workspace/towbar-web-ui/query-state";

import { Integrations } from "@/components/integrations";
import { DashboardPage } from "@/components/page-parts";
import { isIntegrationRoute } from "@/lib/integration-routes";

export default async function Page({
  params,
}: {
  params: Promise<{ integration: string }>;
}) {
  const { integration } = await params;
  if (["slack", "email", "webhook", "deliveries"].includes(integration))
    redirect(`/manage/notifications/${integration}`);
  if (!isIntegrationRoute(integration)) notFound();
  return (
    <DashboardPage title="Integrations" icon={PlugSocketIcon}>
      <Suspense fallback={<QueryLoading />}>
        <Integrations integration={integration} />
      </Suspense>
    </DashboardPage>
  );
}
