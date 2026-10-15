import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { resolveRepositoryEnvironment } from "@workspace/towbar-core";

import { createFixtureApiServer, fixtureIds } from "./fixture-api.ts";
import { reconcileServerSetupStatus } from "../src/lib/server-preparation-status.ts";

const readRoutes = [
  "/v1/core/session",
  "/v1/core/profile",
  "/v1/core/sessions",
  "/v1/core/github",
  "/v1/core/notifications/providers",
  "/v1/core/notifications/destinations",
  "/v1/core/github/repositories",
  "/v1/core/sources",
  "/v1/core/apps",
  "/v1/core/resources",
  "/v1/core/servers",
  "/v1/core/deployments",
  "/v1/core/deployments/history",
  "/v1/core/monitoring/vulnerabilities",
  "/v1/core/system-health",
  "/v1/core/version",
  "/v1/core/integrations",
  "/v1/core/settings/secrets",
  `/v1/core/sources/${fixtureIds.source}`,
  `/v1/core/sources/${fixtureIds.source}/environments`,
  `/v1/core/sources/${fixtureIds.source}/syncs`,
  `/v1/core/sources/${fixtureIds.source}/auto-deploy-control`,
  `/v1/core/sources/${fixtureIds.source}/apps`,
  `/v1/core/sources/${fixtureIds.source}/capacity`,
  `/v1/core/sources/${fixtureIds.source}/resources`,
  `/v1/core/sources/${fixtureIds.source}/deployments`,
  `/v1/core/sources/${fixtureIds.source}/backups`,
  `/v1/core/sources/${fixtureIds.source}/syncs/${fixtureIds.sync}`,
  `/v1/core/apps/${fixtureIds.app}`,
  `/v1/core/apps/${fixtureIds.faviconApp}/favicon`,
  `/v1/core/deployments/${fixtureIds.previewDeployment}/favicon`,
  `/v1/core/apps/${fixtureIds.app}/auto-deploy-control`,
  `/v1/core/apps/${fixtureIds.app}/secrets`,
  `/v1/core/apps/${fixtureIds.app}/deployments`,
  `/v1/core/apps/${fixtureIds.app}/releases`,
  `/v1/core/apps/${fixtureIds.storageApp}/storage`,
  `/v1/core/apps/${fixtureIds.storageApp}/jobs`,
  `/v1/core/apps/${fixtureIds.app}/operations`,
  `/v1/core/resources/${fixtureIds.resource}`,
  `/v1/core/resources/${fixtureIds.resource}/auto-deploy-control`,
  `/v1/core/resources/${fixtureIds.resource}/secrets`,
  `/v1/core/resources/${fixtureIds.resource}/deployments`,
  `/v1/core/resources/${fixtureIds.resource}/releases`,
  `/v1/core/resources/${fixtureIds.resource}/operations`,
  `/v1/core/servers/${fixtureIds.server}`,
  `/v1/core/servers/${fixtureIds.server}/apps`,
  `/v1/core/servers/${fixtureIds.server}/resources`,
  `/v1/core/servers/${fixtureIds.server}/deployments`,
  `/v1/core/servers/${fixtureIds.server}/capacity`,
  `/v1/core/servers/${fixtureIds.server}/checks`,
  `/v1/core/servers/${fixtureIds.server}/preparations`,
  `/v1/core/servers/${fixtureIds.server}/host-keys`,
  `/v1/core/servers/${fixtureIds.server}/orphans`,
  `/v1/core/deployments/${fixtureIds.deployment}`,
  `/v1/core/deployments/${fixtureIds.deployment}/source-revision`,
  `/v1/core/deployments/${fixtureIds.deployment}/steps`,
  `/v1/core/deployments/${fixtureIds.deployment}/logs`,
];

test("terminal preparation state replaces a stale preparing server state", () => {
  assert.equal(reconcileServerSetupStatus("preparing", "failed"), "failed");
  assert.equal(reconcileServerSetupStatus("preparing", "succeeded"), "ready");
  assert.equal(reconcileServerSetupStatus("preparing", "running"), "preparing");
  assert.equal(reconcileServerSetupStatus("pending", "succeeded"), "pending");
});

