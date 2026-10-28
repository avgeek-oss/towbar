import assert from "node:assert/strict";
import test from "node:test";
import { manifestNotificationsSchema } from "@workspace/towbar-core";

import { getRuntimeNotifications } from "../../infrastructure/runtime-notifications.js";
import {
  manifestNotificationAppId,
  manifestNotificationLabels,
  manifestNotificationRoutes,
} from "./manifest-destinations.js";

const appId = "31111111-1111-4111-8111-222222222222";
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
      slack: { botToken: "xoxb-example-token-long-enough" },
    },
    routes: [],
  }),
});

void test("manifest deployment choices accept both and route as all", () => {
  const notifications = manifestNotificationsSchema.parse({
    email: [
      {
        address: "all@example.com",
        deployments: true,
        deploymentFailures: true,
        backupsAndRestores: false,
        alertsAndIncidents: false,
      },
      {
        address: "failures@example.com",
        deployments: false,
        deploymentFailures: true,
        backupsAndRestores: false,
        alertsAndIncidents: false,
      },
    ],
  });
  const routes = manifestNotificationRoutes(appId, notifications, runtime);
  assert.deepEqual(routes[0]?.categories, ["deployments"]);
  assert.deepEqual(routes[1]?.categories, ["deploymentFailures"]);
});

void test("routes manifest destinations through runtime credentials", () => {
  const notifications = {
    email: [
      {
        address: "ops@example.com",
        deployments: true,
        backupsAndRestores: false,
        alertsAndIncidents: false,
      },
    ],
    slack: [
      {
        channelId: "C12345678",
        deployments: false,
        backupsAndRestores: true,
        alertsAndIncidents: false,
      },
    ],
  };
  const routes = manifestNotificationRoutes(appId, notifications, runtime);
  assert.deepEqual(
    routes.map((route) => route.provider),
    ["smtp", "slack"],
  );
  assert.deepEqual(routes[1]?.categories, ["backups", "restores"]);
  assert.equal(
    routes[0]?.id,
    manifestNotificationRoutes(appId, notifications, runtime)[0]?.id,
  );
  assert.notEqual(
    routes[0]?.id,
    manifestNotificationRoutes(
      "31111111-1111-4111-8111-333333333333",
      notifications,
      runtime,
    )[0]?.id,
  );
  assert.deepEqual(
    manifestNotificationRoutes(appId, notifications, {
      providers: {},
      routes: [],
    }),
    [],
  );
  assert.equal(manifestNotificationAppId(routes[0]!.id), appId);
  assert.equal(manifestNotificationAppId("manifest-invalid"), null);
  const labels = manifestNotificationLabels(appId, notifications);
  assert.equal(labels.get(routes[0]!.id), "ops@example.com");
  assert.equal(labels.get(routes[1]!.id), "C12345678");
});
