import assert from "node:assert/strict";
import test from "node:test";

import { roleActions, type WorkspaceRole } from "@workspace/towbar-access";
import type { TowbarUser } from "@workspace/towbar-web-client";

import { routePermission } from "../components/access-context";
import { createApplicationSidebar } from "./application-layout";

function fixtureUser(role: WorkspaceRole): TowbarUser {
  return {
    capabilities: roleActions(role),
    email: `${role}@example.com`,
    emailVerified: true,
    id: role,
    mustChangePassword: false,
    name: role,
    passwordSetupRequired: false,
    teamName: "Platform team",
    twoFactorEnabled: false,
    workspaceId: "workspace",
    workspaceRole: role,
  };
}

test("primary navigation groups settings and preserves role visibility", () => {
  const admin = createApplicationSidebar({}, undefined, fixtureUser("admin"));
  assert.equal(
    admin.groups.some((group) => group.id === "manage"),
    false,
  );
  const adminWorkspace = admin.groups.find((group) => group.id === "workspace");
  assert.equal(adminWorkspace?.label, "Manage");
  assert.deepEqual(
    adminWorkspace?.items.map((item) => item.id),
    ["ssh-keys", "shared-secrets", "notifications", "integrations"],
  );
  assert.deepEqual(
    admin.groups
      .find((group) => group.id === "settings")
      ?.items.map((item) => item.id),
    ["account-settings", "team-settings", "health"],
  );
  assert.deepEqual(
    admin.groups
      .find((group) => group.id === "monitoring")
      ?.items.map((item) => item.id),
    ["logs", "incidents", "vulnerabilities"],
  );

  const member = createApplicationSidebar({}, undefined, fixtureUser("member"));
  const memberWorkspace = member.groups.find(
    (group) => group.id === "workspace",
  );
  assert.deepEqual(
    memberWorkspace?.items.map((item) => item.id),
    ["shared-secrets"],
  );
  assert.deepEqual(
    member.groups
      .find((group) => group.id === "settings")
      ?.items.map((item) => item.id),
    ["account-settings"],
  );
  assert.equal(
    member.groups
      .find((group) => group.id === "monitoring")
      ?.items.some((item) => item.id === "health"),
    false,
  );
  const memberSharedSecrets = memberWorkspace?.items.find(
    (item) => item.id === "shared-secrets",
  );
  assert(
    memberSharedSecrets && "href" in memberSharedSecrets,
    "member Shared Secrets must remain navigable",
  );
  assert.equal(memberSharedSecrets.href, "/manage/shared-secrets");

  const viewer = createApplicationSidebar({}, undefined, fixtureUser("viewer"));
  assert(
    viewer.groups
      .find((group) => group.id === "monitoring")
      ?.items.some((item) => item.id === "logs"),
  );
  assert.deepEqual(
    viewer.groups
      .find((group) => group.id === "settings")
      ?.items.map((item) => item.id),
    ["account-settings"],
  );
  assert.equal(
    viewer.groups.find((group) => group.id === "workspace"),
    undefined,
  );
});

test("management routes preserve their specific permission boundaries", () => {
  assert.equal(
    routePermission("/manage/integrations/github"),
    "integration.manage",
  );
  assert.equal(routePermission("/team-settings/ssh-keys"), "privateKey.manage");
  assert.equal(routePermission("/manage/ssh-keys"), "privateKey.manage");
  assert.equal(
    routePermission("/manage/integrations/github"),
    "integration.manage",
  );
  assert.equal(routePermission("/manage/shared-secrets"), "sharedSecret.list");
  assert.equal(
    routePermission("/team-settings/integrations/github"),
    "integration.manage",
  );
  assert.equal(
    routePermission("/team-settings/shared-secrets"),
    "sharedSecret.list",
  );
  assert.equal(routePermission("/team-settings/members"), "team.read");
  assert.equal(routePermission("/system-health"), "system.read");
});
