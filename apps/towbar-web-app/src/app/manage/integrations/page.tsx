import { redirect } from "next/navigation";

import { isIntegrationRoute } from "@/lib/integration-routes";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string }>;
}) {
  const requested = (await searchParams).integration;
  if (
    requested &&
    ["slack", "email", "webhook", "deliveries"].includes(requested)
  )
    redirect(`/manage/notifications/${requested}`);
  redirect(
    `/manage/integrations/${isIntegrationRoute(requested) ? requested : "github"}`,
  );
}
