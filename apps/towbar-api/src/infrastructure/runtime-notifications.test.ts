import assert from "node:assert/strict";
import test from "node:test";

import { getRuntimeNotifications } from "./runtime-notifications.js";

void test("keeps notifications absent unless explicitly enabled", () => {
  assert.deepEqual(getRuntimeNotifications({}), { providers: {}, routes: [] });
});

void test("loads provider credentials and enabled routes from one environment document", () => {
  const runtime = getRuntimeNotifications({
    TOWBAR_NOTIFICATION_CONFIG_JSON: JSON.stringify({
      providers: {
        smtp: {
          from: "towbar@example.com",
          host: "smtp.example.com",
          password: "secret",
          port: 587,
          secure: false,
          username: "towbar",
        },
      },
      routes: [
        {
          categories: ["deployments"],
          config: { recipients: ["ops@example.com"] },
          enabled: true,
          id: "ops-email",
          provider: "smtp",
        },
      ],
    }),
    TOWBAR_NOTIFICATIONS_ENABLED: "true",
  });

  assert.equal(runtime.providers.smtp?.provider, "smtp");
  assert.equal(runtime.routes[0]?.id, "ops-email");
});

void test("rejects duplicate routes and missing provider credentials", () => {
  const route = {
    categories: ["health"],
    config: { recipients: ["ops@example.com"] },
    enabled: true,
    id: "ops-email",
    provider: "smtp",
  };
  assert.throws(() =>
    getRuntimeNotifications({
      TOWBAR_NOTIFICATION_CONFIG_JSON: JSON.stringify({
        providers: {},
        routes: [route, route],
      }),
      TOWBAR_NOTIFICATIONS_ENABLED: "true",
    }),
  );
});

void test("legacy preview subscriptions follow deployment notifications", () => {
  const runtime = getRuntimeNotifications({
    TOWBAR_NOTIFICATIONS_ENABLED: "true",
    TOWBAR_NOTIFICATION_CONFIG_JSON: JSON.stringify({
      providers: {
        smtp: {
          from: "towbar@example.com",
          host: "smtp.example.com",
          port: 587,
          secure: false,
        },
      },
      routes: [
        {
          id: "legacy-email",
          provider: "smtp",
          enabled: true,
          categories: ["previews", "deployments"],
          config: { recipients: ["ops@example.com"] },
        },
      ],
    }),
  });
  assert.deepEqual(runtime.routes[0]?.categories, ["deployments"]);
});

void test("health and Scout routes share Incidents subscriptions", () => {
  const runtime = getRuntimeNotifications({
    TOWBAR_NOTIFICATIONS_ENABLED: "true",
    TOWBAR_NOTIFICATION_CONFIG_JSON: JSON.stringify({
      providers: {
        slack: { botToken: "xoxb-example-token-long-enough" },
      },
      routes: [
        {
          id: "alerts-slack",
          provider: "slack",
          enabled: true,
          categories: ["health"],
          config: { channelId: "C12345678" },
        },
      ],
    }),
  });
  assert.deepEqual(runtime.routes[0]?.categories, ["health", "scout"]);
});

void test("creates signed webhook endpoints with runtime-only headers", () => {
  const runtime = getRuntimeNotifications({
    TOWBAR_NOTIFICATIONS_ENABLED: "true",
    TOWBAR_NOTIFICATION_CONFIG_JSON: JSON.stringify({
      providers: {
        webhook: [
          {
            id: "operations",
            label: "Operations",
            url: "https://hooks.example.com/events",
            headers: { Authorization: "Bearer private-token" },
            signingSecret: "a-signing-secret-with-at-least-32-characters",
          },
        ],
      },
      routes: [],
    }),
  });
  assert.equal(runtime.providers.webhook?.provider, "webhook");
  assert.equal(runtime.routes[0]?.id, "webhook-operations");
  assert.deepEqual(runtime.routes[0]?.categories, []);
  assert.deepEqual(runtime.routes[0]?.config, {
    url: "https://hooks.example.com/events",
    headers: { Authorization: "Bearer private-token" },
    signingSecret: "a-signing-secret-with-at-least-32-characters",
    label: "Operations",
  });
});

void test("rejects duplicate webhook IDs and reserved header overrides", () => {
  const endpoint = {
    id: "operations",
    label: "Operations",
    url: "https://hooks.example.com/events",
    signingSecret: "a-signing-secret-with-at-least-32-characters",
  };
  for (const endpoints of [
    [endpoint, endpoint],
    [{ ...endpoint, headers: { "X-Towbar-Event-Id": "changed" } }],
    [
      {
        ...endpoint,
        headers: { Authorization: "Bearer token\r\nX-Bad: true" },
      },
    ],
  ])
    assert.throws(() =>
      getRuntimeNotifications({
        TOWBAR_NOTIFICATIONS_ENABLED: "true",
        TOWBAR_NOTIFICATION_CONFIG_JSON: JSON.stringify({
          providers: { webhook: endpoints },
          routes: [],
        }),
      }),
    );
});

void test("rejects retired providers in runtime configuration and routes", () => {
  for (const provider of ["discord", "telegram"]) {
    for (const configuration of [
      { providers: { [provider]: {} }, routes: [] },
      {
        providers: {},
        routes: [
          {
            id: "retired-provider",
            provider,
            config: {},
            categories: ["deployments"],
            enabled: true,
          },
        ],
      },
    ]) {
      assert.throws(() =>
        getRuntimeNotifications({
          TOWBAR_NOTIFICATIONS_ENABLED: "true",
          TOWBAR_NOTIFICATION_CONFIG_JSON: JSON.stringify(configuration),
        }),
      );
    }
  }
});
