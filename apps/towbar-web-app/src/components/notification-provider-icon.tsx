import { Mail01Icon, WebhookIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { IntegrationProviderLogo } from "./integration-provider-logo";

export function NotificationProviderIcon({
  provider,
  className = "size-4 shrink-0",
}: {
  provider: "slack" | "smtp" | "webhook";
  className?: string;
}) {
  if (provider === "slack")
    return (
      <IntegrationProviderLogo provider={provider} className={className} />
    );
  return (
    <HugeiconsIcon
      icon={provider === "smtp" ? Mail01Icon : WebhookIcon}
      className={className}
      aria-hidden="true"
    />
  );
}
