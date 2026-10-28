import { sendSmtpEmail } from "./smtp.js";
export {
  sendSmtpEmail,
  resolvePublicSmtpAddress,
  isPrivateOrReservedAddress,
} from "./smtp.js";
import { renderOperationalEmail } from "@workspace/towbar-email";
import { getEnv } from "../../env.js";

import {
  notificationEventPayloadSchema,
  slackNotificationConfigSchema,
  smtpNotificationConfigSchema,
  webhookNotificationConfigSchema,
} from "@workspace/towbar-core";

import type { NotificationProviderConfiguration } from "./configuration.js";
import { NotificationProviderError } from "./provider-error.js";
import { sendWebhookNotification } from "./external-providers.js";

export { NotificationProviderError } from "./provider-error.js";
export { requirePublicHttpsUrl } from "./external-providers.js";

import type {
  NotificationEventPayload,
  NotificationEventType,
  NotificationProvider,
} from "@workspace/towbar-core";

const providerTimeoutMs = 10_000;

export async function deliverNotification(input: {
  config: unknown;
  eventId: string;
  eventType: NotificationEventType;
  payload: NotificationEventPayload;
  provider: NotificationProvider;
  providerConfiguration: NotificationProviderConfiguration;
  thread?: { messageId: string; threadId: string; updateRoot: boolean } | null;
}) {
  const payload = notificationEventPayloadSchema.parse(input.payload);
  if (input.provider === "slack") {
    if (input.providerConfiguration.provider !== "slack") {
      throw invalidProviderConfiguration("Slack");
    }
    const result = await sendSlackNotification({
      config: slackNotificationConfigSchema.parse(input.config),
      eventId: input.eventId,
      eventType: input.eventType,
      payload,
      providerConfiguration: input.providerConfiguration,
      thread: input.thread,
    });
    return {
      providerMessageId: result.messageId,
      rootUpdated: result.rootUpdated,
      providerStatus: "accepted",
      providerThreadId: result.threadId,
    };
  }
  if (input.provider === "smtp") {
    if (input.providerConfiguration.provider !== "smtp") {
      throw invalidProviderConfiguration("Email");
    }
    const config = smtpNotificationConfigSchema.parse(input.config);
    return await sendSmtpNotification({
      config,
      eventId: input.eventId,
      payload,
      providerConfiguration: input.providerConfiguration,
    });
  }
  return await sendWebhookNotification({
    config: webhookNotificationConfigSchema.parse(input.config),
    eventId: input.eventId,
    eventType: input.eventType,
    payload,
  });
}

type SlackApiRequest = (
  method: "chat.postMessage" | "chat.update",
  payload: Record<string, unknown>,
  botToken: string,
) => Promise<Record<string, unknown>>;

export async function sendSlackNotification(
  input: {
    config: { channelId: string };
    eventId: string;
    eventType: NotificationEventType;
    payload: NotificationEventPayload;
    providerConfiguration: { appBaseUrl: string; botToken: string };
    thread?: {
      messageId: string;
      threadId: string;
      updateRoot: boolean;
    } | null;
  },
  request: SlackApiRequest = slackApiRequest,
) {
  const message = input.eventType.startsWith("deployment.")
    ? renderSlackDeploymentMessage(input)
    : renderSlackGenericMessage(input);
  if (!input.thread) {
    const created = await request(
      "chat.postMessage",
      {
        ...message,
        channel: input.config.channelId,
        client_msg_id: input.eventId,
      },
      input.providerConfiguration.botToken,
    );
    const messageId = requireSlackMessageId(created);
    return { messageId, rootUpdated: true, threadId: messageId };
  }
  if (input.thread.updateRoot) {
    await request(
      "chat.update",
      {
        ...message,
        channel: input.config.channelId,
        ts: input.thread.messageId,
      },
      input.providerConfiguration.botToken,
    );
  }
  await request(
    "chat.postMessage",
    {
      blocks: renderSlackLifecycleReply(input),
      channel: input.config.channelId,
      client_msg_id: input.eventId,
      text: message.text,
      thread_ts: input.thread.threadId,
    },
    input.providerConfiguration.botToken,
  );
  return { ...input.thread, rootUpdated: input.thread.updateRoot };
}