test("renaming a server preserves its IP and preparation state", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/core/servers/${fixtureIds.server}`;
  const original = (await (await fetch(url)).json()).server;
  try {
    const response = await fetch(`${url}/name`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Production database  " }),
    });
    assert.equal(response.status, 200);
    const renamed = (await response.json()).server;
    assert.equal(renamed.name, "Production database");
    assert.equal(renamed.canonicalIp, original.canonicalIp);
    assert.equal(renamed.setupStatus, original.setupStatus);
    assert.deepEqual(renamed.config, original.config);
    const cleared = await fetch(`${url}/name`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: null }),
    });
    assert.equal((await cleared.json()).server.name, null);
  } finally {
    await fetch(`${url}/name`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: original.name }),
    });
    server.close();
    await once(server, "close");
  }
});

test("email destinations are editable while provider credentials remain runtime-owned", async () => {
  const server = createFixtureApiServer({
    smtpConfigured: true,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1/core`;

  try {
    const providers = await (
      await fetch(`${baseUrl}/notifications/providers`)
    ).json();
    assert.deepEqual(providers.providers, {
      discord: false,
      slack: false,
      smtp: true,
      telegram: false,
      webhook: false,
    });
    assert.equal(providers.configurations.slack, null);
    assert.deepEqual(providers.configurations.smtp, {
      source: "environment",
    });

    const destinations = await (
      await fetch(`${baseUrl}/notifications/destinations`)
    ).json();
    assert.equal(destinations.canManageNotifications, false);
    assert(destinations.destinations.length > 0);

    const email = await fetch(`${baseUrl}/notifications/email/destinations`);
    assert.equal(email.status, 200);
    const [initialDestination] = (await email.json()).destinations;
    assert.equal(initialDestination.email, "operations@example.com");
    const updated = await fetch(`${baseUrl}/notifications/email/destinations`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destinations: [
          {
            email: initialDestination.email,
            deployments: false,
            deploymentFailures: false,
            backupsAndRestores: true,
            scout: true,
          },
        ],
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal(
      (await updated.json()).destinations[0].id,
      initialDestination.id,
    );
    const saved = await fetch(`${baseUrl}/notifications/email/destinations`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destinations: [
          {
            email: "alerts@example.com",
            deployments: true,
            deploymentFailures: false,
            backupsAndRestores: false,
            scout: true,
          },
        ],
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal(
      (await saved.json()).destinations[0].email,
      "alerts@example.com",
    );
    const afterSave = await (
      await fetch(`${baseUrl}/notifications/email/destinations`)
    ).json();
    assert.equal(afterSave.destinations[0].scout, true);
    const tested = await fetch(
      `${baseUrl}/notifications/email/destinations/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alerts@example.com" }),
      },
    );
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).status, "accepted");
    const unknownTest = await fetch(
      `${baseUrl}/notifications/email/destinations/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "other@example.com" }),
      },
    );
    assert.equal(unknownTest.status, 404);
    assert.deepEqual(
      (await (await fetch(`${baseUrl}/notifications/providers`)).json())
        .providers,
      providers.providers,
    );

    for (const [route, method] of [
      ["/notifications/providers/slack", "PUT"],
      ["/notifications/providers/slack/secret", "GET"],
      ["/notifications/destinations", "POST"],
    ]) {
      assert.equal((await fetch(`${baseUrl}${route}`, { method })).status, 404);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("email destinations cannot be changed without SMTP", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/core/notifications/email/destinations`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destinations: [] }),
      },
    );
    assert.equal(response.status, 400);
    const testResponse = await fetch(
      `http://127.0.0.1:${address.port}/v1/core/notifications/email/destinations/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "operations@example.com" }),
      },
    );
    assert.equal(testResponse.status, 400);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Slack channels use runtime credentials and control-plane subscriptions", async () => {
  const server = createFixtureApiServer({ slackConfigured: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/core/notifications/slack/destinations`;
  try {
    const initial = (await (await fetch(endpoint)).json()).destinations[0];
    assert.equal(initial.channelId, "C12345678");
    const saved = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destinations: [
          {
            channelId: initial.channelId,
            deployments: false,
            deploymentFailures: false,
            backupsAndRestores: false,
            scout: true,
          },
        ],
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).destinations[0].id, initial.id);
    const tested = await fetch(`${endpoint}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: initial.channelId }),
    });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).status, "accepted");
    const unknown = await fetch(`${endpoint}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: "C99999999" }),
    });
    assert.equal(unknown.status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Slack channels cannot be changed without a bot token", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/core/notifications/slack/destinations`;
  try {
    assert.equal((await fetch(endpoint)).status, 200);
    assert.equal(
      (
        await fetch(endpoint, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinations: [] }),
        })
      ).status,
      400,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Discord webhook subscriptions are editable without exposing tokens", async () => {
  const server = createFixtureApiServer({ discordConfigured: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/core/notifications/discord/destinations`;
  try {
    const destinations = (await (await fetch(endpoint)).json()).destinations;
    assert.equal(destinations.length, 2);
    const initial = destinations[0];
    assert.equal(initial.webhookId, "123456789012345678");
    assert.equal(JSON.stringify(initial).includes("webhookToken"), false);
    assert.equal("enabled" in initial, false);
    const saved = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destinations: [
          {
            ...initial,
            deployments: false,
            alertsAndIncidents: true,
          },
          destinations[1],
        ],
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).destinations[0].deployments, false);
    const tested = await fetch(`${endpoint}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeId: initial.routeId }),
    });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).status, "accepted");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Discord subscriptions cannot be changed without a runtime webhook", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/core/notifications/discord/destinations`;
  try {
    assert.deepEqual((await (await fetch(endpoint)).json()).destinations, []);
    assert.equal(
      (
        await fetch(endpoint, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ destinations: [] }),
        })
      ).status,
      400,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("webhook push exposes only endpoint identity and saves subscriptions", async () => {
  const server = createFixtureApiServer({ webhookConfigured: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/core/notifications/webhook/destinations`;
  try {
    const destinations = (await (await fetch(endpoint)).json()).destinations;
    assert.equal(destinations.length, 2);
    assert.equal(destinations[0].label, "Operations");
    assert.equal(destinations[0].hostname, "hooks.example.com");
    assert.equal(JSON.stringify(destinations).includes("signingSecret"), false);
    assert.equal(JSON.stringify(destinations).includes("Authorization"), false);
    assert.equal(JSON.stringify(destinations).includes("/events"), false);
    const saved = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destinations: [
          { ...destinations[0], deployments: false },
          destinations[1],
        ],
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).destinations[0].deployments, false);
    const tested = await fetch(`${endpoint}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeId: destinations[0].routeId }),
    });
    assert.equal(tested.status, 200);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Telegram destinations support a main chat and multiple topics", async () => {
  const server = createFixtureApiServer({ telegramConfigured: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/core/notifications/telegram/destinations`;
  try {
    const [main] = (await (await fetch(endpoint)).json()).destinations;
    assert.equal(main.chatId, "-1001234567890");
    assert.equal(main.messageThreadId, null);
    const next = [
      { ...main, deployments: false },
      {
        chatId: main.chatId,
        messageThreadId: 42,
        deployments: true,
        deploymentFailures: false,
        backupsAndRestores: false,
        alertsAndIncidents: false,
      },
    ];
    const saved = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destinations: next }),
    });
    assert.equal(saved.status, 200);
    const destinations = (await saved.json()).destinations;
    assert.equal(destinations.length, 2);
    assert.equal(destinations[0].id, main.id);
    assert.equal(destinations[1].messageThreadId, 42);
    const tested = await fetch(`${endpoint}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: main.chatId, messageThreadId: 42 }),
    });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).status, "accepted");
    const duplicate = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destinations: [next[1], next[1]] }),
    });
    assert.equal(duplicate.status, 400);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Telegram destinations cannot be changed without a bot token", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/core/notifications/telegram/destinations`;
  try {
    assert.deepEqual((await (await fetch(endpoint)).json()).destinations, []);
    const saved = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destinations: [] }),
    });
    assert.equal(saved.status, 400);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture permits credentialed CORS only from exact web fixture origins", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const origin of [
      "http://127.0.0.1:4021",
      "http://[::1]:4021",
      "http://localhost:4021",
    ]) {
      const response = await fetch(`${baseUrl}/v1/core/session`, {
        headers: { origin },
      });
      assert.equal(response.status, 200, origin);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.equal(
        response.headers.get("access-control-allow-credentials"),
        "true",
      );
      assert.match(response.headers.get("vary") ?? "", /\bOrigin\b/u);
    }

    const toolingResponse = await fetch(`${baseUrl}/v1/core/session`);
    assert.equal(toolingResponse.status, 200);
    assert.equal(
      toolingResponse.headers.get("access-control-allow-origin"),
      null,
    );
    assert.equal(
      toolingResponse.headers.get("access-control-allow-credentials"),
      null,
    );
    assert.match(toolingResponse.headers.get("vary") ?? "", /\bOrigin\b/u);

    const preflight = await fetch(`${baseUrl}/v1/core/session`, {
      headers: { origin: "http://localhost:4021" },
      method: "OPTIONS",
    });
    assert.equal(preflight.status, 204);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture rejects disallowed origins before state changes", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const route = `/v1/core/apps/${fixtureIds.app}/auto-deploy-control`;

  try {
    const beforeResponse = await fetch(`${baseUrl}${route}`);
    assert.equal(beforeResponse.status, 200);
    const before = await beforeResponse.json();

    for (const origin of [
      "null",
      "http://localhost:4022",
      "http://localhost.evil.example:4021",
      "http://localhost:4021@evil.example",
      "not-an-origin",
    ]) {
      const response = await fetch(`${baseUrl}${route}`, {
        body: JSON.stringify({ paused: !before.autoDeploy.paused }),
        headers: { "content-type": "application/json", origin },
        method: "PATCH",
      });
      assert.equal(response.status, 403, origin);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        null,
        origin,
      );
      assert.equal(
        response.headers.get("access-control-allow-credentials"),
        null,
        origin,
      );
    }

    const preflight = await fetch(`${baseUrl}${route}`, {
      headers: { origin: "https://attacker.example" },
      method: "OPTIONS",
    });
    assert.equal(preflight.status, 403);

    const afterResponse = await fetch(`${baseUrl}${route}`);
    assert.equal(afterResponse.status, 200);
    const after = await afterResponse.json();
    assert.equal(after.autoDeploy.paused, before.autoDeploy.paused);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("runtime integrations expose safe details without credentials or mutations", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/v1/core`;
  try {
    const state = await (await fetch(`${base}/integrations`)).json();
    assert(state.integrations.some((item) => item.provider === "github"));
    assert(state.integrations.some((item) => item.provider === "aws"));
    assert(
      state.integrations.every(
        (item) =>
          Object.keys(item).sort().join(",") === "category,details,provider",
      ),
    );
    for (const integration of state.integrations) {
      assert(Array.isArray(integration.details));
      for (const detail of integration.details) {
        assert.deepEqual(Object.keys(detail).sort(), ["label", "value"]);
        assert.equal(typeof detail.label, "string");
        assert.equal(typeof detail.value, "string");
      }
    }
    assert.deepEqual(
      state.integrations.find((item) => item.provider === "aws").details,
      [{ label: "Region", value: "us-east-1" }],
    );
    assert.deepEqual(
      state.integrations.find((item) => item.provider === "doppler").details,
      [],
    );
    assert.equal(
      (await fetch(`${base}/integrations`, { method: "POST" })).status,
      404,
    );
    assert.equal((await fetch(`${base}/aws`)).status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GitHub uses environment configuration and a dynamic installation", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1/core/github`;

  try {
    const initial = await (await fetch(baseUrl)).json();
    assert.deepEqual(initial.configuration, {
      appId: "123456",
      appSlug: "towbar-fixture",
      source: "environment",
    });
    assert.equal(initial.connection, null);
    assert.equal((await fetch(`${baseUrl}/configuration`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/configuration/secrets`)).status, 404);

    const installationResponse = await fetch(
      `${baseUrl}/actions/installation-url`,
      {
        headers: { origin: "http://localhost:4021" },
        method: "POST",
      },
    );
    assert.equal(installationResponse.status, 200);
    const installationUrl = new URL((await installationResponse.json()).url);
    const reconnected = await fetch(
      `${baseUrl}/actions/complete-installation`,
      {
        body: JSON.stringify({
          installationId: installationUrl.searchParams.get("installation_id"),
          state: installationUrl.searchParams.get("state"),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    assert.equal(reconnected.status, 201);
    assert.equal(
      (await (await fetch(baseUrl)).json()).connection.accountLogin,
      "example-inc",
    );

    assert.equal((await fetch(baseUrl, { method: "DELETE" })).status, 204);
    const disconnected = await (await fetch(baseUrl)).json();
    assert(disconnected.connection.suspendedAt);
    assert.equal(disconnected.connections.length, 1);
    assert.equal(disconnected.configuration.source, "environment");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GitLab OAuth is the only mutable GitLab authorization", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/v1/core`;
  try {
    const before = await (await fetch(`${base}/gitlab/connections`)).json();
    assert.equal(before.connections.length, 1);
    assert.equal(before.connections[0].verificationStatus, "verified");

    const start = await fetch(`${base}/gitlab/oauth/start`, {
      headers: { origin: "http://localhost:4021" },
      method: "POST",
    });
    assert.equal(start.status, 200);
    assert.equal(
      new URL((await start.json()).authorizationUrl).pathname,
      "/manage/integrations/gitlab",
    );

    assert.equal(
      (await fetch(`${base}/gitlab/oauth/connection`, { method: "DELETE" }))
        .status,
      204,
    );
    const after = await (await fetch(`${base}/gitlab/connections`)).json();
    assert.equal(after.connections.length, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture separates control-plane checks from server capacity", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/core/system-health/actions/check`,
      { method: "POST" },
    );
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.deepEqual(
      health.checks.map((check) => check.id),
      ["api-database", "temporal", "worker"],
    );
    assert.equal("runtimeCapacity" in health, false);
    const capacityResponse = await fetch(
      `http://127.0.0.1:${address.port}/v1/core/servers/${fixtureIds.server}/capacity`,
    );
    assert.equal(capacityResponse.status, 200);
    const { capacity } = await capacityResponse.json();
    assert.equal(capacity.id, fixtureIds.server);
    assert.equal(capacity.runtimes.length > 0, true);
    const sourceCapacityResponse = await fetch(
      `http://127.0.0.1:${address.port}/v1/core/sources/${fixtureIds.source}/capacity`,
    );
    assert.equal(sourceCapacityResponse.status, 200);
    const { capacities } = await sourceCapacityResponse.json();
    assert.equal(capacities.length, 8);
    assert.equal(
      capacities.some((item) =>
        item.runtimes.some((runtime) => runtime.id === fixtureIds.app),
      ),
      true,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture covers every authenticated page read contract", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    for (const route of readRoutes) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get("content-type") ?? "", /json/, route);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture supports automatic deployment control edits", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(
      `${baseUrl}/v1/core/apps/${fixtureIds.app}/auto-deploy-control`,
      {
        body: JSON.stringify({
          paused: true,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.autoDeploy.paused, true);
    assert.equal(result.autoDeploy.effective.paused, true);
    assert.equal(result.autoDeploy.effective.scope, "deployable");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture supports write-only stage edits and rejects stale revisions", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const endpoint = `${baseUrl}/v1/core/apps/${fixtureIds.app}/secrets`;
    const initial = await (await fetch(endpoint)).json();
    const binding = initial.bindings.find(
      (item) => item.stage === "deployment",
    );
    assert(binding);
    const body = JSON.stringify({
      expectedRevision: binding.revision,
      set: { TEST_TOKEN: "must-not-return" },
      delete: [],
    });
    const request = {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    };
    const updated = await fetch(`${endpoint}/production/deployment`, request);
    assert.equal(updated.status, 200);
    assert.equal((await updated.text()).includes("must-not-return"), false);
    assert.equal(
      (await fetch(`${endpoint}/production/deployment`, request)).status,
      409,
    );
    assert.equal(
      (await fetch(`${endpoint}/reveal`, { method: "POST" })).status,
      404,
    );
    const preview = await (
      await fetch(`${endpoint}?environment=preview`)
    ).json();
    assert(preview.bindings.every((item) => item.environment === "preview"));
    const previewBuild = preview.bindings.find(
      (item) => item.stage === "build",
    );
    assert.deepEqual(previewBuild.inheritedKeys, []);
    assert.deepEqual(previewBuild.availableReferences, {
      globals: ["GLOBAL_PACKAGE_TOKEN"],
    });
    const revealed = await fetch(`${endpoint}/production/deployment/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "TEST_TOKEN" }),
    });
    assert.equal(revealed.status, 200);
    assert.equal(revealed.headers.get("cache-control"), "no-store");
    assert.equal((await revealed.json()).value, "must-not-return");

    const globalEndpoint = `${baseUrl}/v1/core/settings/secrets`;
    const global = await (await fetch(globalEndpoint)).json();
    const globalBuild = global.bindings.find((item) => item.stage === "build");
    const globalUpdate = await fetch(`${globalEndpoint}/production/build`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: globalBuild.revision,
        set: { GLOBAL_WRITE_ONLY: "must-also-not-return" },
        delete: [],
      }),
    });
    assert.equal(globalUpdate.status, 200);
    assert.equal(
      (await globalUpdate.text()).includes("must-also-not-return"),
      false,
    );
    const sharedAcrossTargets = await (
      await fetch(`${globalEndpoint}?environment=preview`)
    ).json();
    assert.deepEqual(sharedAcrossTargets.environments, ["production"]);
    assert(
      sharedAcrossTargets.bindings
        .find((item) => item.stage === "build")
        .keys.includes("GLOBAL_WRITE_ONLY"),
    );
    const currentBuild = sharedAcrossTargets.bindings.find(
      (item) => item.stage === "build",
    );
    const deleted = await fetch(`${globalEndpoint}/preview/build`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: currentBuild.revision,
        set: {},
        delete: ["GLOBAL_WRITE_ONLY"],
      }),
    });
    assert.equal(deleted.status, 200);
    const afterDelete = await (await fetch(globalEndpoint)).json();
    assert.equal(
      afterDelete.bindings
        .find((item) => item.stage === "build")
        .keys.includes("GLOBAL_WRITE_ONLY"),
      false,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture supports workspace server creation, editing, and safe removal", async () => {
  const fixture = createFixtureApiServer();
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
  const config = {
    buildConcurrency: 2,
    previewBuildConcurrency: 1,
    ip: "192.0.2.50",
    ssh: { port: 22, username: "deploy" },
  };

  try {
    const createdResponse = await fetch(`${baseUrl}/v1/core/servers`, {
      body: JSON.stringify(config),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).server;
    assert.equal(created.canonicalIp, config.ip);
    assert.equal("sourceId" in created, false);
    assert.equal(
      (await (await fetch(`${baseUrl}/v1/core/servers/${created.id}`)).json())
        .canRemoveServer,
      true,
    );
    assert.equal(
      (
        await (
          await fetch(`${baseUrl}/v1/core/servers/${fixtureIds.server}`)
        ).json()
      ).canRemoveServer,
      true,
    );

    const duplicate = await fetch(`${baseUrl}/v1/core/servers`, {
      body: JSON.stringify(config),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(duplicate.status, 409);

    const updatedResponse = await fetch(
      `${baseUrl}/v1/core/servers/${created.id}`,
      {
        body: JSON.stringify({
          ...config,
          buildConcurrency: 4,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    assert.equal(updatedResponse.status, 200);
    const updated = (await updatedResponse.json()).server;
    assert.equal(updated.config.buildConcurrency, 4);

    assert.equal(
      (
        await fetch(`${baseUrl}/v1/core/servers/${created.id}`, {
          method: "DELETE",
        })
      ).status,
      204,
    );
    assert.equal(
      (await fetch(`${baseUrl}/v1/core/servers/${created.id}`)).status,
      404,
    );
  } finally {
    fixture.close();
    await once(fixture, "close");
  }
});

test("the local fixture covers deployment trigger presentation", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/core/apps/${fixtureIds.app}/deployments`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    const triggers = new Set(
      payload.deployments.map((deployment) => deployment.trigger),
    );
    assert.deepEqual([...triggers].sort(), [
      "auto_deploy",
      "manual",
      "rollback",
    ]);
    assert.equal(
      payload.deployments.some((deployment) => "requestedBy" in deployment),
      false,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture covers retained backups from multiple Resources", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/core/sources/${fixtureIds.source}/backups`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.backups.length, 10);
    assert.equal(
      payload.backups.some(
        (backup) => backup.resourceId === fixtureIds.resource,
      ),
      true,
    );
    assert.equal(
      payload.backups.some(
        (backup) => backup.resourceId === fixtureIds.secondaryPostgres,
      ),
      true,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture ranks workspace advisories by severity with affected apps", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(
      `${baseUrl}/v1/core/monitoring/vulnerabilities?limit=100`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert(payload.findings.length >= 12);
    assert.equal(payload.nextPage, null);
    assert.equal(payload.findings[0].advisoryId, "CVE-2026-21001");
    assert.equal(payload.findings[0].severity, "critical");
    assert.equal(payload.findings[0].packageName, "openssl");
    assert(
      payload.findings.some(
        (finding) =>
          finding.advisoryId === "CVE-2026-12001" &&
          finding.appName === "Example Website" &&
          finding.scanState === "stale",
      ),
    );
    assert(
      payload.findings.some((finding) => finding.appName === "Towbar API"),
    );
    assert.equal(payload.findings.at(-1).severity, "low");
    assert(payload.summary.critical >= 4);
    assert(payload.summary.scansWithFindings >= 2);
    assert(payload.summary.cleanScans >= 1);

    const criticalOnly = await fetch(
      `${baseUrl}/v1/core/monitoring/vulnerabilities?severity=critical`,
    ).then((item) => item.json());
    assert.equal(criticalOnly.findings.length, payload.summary.critical);
    assert.equal(
      criticalOnly.findings.every((finding) => finding.severity === "critical"),
      true,
    );
    assert.equal(criticalOnly.summary.critical, payload.summary.critical);

    const appScoped = await fetch(
      `${baseUrl}/v1/core/monitoring/vulnerabilities?appId=${fixtureIds.app}`,
    ).then((item) => item.json());
    assert.equal(appScoped.findings.length, 2);
    assert.equal(
      appScoped.findings.every(
        (finding) => finding.appName === "Example Website",
      ),
      true,
    );
    assert.equal(appScoped.summary.high, 1);
    assert.equal(appScoped.summary.scansWithFindings, 0);

    const paged = await fetch(
      `${baseUrl}/v1/core/monitoring/vulnerabilities?limit=5`,
    ).then((item) => item.json());
    assert.equal(paged.findings.length, 5);
    assert.equal(paged.nextPage, 2);

    const towbarApiDeployment = payload.findings.find(
      (finding) => finding.appName === "Towbar API",
    ).deploymentId;
    const findings = await fetch(
      `${baseUrl}/v1/core/deployments/${towbarApiDeployment}/vulnerability-scan/findings`,
    ).then((item) => item.json());
    assert.equal(findings.findings.length, 5);
    assert.equal(
      findings.findings.some((finding) => finding.severity === "critical"),
      true,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture exposes only non-secret Resource connection metadata", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/core/resources/${fixtureIds.resource}`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(
      payload.resource.config.container.networkAlias,
      "primary-postgres",
    );
    assert.equal(payload.resource.config.access.sshTunnel.hostPort, 15_432);
    assert.deepEqual(payload.resource.serverSsh, {
      port: 22,
      username: "ubuntu",
    });
    assert.equal(JSON.stringify(payload).includes("privateKey"), false);
    assert.equal(JSON.stringify(payload).includes("secrets.login"), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture covers runtime controls and log capture", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const [action, type] of [
      ["start", "start"],
      ["restart", "restart"],
      ["stop", "stop"],
      ["logs", "capture_logs"],
    ]) {
      const response = await fetch(
        `${baseUrl}/v1/core/apps/${fixtureIds.app}/actions/${action}`,
        {
          headers: { "idempotency-key": crypto.randomUUID() },
          method: "POST",
        },
      );
      assert.equal(response.status, 202, action);
      const payload = await response.json();
      assert.equal(payload.operation.type, type, action);
    }

    const operationsResponse = await fetch(
      `${baseUrl}/v1/core/apps/${fixtureIds.app}/operations`,
    );
    const operationsPayload = await operationsResponse.json();
    assert.equal(operationsPayload.operations[0].type, "capture_logs");
    assert.match(operationsPayload.operations[0].result.logs, /Health check/u);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture paginates server checks newest first", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/checks?page=2&limit=1`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.pagination, {
      limit: 1,
      page: 2,
      total: 2,
      totalPages: 2,
    });
    assert.equal(payload.checks.length, 1);
    assert.notEqual(payload.checks[0].id, payload.latestCheck.id);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture covers first-connection host-key trust", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const checksResponse = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/checks`,
    );
    const checksPayload = await checksResponse.json();
    const untrustedCheck = checksPayload.checks.find(
      (check) => check.errorCode === "HOST_KEY_NOT_TRUSTED",
    );
    assert.equal(
      untrustedCheck.result.discoveredHostKeys[0].fingerprint,
      "SHA256:TowbarFixtureHostKey",
    );

    const trustResponse = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/host-keys/actions/trust`,
      { method: "POST" },
    );
    assert.equal(trustResponse.status, 201);

    const keysResponse = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/host-keys`,
    );
    const keysPayload = await keysResponse.json();
    assert.equal(
      keysPayload.hostKeys[0].fingerprint,
      "SHA256:TowbarFixtureHostKey",
    );

    const revokeResponse = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/host-keys/${keysPayload.hostKeys[0].id}`,
      { method: "DELETE" },
    );
    assert.equal(revokeResponse.status, 204);

    const revokedKeysResponse = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/host-keys`,
    );
    const revokedKeysPayload = await revokedKeysResponse.json();
    assert.deepEqual(revokedKeysPayload.hostKeys, []);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("SSH private keys are saved only after connection verification", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const credentialsPath = `/v1/core/servers/${fixtureIds.server}/credentials`;
  const verificationPath = `${credentialsPath}/actions/verify-private-key`;
  const privateKey = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "fixture-private-key-material-that-is-long-enough-for-validation",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");

  try {
    const createKeyResponse = await fetch(
      `${baseUrl}/v1/core/settings/private-keys`,
      {
        body: JSON.stringify({
          description: "Fixture verification key",
          mode: "manual",
          name: "Fixture key",
          privateKey,
          publicKey: null,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    assert.equal(createKeyResponse.status, 201);
    const privateKeyId = (await createKeyResponse.json()).privateKey.id;
    const before = await (await fetch(baseUrl + credentialsPath)).json();
    assert.equal(before.credential.keys.includes("privateKey"), false);

    const untrustedResponse = await fetch(baseUrl + verificationPath, {
      body: JSON.stringify({
        expectedRevision: before.credential.revision,
        privateKeyId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(untrustedResponse.status, 202);
    const untrusted = (await untrustedResponse.json()).verification;
    assert.equal(untrusted.status, "failed");
    assert.equal(untrusted.errorCode, "HOST_KEY_NOT_TRUSTED");
    assert.equal(
      untrusted.result.discoveredHostKeys[0].fingerprint,
      "SHA256:TowbarFixtureHostKey",
    );
    const stillUnconfigured = await (
      await fetch(baseUrl + credentialsPath)
    ).json();
    assert.equal(
      stillUnconfigured.credential.keys.includes("privateKey"),
      false,
    );
    assert.equal(
      stillUnconfigured.credential.revision,
      before.credential.revision,
    );

    const trustResponse = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/host-keys/actions/trust`,
      { method: "POST" },
    );
    assert.equal(trustResponse.status, 201);

    const verifiedResponse = await fetch(baseUrl + verificationPath, {
      body: JSON.stringify({
        expectedRevision: before.credential.revision,
        privateKeyId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(verifiedResponse.status, 202);
    const verified = (await verifiedResponse.json()).verification;
    assert.equal(verified.status, "succeeded");
    const readback = await fetch(
      `${baseUrl}${credentialsPath}/verifications/${verified.id}`,
    );
    assert.equal(readback.status, 200);
    assert.equal((await readback.json()).verification.status, "succeeded");

    const saved = await (await fetch(baseUrl + credentialsPath)).json();
    assert.equal(saved.credential.keys.includes("privateKey"), true);
    assert.notEqual(saved.credential.revision, before.credential.revision);

    const removeResponse = await fetch(baseUrl + credentialsPath, {
      body: JSON.stringify({
        expectedRevision: saved.credential.revision,
        set: {},
        delete: ["privateKey"],
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    assert.equal(removeResponse.status, 200);
    const removed = await removeResponse.json();
    assert.equal(removed.credential.keys.includes("privateKey"), false);
    const hostKeys = await (
      await fetch(`${baseUrl}/v1/core/servers/${fixtureIds.server}/host-keys`)
    ).json();
    assert.deepEqual(hostKeys.hostKeys, []);
    assert.equal(
      (await fetch(`${baseUrl}${credentialsPath}/verifications/${verified.id}`))
        .status,
      404,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the local fixture covers server preparation and deployable readiness", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/host-keys/actions/trust`,
      { method: "POST" },
    );
    const response = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/actions/prepare`,
      { method: "POST" },
    );
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.preparation.status, "queued");
    assert.deepEqual(
      payload.preparation.steps.map((step) => step.id),
      [
        "connecting",
        "inspecting",
        "installing_prerequisites",
        "installing_docker",
        "installing_caddy",
        "installing_log_collector",
        "configuring_access",
        "verifying",
      ],
    );

    let preparation = payload.preparation;
    for (
      let poll = 0;
      poll < 10 && preparation.status !== "succeeded";
      poll += 1
    ) {
      const preparationResponse = await fetch(
        `${baseUrl}/v1/core/servers/${fixtureIds.server}/preparations`,
      );
      assert.equal(preparationResponse.status, 200);
      const preparationPayload = await preparationResponse.json();
      preparation = preparationPayload.preparations[0];
    }
    assert.equal(preparation.status, "succeeded");
    assert.ok(preparation.steps.every((step) => step.log?.length > 0));
    assert.match(preparation.steps[0].message, /Production servers/);
    assert.equal(
      preparation.steps.every((step) => step.status === "succeeded"),
      true,
    );
    const checksResponse = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}/checks`,
    );
    const checksPayload = await checksResponse.json();
    assert.equal(checksPayload.latestCheck.status, "queued");
    assert.ok(
      Date.parse(checksPayload.latestCheck.createdAt) >
        Date.parse(preparation.createdAt),
    );

    const serverResponse = await fetch(
      `${baseUrl}/v1/core/servers/${fixtureIds.server}`,
    );
    const serverPayload = await serverResponse.json();
    assert.equal(serverPayload.server.setupStatus, "ready");

    const resourceResponse = await fetch(
      `${baseUrl}/v1/core/resources/${fixtureIds.resource}`,
    );
    const resourcePayload = await resourceResponse.json();
    assert.equal(resourcePayload.resource.serverReady, true);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("deployment history paginates all apps, resources, and environments in stable newest-first order", async () => {
  const fixture = createFixtureApiServer();
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
  async function readPage(page) {
    const response = await fetch(
      `${baseUrl}/v1/core/deployments/history?page=${page}&limit=10`,
    );
    assert.equal(response.status, 200);
    return response.json();
  }
  try {
    const first = await readPage(1);
    assert.equal(first.deployments.length, 10);
    assert.equal(first.pagination.page, 1);
    assert.equal(first.pagination.limit, 10);
    assert(first.pagination.totalPages > 1);
    const items = [...first.deployments];
    for (let page = 2; page <= first.pagination.totalPages; page++) {
      const next = await readPage(page);
      assert.equal(next.pagination.page, page);
      assert(next.deployments.length <= 10);
      items.push(...next.deployments);
    }
    assert.equal(items.length, first.pagination.total);
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    assert(items.some((item) => item.deployableKind === "app"));
    assert(items.some((item) => item.deployableKind !== "app"));
    assert(items.some((item) => item.environment === "preview"));
    assert(items.some((item) => item.environment === "production"));
    assert(
      items.every(
        (item) =>
          item.deployableName && item.deployableName !== "Unknown workload",
      ),
    );
    assert.deepEqual(
      items.map((item) => item.id),
      [...items]
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id),
        )
        .map((item) => item.id),
    );
    assert.deepEqual(
      (await readPage(first.pagination.totalPages + 1)).deployments,
      [],
    );
    const operational = await (
      await fetch(`${baseUrl}/v1/core/deployments`)
    ).json();
    assert(
      operational.deployments.every(
        (item) => item.environment === "production",
      ),
    );
  } finally {
    fixture.close();
    await once(fixture, "close");
  }
});

test("repository sync history has scoped, selectable recent and legacy entries", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1/core/sources`;
  try {
    const { syncs } = await (
      await fetch(`${baseUrl}/${fixtureIds.source}/syncs`)
    ).json();
    assert.deepEqual(
      syncs.map((sync) => sync.id),
      [fixtureIds.sync, fixtureIds.previousSync, fixtureIds.legacySync],
    );
    assert.deepEqual(
      syncs.map((sync) => sync.environment?.name ?? null),
      ["production", "staging", null],
    );
    assert(Date.parse(syncs[0].createdAt) > Date.parse(syncs[1].createdAt));
    for (const sync of syncs) {
      const response = await fetch(
        `${baseUrl}/${fixtureIds.source}/syncs/${sync.id}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).sync, sync);
      assert.equal(
        (await fetch(`${baseUrl}/${fixtureIds.docsSource}/syncs/${sync.id}`))
          .status,
        404,
      );
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("fixture Sources have distinct inventories and working scoped routes", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const { sources } = await (
      await fetch(`${baseUrl}/v1/core/sources`)
    ).json();
    assert.equal(sources.length, 4);
    const expected = new Map([
      [fixtureIds.source, [12, 10, 8]],
      [fixtureIds.docsSource, [4, 0, 2]],
      [fixtureIds.analyticsSource, [6, 1, 4]],
      [fixtureIds.sandboxSource, [0, 0, 0]],
    ]);
    for (const source of sources) {
      const path = `${baseUrl}/v1/core/sources/${source.id}`;
      for (const child of [
        "",
        "/environments",
        "/syncs",
        "/capacity",
        "/deployments",
      ]) {
        assert.equal((await fetch(path + child)).status, 200, path + child);
      }
      assert.equal((await fetch(`${path}/manifest`)).status, 404);
      const { environments } = await (
        await fetch(`${path}/environments`)
      ).json();
      for (const environment of environments) {
        const { manifest } = await (
          await fetch(`${path}/environments/${environment.id}/manifest`)
        ).json();
        const resolved = resolveRepositoryEnvironment({
          root: manifest.files[0].content,
          files: manifest.files.slice(1),
          environment: environment.name,
          branch: environment.branch,
        });
        assert.equal(resolved.manifest.environment, environment.name);
        assert.match(manifest.files[0].content, /^version: 2/);
        assert.equal(manifest.files[0].path, "towbar.yml");
        assert(manifest.files.length > 1);
        assert(
          manifest.files
            .slice(1)
            .every((file) => file.path.startsWith(".towbar/")),
        );
      }
      assert.equal(
        (
          await fetch(
            `${path}/environments/00000000-0000-4000-8000-000000000000/manifest`,
          )
        ).status,
        404,
      );
      const { apps } = await (await fetch(`${path}/apps`)).json();
      const { resources } = await (await fetch(`${path}/resources`)).json();
      assert(
        [...apps, ...resources].every((item) => item.sourceId === source.id),
      );
      assert.deepEqual(
        [
          apps.length,
          resources.length,
          new Set([...apps, ...resources].map((item) => item.serverIp)).size,
        ],
        expected.get(source.id),
      );
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("v2 fixtures expose environment mappings and isolated sibling instances", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const get = async (path) => {
    const response = await fetch(baseUrl + path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  try {
    const { environments } = await get(
      `/v1/core/sources/${fixtureIds.source}/environments`,
    );
    assert.deepEqual(
      environments.map(({ name, branch }) => [name, branch]),
      [
        ["production", "main"],
        ["staging", "develop"],
      ],
    );
    for (const [kind, productionId, stagingId] of [
      ["apps", fixtureIds.app, fixtureIds.stagingApp],
      ["resources", fixtureIds.resource, fixtureIds.stagingResource],
    ]) {
      const items = (
        await get(`/v1/core/sources/${fixtureIds.source}/${kind}`)
      )[kind];
      const production = items.find((item) => item.id === productionId);
      const staging = items.find((item) => item.id === stagingId);
      assert.equal(production.entityId, staging.entityId);
      assert.notEqual(production.id, staging.id);
      assert.equal(production.environment.name, "production");
      assert.equal(staging.environment.name, "staging");
      assert.equal(staging.environment.branch, "develop");
      const filtered = await get(`/v1/core/${kind}?environment=staging`);
      assert.deepEqual(
        filtered[kind].map((item) => item.id),
        [stagingId],
      );
    }
    const appInventory = await get("/v1/core/apps");
    const resourceInventory = await get("/v1/core/resources");
    assert.equal(appInventory.apps.length, 22);
    assert.equal(appInventory.counts.all, 21);
    assert.equal(
      appInventory.apps.find((app) => app.id === fixtureIds.faviconApp)?.config
        .domains?.primary,
      "www.wikipedia.org",
    );
    assert.equal(resourceInventory.resources.length, 11);
    assert.equal(resourceInventory.counts.all, 10);
    const history = await get(
      "/v1/core/deployments/history?targetEnvironment=staging&limit=1",
    );
    assert.deepEqual(history.environments, ["production", "staging"]);
    assert.equal(history.pagination.total, 2);
    assert.equal(history.pagination.totalPages, 2);
    assert.equal(history.deployments.length, 1);
    assert.equal(history.deployments[0].targetEnvironment.name, "staging");
    const missing = await get(
      "/v1/core/deployments/history?targetEnvironment=missing",
    );
    assert.equal(missing.pagination.total, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("source discovery uses v2 environments and unsupported mutations do not return read payloads", async () => {
  const server = createFixtureApiServer({ githubAppConnected: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const post = (path, body) =>
    fetch(baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const { connection } = await (
      await fetch(`${baseUrl}/v1/core/github`)
    ).json();
    const request = {
      githubInstallationId: connection.id,
      repositoryOwner: "example-inc",
      repositoryName: "example-service",
      discoveryBranch: "main",
    };
    const discovery = await post("/v1/core/sources/discover", request);
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json()).environments, [
      { name: "production", previewsEnabled: false },
      { name: "staging", previewsEnabled: true },
    ]);
    assert.equal(
      (
        await post("/v1/core/sources/discover", {
          ...request,
          discoveryBranch: "missing",
        })
      ).status,
      404,
    );
    assert.equal((await post("/v1/core/sources", request)).status, 404);
    assert.equal(
      (
        await fetch(
          `${baseUrl}/v1/core/sources/${fixtureIds.source}/environments`,
          { method: "PATCH" },
        )
      ).status,
      404,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("connecting a selected environment persists isolated instances without deployment", async () => {
  const server = createFixtureApiServer({ githubAppConnected: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/v1/core`;
  const get = async (path) => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const connect = (body) =>
    fetch(base + "/sources/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const { connection } = await get("/github");
    const request = {
      githubInstallationId: connection.id,
      repositoryOwner: "example-inc",
      repositoryName: "example-service",
      environments: [{ environment: "staging", branch: "develop" }],
    };
    const before = await get("/sources");
    for (const invalid of [
      null,
      { ...request, environments: [] },
      {
        ...request,
        environments: [{ environment: "staging", branch: "missing" }],
      },
    ])
      assert.equal((await connect(invalid)).status, 400);
    assert.deepEqual(await get("/sources"), before);
    const response = await connect(request);
    assert.equal(response.status, 201);
    const { source, syncs } = await response.json();
    assert.equal(syncs.length, 1);
    assert.equal(syncs[0].environment, "staging");
    assert.equal(syncs[0].error, null);
    assert.deepEqual((await get(`/sources/${source.id}`)).source, source);
    const { environments } = await get(`/sources/${source.id}/environments`);
    assert.equal(environments.length, 1);
    assert.equal(environments[0].branch, "develop");
    for (const kind of ["apps", "resources"]) {
      const instances = (await get(`/sources/${source.id}/${kind}`))[kind];
      assert.equal(instances.length, 1);
      assert.equal(instances[0].environment.name, "staging");
      assert.equal(instances[0].sourceId, source.id);
      assert.equal(instances[0].runtimeState.observedContainerName, null);
      assert.equal(instances[0].runtimeState.observedState, "unknown");
      assert.ok(
        (await get(`/${kind}`))[kind].some(
          (item) => item.id === instances[0].id,
        ),
      );
    }
    assert.deepEqual(
      (await get(`/sources/${source.id}/deployments`)).deployments,
      [],
    );
    assert.equal((await connect(request)).status, 400);
    assert.equal(
      (await get(`/sources/${source.id}/environments`)).environments.length,
      1,
    );
    const endpoint = `/sources/${source.id}/environments`;
    const mutate = (method, path, body) =>
      fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const original = (await get(`/sources/${source.id}/apps`)).apps[0];
    const initialHistory = (await get(`/sources/${source.id}/syncs`)).syncs;
    assert.deepEqual(
      (await get(`/sources/${source.id}/syncs/${initialHistory[0].id}`)).sync,
      initialHistory[0],
    );
    assert.equal(
      (
        await fetch(
          `${base}/sources/${fixtureIds.source}/syncs/${initialHistory[0].id}`,
        )
      ).status,
      404,
    );
    let mapping = environments[0];
    const changed = await mutate("PATCH", `${endpoint}/${mapping.id}`, {
      branch: "main",
      expectedRevision: mapping.mappingRevision,
    });
    assert.equal(changed.status, 200);
    const saved = await changed.json();
    assert.equal(saved.sync.deployAfterSync, false);
    assert.notEqual(saved.environment.mappingRevision, mapping.mappingRevision);
    assert.equal(
      (
        await mutate("DELETE", `${endpoint}/${mapping.id}`, {
          expectedRevision: mapping.mappingRevision,
        })
      ).status,
      409,
    );
    mapping = saved.environment;
    const missingBranch = await mutate("PATCH", `${endpoint}/${mapping.id}`, {
      branch: "missing",
      expectedRevision: mapping.mappingRevision,
    });
    assert.equal(missingBranch.status, 400);
    assert.equal(
      (await missingBranch.json()).error.message,
      "Branch was not found",
    );
    assert.equal((await get(endpoint)).environments[0].branch, "main");
    assert.deepEqual(
      (await get(`/sources/${source.id}/syncs`)).syncs.slice(1),
      initialHistory,
    );
    assert.equal(
      (
        await mutate("DELETE", `${endpoint}/${mapping.id}`, {
          expectedRevision: mapping.mappingRevision,
        })
      ).status,
      200,
    );
    assert.equal(
      (await mutate("POST", `${endpoint}/${mapping.id}/syncs`)).status,
      404,
    );
    assert.equal(
      (await get(`/sources/${source.id}/apps`)).apps[0].id,
      original.id,
    );
    const reconnected = await mutate("POST", endpoint, {
      environment: "staging",
      branch: "develop",
    });
    assert.equal(reconnected.status, 201);
    assert.equal((await reconnected.json()).environment.id, mapping.id);
    assert.equal(
      (await get(`/sources/${source.id}/apps`)).apps[0].id,
      original.id,
    );
    assert.equal(
      (await mutate("POST", `${endpoint}/${mapping.id}/syncs`)).status,
      202,
    );
    assert.equal(
      (
        await mutate("POST", endpoint, {
          environment: "production",
          branch: "main",
        })
      ).status,
      201,
    );
    const siblings = (await get(`/sources/${source.id}/apps`)).apps;
    assert.equal(siblings.length, 2);
    assert.notEqual(siblings[0].id, siblings[1].id);
    assert.equal(siblings[0].entityId, siblings[1].entityId);
    assert.deepEqual(
      (await get(`/sources/${source.id}/deployments`)).deployments,
      [],
    );
    assert.equal((await get(`/apps/${original.id}`)).app.id, original.id);
    assert.deepEqual(
      (await get(`/apps/${original.id}/deployments`)).deployments,
      [],
    );
    const secretEndpoint = `/apps/${original.id}/secrets`;
    const metadata = await get(secretEndpoint);
    assert.equal(metadata.environments[0], "staging");
    const runtime = metadata.bindings.find(
      (item) => item.stage === "deployment",
    );
    assert.equal(runtime.declared, true);
    const snapshot = (await get(`${endpoint}/${mapping.id}/manifest`)).manifest;
    const resolved = resolveRepositoryEnvironment({
      root: snapshot.files.find((file) => file.path === "towbar.yml").content,
      files: snapshot.files.filter((file) => file.path !== "towbar.yml"),
      environment: "staging",
      branch: "develop",
    }).manifest;
    assert.deepEqual(
      (await get(`/apps/${original.id}`)).app.config,
      resolved.apps[0],
    );
    assert.deepEqual(
      runtime.keys,
      resolved.requiredSecrets["app:service"].runtime,
    );
    assert.deepEqual(runtime.keys, ["DATABASE_URL"]);
    assert.deepEqual(runtime.missingKeys, ["DATABASE_URL"]);
    const valuePath = `${secretEndpoint}/staging/deployment`;
    const unset = await mutate("POST", `${valuePath}/reveal-all`, {});
    assert.equal(unset.headers.get("cache-control"), "no-store");
    assert.deepEqual((await unset.json()).values, {});
    const emptySaved = await mutate("PATCH", valuePath, {
      expectedRevision: null,
      set: { DATABASE_URL: "" },
    });
    assert.equal(emptySaved.status, 200);
    const { secret } = await emptySaved.json();
    assert.deepEqual(
      (await get(secretEndpoint)).bindings.find(
        (item) => item.stage === "deployment",
      ).missingKeys,
      [],
    );
    assert.deepEqual(
      (await (await mutate("POST", `${valuePath}/reveal-all`, {})).json())
        .values,
      { DATABASE_URL: "" },
    );
    assert.equal(
      (
        await mutate("PATCH", valuePath, {
          expectedRevision: null,
          set: { DATABASE_URL: "stale" },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await mutate("PATCH", valuePath, {
          expectedRevision: secret.revision,
          set: { UNDECLARED: "invalid" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await mutate("PATCH", valuePath, {
          expectedRevision: secret.revision,
          delete: ["DATABASE_URL"],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await mutate(
          "POST",
          `${secretEndpoint}/production/deployment/reveal-all`,
          {},
        )
      ).status,
      404,
    );
    const production = siblings.find(
      (item) => item.environment.name === "production",
    );
    assert.deepEqual(
      (await get(`/apps/${production.id}/secrets`)).bindings.find(
        (item) => item.stage === "deployment",
      ).missingKeys,
      ["DATABASE_URL"],
    );
    const database = (await get(`/sources/${source.id}/resources`))
      .resources[0];
    const resourceBindings = (await get(`/resources/${database.id}/secrets`))
      .bindings;
    assert.deepEqual(
      resourceBindings.map((item) => item.stage),
      ["deployment"],
    );
    assert.deepEqual(resourceBindings[0].missingKeys, ["POSTGRES_PASSWORD"]);
    assert.equal(
      (
        await mutate(
          "POST",
          `/resources/${database.id}/secrets/staging/build/reveal-all`,
          {},
        )
      ).status,
      404,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("scheduled jobs fixture records manual output and returns no jobs for unconfigured apps", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/v1/core/apps`;
  const appId = fixtureIds.storageApp;
  try {
    const jobs = await (await fetch(`${base}/${appId}/jobs`)).json();
    assert.equal(jobs.jobs[0].name, "daily-report");
    assert.equal(jobs.automationPaused, false);
    const response = await fetch(`${base}/${appId}/actions/run-job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "daily-report" }),
    });
    assert.equal(response.status, 202);
    const run = (await response.json()).operation;
    const refreshed = await (await fetch(`${base}/${appId}/jobs`)).json();
    assert.equal(
      refreshed.runs.find((item) => item.id === run.id).result.exitCode,
      0,
    );
    assert.match(run.result.logs, /Report generated/);
    assert.deepEqual(
      (await (await fetch(`${base}/${fixtureIds.app}/jobs`)).json()).jobs,
      [],
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("storage fixture exposes mounted app volumes without backup or restore actions", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const appUrl = `http://127.0.0.1:${address.port}/v1/core/apps/${fixtureIds.storageApp}`;

  try {
    const storageResponse = await fetch(`${appUrl}/storage`);
    assert.equal(storageResponse.status, 200);
    const storage = await storageResponse.json();

    assert.deepEqual(storage.volumes, [
      {
        mountPath: "/app/uploads",
        name: "uploads",
        status: "mounted",
        volumeName: `towbar-${fixtureIds.storageApp}-uploads`,
      },
    ]);
    assert.equal("backupPolicies" in storage, false);
    assert.equal("restoreTargets" in storage, false);
    assert.equal(
      (
        await fetch(`${appUrl}/actions/volume-backup`, {
          method: "POST",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${appUrl}/actions/volume-restore`, {
          method: "POST",
        })
      ).status,
      404,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("showcase inventory covers supported engines, build modes, provider hardware and connected histories", async (t) => {
  const {
    managedResourceCompatibility,
    managedResourceTypes,
    appDeploymentSchema,
    cloudInstanceSchema,
  } = await import("@workspace/towbar-core");
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const read = async (path) =>
    (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).json();
  const { apps } = await read("/v1/core/apps");
  const { resources } = await read("/v1/core/resources");
  const { servers } = await read("/v1/core/servers");
  assert.deepEqual(
    [...new Set(resources.map((item) => item.kind))].sort(),
    [...managedResourceTypes].sort(),
  );
  for (const item of resources) {
    const engine = managedResourceCompatibility[item.kind];
    assert.equal(item.config.image, engine.image);
    assert.equal(item.config.container.port, engine.port);
    assert.equal(item.config.container.volumes[0].mountPath, engine.volumePath);
    assert(item.config.backup?.schedule);
    const { backups } = await read(`/v1/core/sources/${item.sourceId}/backups`);
    assert(backups.some((backup) => backup.resourceId === item.id));
  }
  assert.equal(
    new Set(servers.map((item) => item.hardware?.instance?.provider)).size,
    8,
  );
  for (const item of servers) cloudInstanceSchema.parse(item.hardware.instance);
  assert(servers.every((item) => item.name));
  assert.equal(servers.filter((item) => item.scout?.enabled).length, 7);
  assert(apps.filter((item) => item.config.domains?.primary).length >= 15);
  const modes = new Set(
    apps.map((item) =>
      item.kind === "compose"
        ? "compose"
        : (item.config.deployment?.type ?? "dockerfile"),
    ),
  );
  assert.deepEqual([...modes].sort(), [
    "buildpack",
    "compose",
    "dockerfile",
    "image",
    "nixpacks",
    "railpack",
    "static",
  ]);
  for (const app of apps) {
    if (app.config.deployment) appDeploymentSchema.parse(app.config.deployment);
    const { deployments } = await read(`/v1/core/apps/${app.id}/deployments`);
    assert(deployments.length > 0, app.name);
    const { capacity } = await read(
      `/v1/core/servers/${app.serverId}/capacity`,
    );
    assert(capacity.runtimes.some((item) => item.id === app.id));
  }
});

test("GitHub account selection, source moves, and disconnect remain scoped", async () => {
  const readiness = {
    status: "available",
    contents: "read",
    deployments: "write",
    pullRequests: "write",
    preview: "ready",
  };
  const labs = {
    id: "b1111111-1111-4111-8111-111111111111",
    installationId: "12345678",
    accountLogin: "avgeek-labs",
    accountType: "Organization",
    suspendedAt: null,
    updatedAt: new Date().toISOString(),
    permissionReadiness: readiness,
  };
  const oss = {
    ...labs,
    id: "b2222222-2222-4222-8222-222222222222",
    installationId: "87654321",
    accountLogin: "avgeek-oss",
  };
  const repository = (account, id, name) => ({
    connectionId: account.id,
    id,
    owner: account.accountLogin,
    name,
    fullName: `${account.accountLogin}/${name}`,
    defaultBranch: "main",
    private: false,
  });
  const server = createFixtureApiServer({
    githubConnections: [labs, oss],
    githubRepositoryOptions: [
      repository(labs, "10002", "example-service"),
      repository(oss, "10001", "platform"),
      repository(oss, "10003", "docs"),
      {
        ...repository(labs, "10001", "platform"),
        owner: "example-inc",
        fullName: "example-inc/platform",
      },
    ],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/v1/core`;
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const sourcePath = `/sources/${fixtureIds.source}`;
  const original = await get(sourcePath);
  try {
    const accounts = await get("/github/installation");
    assert.equal(accounts.connections.length, 2);
    assert.equal(accounts.connection, null);
    assert.equal((await get("/github/repositories")).repositories.length, 4);
    assert.deepEqual(
      (
        await get(`/github/repositories?connectionId=${oss.id}`)
      ).repositories.map((item) => item.owner),
      ["avgeek-oss", "avgeek-oss"],
    );
    assert.equal(
      (
        await fetch(
          `${base}/github/branches?owner=avgeek-oss&repository=platform`,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await fetch(
          `${base}/github/branches?connectionId=${labs.id}&owner=avgeek-oss&repository=platform`,
        )
      ).status,
      404,
    );
    assert(
      (
        await get(
          `/github/branches?connectionId=${oss.id}&owner=avgeek-oss&repository=platform`,
        )
      ).branches.includes("main"),
    );
    const discovery = {
      provider: "github",
      githubInstallationId: oss.id,
      repositoryOwner: "avgeek-oss",
      repositoryName: "docs",
      discoveryBranch: "main",
    };
    assert.equal(
      (
        await post("/sources/discover", {
          ...discovery,
          githubInstallationId: labs.id,
        })
      ).status,
      404,
    );
    const discovered = await post("/sources/discover", discovery);
    assert.equal(discovered.status, 200);
    assert.equal((await discovered.json()).environments.length, 2);
    const connected = await post("/sources/connect", {
      provider: "github",
      githubInstallationId: labs.id,
      repositoryOwner: "avgeek-labs",
      repositoryName: "example-service",
      environments: [{ environment: "production", branch: "main" }],
    });
    assert.equal(connected.status, 201, await connected.clone().text());
    assert.equal(
      (await connected.json()).source.repositoryOwner,
      "avgeek-labs",
    );
    const history = await get(`${sourcePath}/syncs`);
    const input = {
      githubInstallationId: oss.id,
      repositoryOwner: "avgeek-oss",
      repositoryName: "platform",
    };
    assert.equal(
      (
        await post(`${sourcePath}/actions/change-github-connection`, {
          ...input,
          repositoryName: "docs",
        })
      ).status,
      409,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const moved = await post(
        `${sourcePath}/actions/change-github-connection`,
        input,
      );
      assert.equal(moved.status, 200, await moved.clone().text());
      assert.equal((await moved.json()).source.id, fixtureIds.source);
    }
    assert.deepEqual(await get(`${sourcePath}/syncs`), history);
    assert.equal(
      (
        await post(`${sourcePath}/actions/change-github-connection`, {
          githubInstallationId: labs.id,
          repositoryOwner: original.source.repositoryOwner,
          repositoryName: original.source.repositoryName,
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/github`, { method: "DELETE" })).status,
      409,
    );
    assert.equal(
      (
        await fetch(`${base}/github?connectionId=${labs.id}`, {
          method: "DELETE",
        })
      ).status,
      204,
    );
    assert.equal(
      (await get(`/github/repositories?connectionId=${oss.id}`)).repositories
        .length,
      2,
    );
    const state = await get("/github/installation");
    assert(state.connections.find((item) => item.id === labs.id).suspendedAt);
    assert.equal(
      state.connections.find((item) => item.id === oss.id).suspendedAt,
      null,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("notifications paginate unread history and mark read without clearing rows", async () => {
  const server = createFixtureApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/core/notifications`;
  try {
    const first = await (await fetch(`${endpoint}?limit=1`)).json();
    assert.equal(first.unreadCount, 2);
    assert.equal(first.notifications.length, 1);
    assert.equal(first.notifications[0].readAt, null);
    assert(first.nextCursor);
    const query = new URLSearchParams({ limit: "1", ...first.nextCursor });
    const second = await (await fetch(`${endpoint}?${query}`)).json();
    assert.equal(second.unreadCount, 2);
    assert.notEqual(second.notifications[0].id, first.notifications[0].id);
    assert.equal(second.nextCursor, null);
    const mark = () =>
      fetch(`${endpoint}/read-all`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    assert.equal((await mark()).status, 200);
    const read = await (await fetch(endpoint)).json();
    assert.equal(read.unreadCount, 0);
    assert.equal(read.notifications.length, 2);
    assert(read.notifications.every((item) => item.readAt));
    await mark();
    assert.deepEqual(
      (await (await fetch(endpoint)).json()).notifications,
      read.notifications,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});
