import { Notification01Icon } from "@hugeicons/core-free-icons";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { NotificationsSettings } from "@/components/notifications-settings";
import { DashboardPage } from "@/components/page-parts";

const notifications = ["slack", "email", "webhook", "deliveries"];

export default async function Page({
  params,
}: {
  params: Promise<{ notification: string }>;
}) {
  const { notification } = await params;
  if (!notifications.includes(notification)) notFound();
  return (
    <DashboardPage title="Notifications" icon={Notification01Icon}>
      <Suspense fallback={<QueryLoading />}>
        <NotificationsSettings notification={notification} />
      </Suspense>
    </DashboardPage>
  );
}
