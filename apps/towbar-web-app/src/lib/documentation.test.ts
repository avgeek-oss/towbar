import assert from "node:assert/strict";
import test from "node:test";
import { documentationTopic, headingDocumentation } from "./documentation";

void test("detail routes keep help scoped to the feature being viewed", () => {
  const cases = [
    ["/", "overview"],
    ["/conflicts", "conflicts"],
    ["/retirements", "retirements"],
    ["/repositories/repo/settings/danger", "repositoryRemoval"],
    ["/repositories/repo/syncs/sync/issues", "sync"],
    ["/services/app/deployments/deploy/progress", "progress"],
    [
      "/datastores/resource/deployments/deploy/vulnerabilities",
      "vulnerabilities",
    ],
    ["/services/app/compare-deployments", "comparison"],
    ["/services/app/domains", "domains"],
    ["/servers/server/settings/danger", "removal"],
    ["/servers/server/settings/monitoring", "scout"],
    ["/servers/server/preparation", "preparation"],
    ["/manage/integrations/telegram", "telegram"],
    ["/manage/integrations/gitlab", "gitlab"],
    ["/manage/integrations/registry", "registry"],
    ["/manage/integrations/infisical", "infisical"],
    ["/manage/integrations/doppler", "doppler"],
    ["/manage/integrations/r2", "r2"],
    ["/manage/integrations/cloudflare", "cloudflare"],
    ["/settings/email-password", "emailPassword"],
    ["/settings/passkeys", "security"],
    ["/team-settings/api-keys", "apiKeys"],
    ["/team-settings/audit-logs", "auditLogs"],
    ["/manage/integrations/deliveries", "deliveries"],
    ["/team-settings/ssh-keys", "keys"],
    ["/manage/ssh-keys", "keys"],
    ["/manage/shared-secrets", "secrets"],
    ["/team-settings/workspace-secrets", "secrets"],
    ["/repositories/repo/settings/secrets", "secrets"],
    ["/monitoring/incidents", "incidents"],
  ] as const;
  for (const [path, expected] of cases)
    assert.equal(documentationTopic(path), expected, path);
});

void test("reused widget titles resolve to the correct feature documentation", () => {
  const cases = [
    [
      "/manage/integrations/github",
      "Connection details",
      "/integrations/github",
    ],
    [
      "/datastores/db/connection",
      "Connection details",
      "/datastores#connect-privately",
    ],
    [
      "/services/app/compare-deployments",
      "CPU usage",
      "/deployment-comparisons",
    ],
    [
      "/servers/server/performance",
      "CPU usage",
      "/monitoring#performance-history",
    ],
    ["/datastores/db", "Current state", "/datastores"],
    ["/services/app", "Current state", "/services"],
    [
      "/manage/integrations/email",
      "Configuration",
      "/integrations/notifications/email",
    ],
    [
      "/manage/integrations/slack",
      "Credentials",
      "/integrations/notifications/slack",
    ],
    [
      "/repositories/repo/settings/danger",
      "Danger zone",
      "/repositories#delete-a-repository",
    ],
  ];
  for (const [path, title, expected] of cases) {
    const help = headingDocumentation(path!, title!, "widget");
    assert.ok(help, `${path}: ${title}`);
    assert.ok(help.href.endsWith(expected!), `${path}: ${title}`);
    assert.ok(help.description.length > 20);
  }
  assert.equal(
    headingDocumentation("/unknown", "Credentials", "widget"),
    undefined,
  );
  assert.equal(
    headingDocumentation("/services/app", "Unknown widget", "widget"),
    undefined,
  );
});
