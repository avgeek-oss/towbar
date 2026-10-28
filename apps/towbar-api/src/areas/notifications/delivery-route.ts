import { getRuntimeNotificationRoute } from "../../infrastructure/runtime-notifications.js";
import {
  manifestNotificationAppId,
  manifestNotificationRoute,
} from "./manifest-destinations.js";
import { webhookNotificationRoute } from "./webhook-destinations.js";
import { emailNotificationRoute } from "./email-destinations.js";
import {
  legacySlackNotificationRoute,
  slackNotificationRoute,
} from "./slack-destinations.js";

export async function resolveNotificationDeliveryRoute(
  workspaceId: string,
  destinationId: string,
  provider: string,
) {
  if (manifestNotificationAppId(destinationId))
    return manifestNotificationRoute(workspaceId, destinationId);
  if (provider === "webhook")
    return webhookNotificationRoute(workspaceId, destinationId);
  if (destinationId.startsWith("email-"))
    return emailNotificationRoute(workspaceId, destinationId);
  if (destinationId.startsWith("slack-"))
    return (
      (await slackNotificationRoute(workspaceId, destinationId)) ??
      getRuntimeNotificationRoute(destinationId) ??
      (await legacySlackNotificationRoute(workspaceId, destinationId))
    );
  return (
    getRuntimeNotificationRoute(destinationId) ??
    (provider === "slack"
      ? await legacySlackNotificationRoute(workspaceId, destinationId)
      : null)
  );
}
