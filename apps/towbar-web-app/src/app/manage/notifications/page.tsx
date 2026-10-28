import { redirect } from "next/navigation";

const notifications = new Set(["slack", "email", "webhook"]);

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const requested = (await searchParams).provider;
  redirect(
    `/manage/notifications/${requested && notifications.has(requested) ? requested : "email"}`,
  );
}
