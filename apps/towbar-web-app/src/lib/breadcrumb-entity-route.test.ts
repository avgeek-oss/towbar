import assert from "node:assert/strict";
import test from "node:test";

import { breadcrumbEntityHref } from "./breadcrumb-entity-route";

test("switching services retains analytics and nested settings", () => {
  for (const section of [
    "analytics",
    "performance",
    "settings/secrets",
    "logs",
  ]) {
    assert.equal(
      breadcrumbEntityHref({
        kind: "apps",
        currentId: "current",
        targetId: "next",
        pathname: `/services/current/${section}`,
      }),
      `/services/next/${section}`,
    );
  }
});

test("switching environments keeps safe analytics query state but drops entity-specific IDs", () => {
  const href = breadcrumbEntityHref({
    kind: "apps",
    currentId: "production",
    targetId: "staging",
    pathname: "/services/production/analytics",
    search:
      "?measure=request&days=7&metric=errors&compare=on&baselineId=old&page=4&token=private",
  });
  assert.equal(
    href,
    "/services/staging/analytics?measure=request&days=7&compare=on&metric=errors",
  );
  assert.equal(
    breadcrumbEntityHref({
      kind: "resources",
      currentId: "one",
      targetId: "two",
      pathname: "/datastores/one/restore",
      search: "?backupId=old&page=5",
    }),
    "/datastores/two/restore",
  );
});

test("switching entities does not carry another entity's deployment or sync ID", () => {
  assert.equal(
    breadcrumbEntityHref({
      kind: "apps",
      currentId: "current",
      targetId: "next",
      pathname: "/services/current/deployments/old-deployment/logs",
    }),
    "/services/next/deployments",
  );
  assert.equal(
    breadcrumbEntityHref({
      kind: "sources",
      currentId: "current",
      targetId: "next",
      pathname: "/repositories/current/syncs/old-sync/issues",
    }),
    "/repositories/next/sync-history",
  );
});

test("datastores, servers and syncs retain their own page context", () => {
  for (const [kind, pathname, expected] of [
    ["resources", "/datastores/current/backup", "/datastores/next/backup"],
    [
      "servers",
      "/servers/current/settings/cleanup",
      "/servers/next/settings/cleanup",
    ],
    [
      "syncs",
      "/repositories/repo/syncs/current/issues",
      "/repositories/repo/syncs/next/issues",
    ],
    [
      "sources",
      "/repositories/current/services/old-app/settings/secrets",
      "/repositories/next/services",
    ],
    [
      "sources",
      "/services/another-app/analytics",
      "/repositories/next/environments",
    ],
    ["apps", "/services/current", "/services/next/overview"],
  ] as const) {
    assert.equal(
      breadcrumbEntityHref({
        kind,
        currentId: "current",
        targetId: "next",
        pathname,
        sourceId: "repo",
      }),
      expected,
    );
  }
});

test("switching services from any Preview detail section keeps Preview history without requiring query params", () => {
  for (const section of ["overview", "progress", "logs"]) {
    assert.equal(
      breadcrumbEntityHref({
        kind: "apps",
        currentId: "one",
        deploymentEnvironment: "preview",
        targetId: "two",
        pathname: `/services/one/deployments/old/${section}`,
      }),
      "/services/two/deployments?type=preview",
    );
  }
  assert.equal(
    breadcrumbEntityHref({
      kind: "apps",
      currentId: "one",
      deploymentEnvironment: "production",
      targetId: "two",
      pathname: "/services/one/deployments/old/logs",
      search: "?type=preview",
    }),
    "/services/two/deployments",
  );
});

test("switching services retains Preview history but drops deployment and pagination IDs", () => {
  assert.equal(
    breadcrumbEntityHref({
      kind: "apps",
      currentId: "one",
      targetId: "two",
      pathname: "/services/one/deployments/old/logs",
      search: "?type=preview&page=8&deploymentId=old",
    }),
    "/services/two/deployments?type=preview",
  );
});