function renderSlackGenericMessage(input: {
  payload: NotificationEventPayload;
}) {
  return {
    blocks: [
      {
        text: {
          text: escapeSlack(input.payload.title),
          type: "plain_text",
        },
        type: "header",
      },
      {
        text: {
          text: escapeSlack(input.payload.message),
          type: "mrkdwn",
        },
        type: "section",
      },
      ...(compactSlackDetails(input.payload.details).length
        ? [
            {
              fields: compactSlackDetails(input.payload.details),
              type: "section",
            },
          ]
        : []),
      {
        elements: [
          {
            text: `${escapeSlack(input.payload.source?.name ?? input.payload.entity.name)} · ${formatSlackTimestamp(input.payload.occurredAt)}`,
            type: "mrkdwn",
          },
        ],
        type: "context",
      },
    ],
    text: `${input.payload.title}: ${input.payload.message}`.slice(0, 3_000),
  };
}

export function renderSlackDeploymentMessage(input: {
  eventId: string;
  eventType: NotificationEventType;
  payload: NotificationEventPayload;
  providerConfiguration: { appBaseUrl: string };
}) {
  const details = compactSlackDetails(input.payload.details);
  const deploymentUrl = new URL(
    `/sources/${input.payload.source?.id ?? ""}/deployments/${input.payload.entity.id}`,
    input.providerConfiguration.appBaseUrl,
  ).toString();
  return {
    blocks: [
      {
        text: {
          text: `${deploymentStatusIcon(input.eventType)} ${escapeSlack(input.payload.entity.name)}`,
          type: "plain_text",
        },
        type: "header",
      },
      {
        fields: [
          {
            text: `*Status*\n${escapeSlack(deploymentStatus(input.eventType))}`,
            type: "mrkdwn",
          },
          {
            text: `*Source*\n${escapeSlack(input.payload.source?.name ?? input.payload.entity.name)}`,
            type: "mrkdwn",
          },
          ...details,
        ].slice(0, 10),
        type: "section",
      },
      {
        elements: [
          {
            text: escapeSlack(input.payload.message),
            type: "mrkdwn",
          },
        ],
        type: "context",
      },
      {
        elements: [
          {
            text: { text: "View deployment", type: "plain_text" },
            type: "button",
            url: deploymentUrl,
          },
        ],
        type: "actions",
      },
    ],
    text: `${input.payload.title}: ${input.payload.message}`.slice(0, 3_000),
  };
}

