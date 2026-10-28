import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type {
  NotificationEventPayload,
  NotificationEventType,
} from "@workspace/towbar-core";
import { createHmac } from "node:crypto";

import { NotificationProviderError } from "./provider-error.js";

const providerTimeoutMs = 10_000;

export async function sendWebhookNotification(
  input: {
    config: {
      url: string;
      headers?: Record<string, string>;
      signingSecret?: string;
    };
    eventId: string;
    eventType: NotificationEventType;
    payload: NotificationEventPayload;
  },
  request: typeof fetch = fetch,
) {
  const url = await requirePublicHttpsUrl(input.config.url);
  const body = JSON.stringify({
    event: { id: input.eventId, type: input.eventType },
    payload: input.payload,
  });
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = input.config.signingSecret
    ? createHmac("sha256", input.config.signingSecret)
        .update(`${timestamp}.${body}`)
        .digest("hex")
    : null;
  const response = await providerRequest(
    "Webhook",
    url,
    {
      body,
      headers: {
        ...input.config.headers,
        "content-type": "application/json",
        "user-agent": "Towbar-Notifications/1.0",
        "x-towbar-event-id": input.eventId,
        "x-towbar-event-type": input.eventType,
        ...(signature
          ? {
              "x-towbar-timestamp": timestamp,
              "x-towbar-signature-256": `sha256=${signature}`,
            }
          : {}),
      },
      method: "POST",
    },
    request,
  );
  return { providerStatus: response.status.toString() };
}

async function providerRequest(
  provider: string,
  url: string,
  init: RequestInit,
  request: typeof fetch,
) {
  let response: Response;
  try {
    response = await request(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(providerTimeoutMs),
    });
  } catch (error) {
    const timeout =
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name);
    throw new NotificationProviderError(
      timeout ? "DELIVERY_RESULT_UNKNOWN" : "PROVIDER_UNREACHABLE",
      timeout
        ? "The provider response timed out; delivery may have completed"
        : `${provider} could not be reached`,
      !timeout,
    );
  }
  if (response.ok) return response;
  const retryable = response.status === 429 || response.status >= 500;
  throw new NotificationProviderError(
    retryable
      ? `${provider.toUpperCase()}_TEMPORARY_FAILURE`
      : `${provider.toUpperCase()}_REJECTED`,
    retryable
      ? `${provider} temporarily rejected the notification`
      : `${provider} rejected the notification`,
    retryable,
    String(response.status),
  );
}

export async function requirePublicHttpsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new NotificationProviderError(
      "INVALID_WEBHOOK_URL",
      "Webhook URL must be a public HTTPS URL without credentials or a custom port",
      false,
    );
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new NotificationProviderError(
      "WEBHOOK_DNS_FAILED",
      "Webhook host could not be resolved",
      true,
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isUnsafeAddress(address))
  ) {
    throw new NotificationProviderError(
      "UNSAFE_WEBHOOK_URL",
      "Webhook URL must resolve only to public network addresses",
      false,
    );
  }
  return url.toString();
}

function isUnsafeAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return isUnsafeIpv4(address);
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isUnsafeAddress(normalized.slice(7));
    }
    return isUnsafeIpv6(normalized);
  }
  return true;
}

function isUnsafeIpv4(address: string) {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return (
    isPrivateIpv4(a, b) ||
    isDocumentationIpv4(a, b, c) ||
    isSpecialPurposeIpv4(a, b, c)
  );
}

function isPrivateIpv4(a: number, b: number) {
  return (
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isDocumentationIpv4(a: number, b: number, c: number) {
  return (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isSpecialPurposeIpv4(a: number, b: number, c: number) {
  return (
    a === 0 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isUnsafeIpv6(address: string) {
  return (
    address === "::" ||
    address === "::1" ||
    ["fc", "fd", "100:", "2001:db8:", "fe8", "fe9", "fea", "feb", "ff"].some(
      (prefix) => address.startsWith(prefix),
    )
  );
}
