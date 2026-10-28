import assert from "node:assert/strict";
import test from "node:test";

import { emailDestinationsSchema } from "./email-destinations.js";
import { slackDestinationsSchema } from "./slack-destinations.js";
import { webhookDestinationsSchema } from "./webhook-destinations.js";

void test("workspace destinations accept one deployment subscription at a time", () => {
  const cases = [
    [emailDestinationsSchema, { email: "ops@example.com", scout: false }],
    [slackDestinationsSchema, { channelId: "C12345678", scout: false }],
    [
      webhookDestinationsSchema,
      {
        routeId: "webhook-ops",
        label: "Operations",
        hostname: "hooks.example.com",
        alertsAndIncidents: false,
      },
    ],
  ] as const;
  for (const [schema, destination] of cases) {
    const base = { ...destination, backupsAndRestores: false };
    assert.equal(
      schema.safeParse({
        destinations: [
          { ...base, deployments: false, deploymentFailures: true },
        ],
      }).success,
      true,
    );
    assert.equal(
      schema.safeParse({
        destinations: [
          { ...base, deployments: true, deploymentFailures: true },
        ],
      }).success,
      false,
    );
  }
});