function renderSlackLifecycleReply(input: {
  eventId: string;
  eventType: NotificationEventType;
  payload: NotificationEventPayload;
}) {
  return [
    {
      text: {
        text: `*${deploymentStatusIcon(input.eventType)} ${escapeSlack(input.payload.title)}*\n${escapeSlack(input.payload.message)}`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      elements: [
        {
          text: `${formatSlackTimestamp(input.payload.occurredAt)} · event ${input.eventId}`,
          type: "mrkdwn",
        },
      ],
      type: "context",
    },
  ];
}

async function slackApiRequest(
  method: "chat.postMessage" | "chat.update",
  payload: Record<string, unknown>,
  botToken: string,
) {
  let response: Response;
  try {
    response = await fetch(`https://slack.com/api/${method}`, {
      body: JSON.stringify(payload),
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(providerTimeoutMs),
    });
  } catch (error) {
    throw classifyNetworkError(error, "Slack could not be reached");
  }
  const result = await readBoundedResponse(response);
  if (response.ok && result.ok === true) return result;
  const retryable =
    response.status === 429 ||
    response.status >= 500 ||
    result.error === "ratelimited";
  throw new NotificationProviderError(
    retryable ? "SLACK_TEMPORARY_FAILURE" : "SLACK_REJECTED",
    retryable
      ? "Slack temporarily rejected the notification"
      : "Slack rejected the notification configuration",
    retryable,
    typeof result.error === "string"
      ? result.error.slice(0, 100)
      : String(response.status),
  );
}

function requireSlackMessageId(result: Record<string, unknown>) {
  if (typeof result.ts === "string" && result.ts.length <= 100) {
    return result.ts;
  }
  throw new NotificationProviderError(
    "SLACK_INVALID_RESPONSE",
    "Slack accepted the notification without returning a message ID",
    true,
  );
}

function compactSlackDetails(details: NotificationEventPayload["details"]) {
  return Object.entries(details)
    .filter(
      ([, value]) => value !== null && value !== undefined && value !== "",
    )
    .slice(0, 6)
    .map(([key, value]) => ({
      text: `*${escapeSlack(titleCase(key))}*\n${escapeSlack(String(value))}`,
      type: "mrkdwn",
    }));
}

function deploymentStatus(type: NotificationEventType) {
  return type.startsWith("deployment.")
    ? titleCase(type.slice("deployment.".length))
    : "Updated";
}

function deploymentStatusIcon(type: NotificationEventType) {
  if (type === "deployment.succeeded") return "✅";
  if (type === "deployment.failed" || type === "deployment.cancelled") {
    return "❌";
  }
  if (type === "deployment.started") return "🔵";
  return "🟡";
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function formatSlackTimestamp(value: string) {
  const epoch = Math.floor(new Date(value).getTime() / 1_000);
  return Number.isFinite(epoch)
    ? `<!date^${epoch}^{date_short_pretty} at {time}|${value}>`
    : value;
}

async function sendSmtpNotification(input: {
  config: { recipients: string[] };
  eventId: string;
  payload: NotificationEventPayload;
  providerConfiguration: {
    from: string;
    host: string;
    password?: string;
    port: number;
    secure: boolean;
    subjectPrefix: string;
    username?: string;
  };
}) {
  const rendered = await renderOperationalEmail({
    title: input.payload.title,
    summary: input.payload.message,
    details: {
      ...(input.payload.entity.name ? { name: input.payload.entity.name } : {}),
      ...(input.payload.source?.name
        ? { repository: input.payload.source.name }
        : {}),
      ...input.payload.details,
    },
    actionUrl: emailNotificationUrl(
      input.payload,
      getEnv().TOWBAR_APP_BASE_URL,
    ),
  });
  return sendSmtpEmail(
    {
      ...rendered,
      messageId: input.eventId,
      recipients: input.config.recipients,
    },
    input.providerConfiguration,
  );
}

export function emailNotificationUrl(
  payload: NotificationEventPayload,
  baseUrl: string,
) {
  const { entity, details } = payload;
  const id = encodeURIComponent(entity.id);
  let path = "/manage/notifications";
  if (
    entity.kind === "deployment" &&
    typeof details.deployableId === "string"
  ) {
    const collection =
      details.deployableKind === "app" || details.deployableKind === "compose"
        ? "services"
        : "datastores";
    path = `/${collection}/${encodeURIComponent(details.deployableId)}/deployments/${id}`;
  } else if (entity.kind === "deployment") path = "/deployments";
  else if (entity.kind === "server")
    path = `/servers/${id}/${details.incidentId ? "incidents" : "overview"}`;
  else if (entity.kind === "app")
    path = `/services/${id}/${details.incidentId ? "incidents" : "overview"}`;
  else if (entity.kind === "resource")
    path = `/datastores/${id}/${details.incidentId ? "incidents" : "overview"}`;
  else if (entity.kind === "backup" || entity.kind === "restore")
    path = `/datastores/${id}/${entity.kind}`;
  else if (entity.kind === "source") path = `/repositories/${id}/environments`;
  else if (entity.kind === "preview" && payload.source)
    path = `/repositories/${encodeURIComponent(payload.source.id)}/environments`;
  return new URL(path, baseUrl).href;
}

function classifyNetworkError(error: unknown, message: string) {
  const timeout =
    error instanceof Error &&
    ["AbortError", "TimeoutError"].includes(error.name);
  return new NotificationProviderError(
    timeout ? "DELIVERY_RESULT_UNKNOWN" : "PROVIDER_UNREACHABLE",
    timeout
      ? "The provider response timed out; delivery may have completed"
      : message,
    !timeout,
  );
}

function escapeSlack(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function invalidProviderConfiguration(provider: string) {
  return new NotificationProviderError(
    "PROVIDER_NOT_CONFIGURED",
    `${provider} notifications are not configured for this Towbar instance`,
    false,
  );
}

async function readBoundedResponse(response: Response) {
  const text = (await response.text()).slice(0, 16 * 1_024);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
