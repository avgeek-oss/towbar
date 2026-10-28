import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import {
  notificationEventPayloadSchema,
  slackNotificationConfigSchema,
} from "@workspace/towbar-core";

import {
  emailNotificationUrl,
  isPrivateOrReservedAddress,
  renderSlackDeploymentMessage,
  requirePublicHttpsUrl,
  sendSlackNotification,
} from "./providers.js";
import { backupStaleNotificationCopy } from "./backup-notifications.js";
import { sendWebhookNotification } from "./external-providers.js";

void test("accepts Slack channel IDs without storing credentials", () => {
  assert.deepEqual(
    slackNotificationConfigSchema.parse({ channelId: "C12345678" }),
    {
      channelId: "C12345678",
    },
  );
  assert.throws(
    () => slackNotificationConfigSchema.parse({ channelId: "#general" }),
    /valid Slack channel ID/u,
  );
});

void test("blocks private and reserved SMTP targets", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
  ]) {
    assert.equal(isPrivateOrReservedAddress(address), true, address);
  }
  assert.equal(isPrivateOrReservedAddress("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedAddress("2606:4700:4700::1111"), false);
});

const deploymentPayload = notificationEventPayloadSchema.parse({
  details: { commit: "abc123", trigger: "Auto deploy" },
  entity: { id: "deployment-1", kind: "deployment", name: "Towbar API" },
  message: "The deployment passed its health check.",
  occurredAt: "2026-08-30T10:00:00.000Z",
  source: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "platform",
  },
  title: "Deployment succeeded",
});

void test("email actions open the notification's entity in the correct collection", () => {
  const payload = {
    ...deploymentPayload,
    details: { deployableId: "service-1", deployableKind: "app" },
  };
  assert.equal(
    emailNotificationUrl(payload, "https://towbar.example.test"),
    "https://towbar.example.test/services/service-1/deployments/deployment-1",
  );
  assert.equal(
    emailNotificationUrl(
      {
        ...payload,
        details: { ...payload.details, deployableKind: "postgres" },
      },
      "https://towbar.example.test",
    ),
    "https://towbar.example.test/datastores/service-1/deployments/deployment-1",
  );
  assert.equal(
    emailNotificationUrl(
      {
        ...payload,
        entity: { kind: "server", id: "server-1", name: "Server" },
        details: { incidentId: "incident-1" },
      },
      "https://towbar.example.test",
    ),
    "https://towbar.example.test/servers/server-1/incidents",
  );
  for (const [kind, collection] of [
    ["app", "services"],
    ["resource", "datastores"],
  ] as const) {
    for (const incidentId of [null, "incident-1"]) {
      assert.equal(
        emailNotificationUrl(
          {
            ...payload,
            entity: { kind, id: "workload-1", name: "Workload" },
            details: { incidentId },
          },
          "https://towbar.example.test",
        ),
        `https://towbar.example.test/${collection}/workload-1/${incidentId ? "incidents" : "overview"}`,
      );
    }
  }
});

void test("renders a compact Slack deployment summary with a Towbar link", () => {
  const message = renderSlackDeploymentMessage({
    eventId: "event-1",
    eventType: "deployment.succeeded",
    payload: deploymentPayload,
    providerConfiguration: { appBaseUrl: "https://app.towbar.dev" },
  });
  assert.match(message.text, /Deployment succeeded/u);
  assert.equal(message.blocks.at(-1)?.type, "actions");
  assert.match(
    JSON.stringify(message.blocks),
    /https:\/\/app\.towbar\.dev\/sources\/11111111-1111-4111-8111-111111111111\/deployments\/deployment-1/u,
  );
});

void test("renders a scheduled backup reminder in plain language", async () => {
  const copy = backupStaleNotificationCopy(
    "Internal PostgreSQL",
    new Date("2026-09-03T02:00:00.000Z"),
  );
  const calls: Array<{ payload: Record<string, unknown> }> = [];
  await sendSlackNotification(
    {
      config: { channelId: "C12345678" },
      eventId: "event-backup-stale",
      eventType: "backup.stale",
      payload: notificationEventPayloadSchema.parse({
        ...copy,
        entity: {
          id: "resource-1",
          kind: "resource",
          name: "Internal PostgreSQL",
        },
        occurredAt: "2026-09-03T04:00:00.000Z",
        source: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "platform",
        },
      }),
      providerConfiguration: {
        appBaseUrl: "https://app.towbar.dev",
        botToken: "test-token",
      },
    },
    (_method, payload) => {
      calls.push({ payload });
      return Promise.resolve({ ok: true, ts: "171234.5678" });
    },
  );

  const rendered = JSON.stringify(calls[0]?.payload);
  assert.match(rendered, /Scheduled backup did not complete/u);
  assert.match(rendered, /Scheduled For/u);
  assert.doesNotMatch(rendered, /ExpectedAfter|UnknownError/u);
});

void test("updates the Slack root only for the newest lifecycle event and always replies", async () => {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const request = (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    return Promise.resolve({ ok: true, ts: "171234.5678" });
  };
  const base = {
    config: { channelId: "C12345678" },
    eventId: "event-2",
    eventType: "deployment.succeeded" as const,
    payload: deploymentPayload,
    providerConfiguration: {
      appBaseUrl: "https://app.towbar.dev",
      botToken: "test-token",
    },
  };
  const unchangedRoot = await sendSlackNotification(
    {
      ...base,
      thread: {
        messageId: "root-message",
        threadId: "root-thread",
        updateRoot: false,
      },
    },
    request,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage"],
  );
  assert.equal(calls[0]?.payload.thread_ts, "root-thread");
  assert.equal(unchangedRoot.rootUpdated, false);

  calls.length = 0;
  const updatedRoot = await sendSlackNotification(
    {
      ...base,
      thread: {
        messageId: "root-message",
        threadId: "root-thread",
        updateRoot: true,
      },
    },
    request,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "chat.postMessage"],
  );
  assert.equal(updatedRoot.rootUpdated, true);
});

void test("rejects webhook endpoints with credentials or custom ports", async () => {
  await assert.rejects(
    requirePublicHttpsUrl("https://user:pass@example.com/hook"),
    /public HTTPS URL/u,
  );
  await assert.rejects(
    requirePublicHttpsUrl("https://example.com:8443/hook"),
    /public HTTPS URL/u,
  );
});

void test("webhook push applies configured headers and signs the exact body", async () => {
  const calls: Array<{ body: string; headers: Headers }> = [];
  const request: typeof fetch = (_url, init) => {
    calls.push({
      body: String(init?.body),
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  await sendWebhookNotification(
    {
      config: {
        url: "https://1.1.1.1/events",
        headers: { Authorization: "Bearer private-token" },
        signingSecret: "a-signing-secret-with-at-least-32-characters",
      },
      eventId: "event-webhook",
      eventType: "notification.test",
      payload: deploymentPayload,
    },
    request,
  );
  const sent = calls[0];
  assert.ok(sent);
  assert.equal(sent.headers.get("authorization"), "Bearer private-token");
  assert.equal(sent.headers.get("x-towbar-event-id"), "event-webhook");
  const timestamp = sent.headers.get("x-towbar-timestamp");
  assert.ok(timestamp);
  assert.equal(
    sent.headers.get("x-towbar-signature-256"),
    `sha256=${createHmac("sha256", "a-signing-secret-with-at-least-32-characters").update(`${timestamp}.${sent.body}`).digest("hex")}`,
  );
});
