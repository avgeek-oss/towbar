import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actorAllows,
  actorScopes,
  scopes,
  isScope,
  canCreateKey,
  constrainPersonalKey,
  keyCeiling,
  keyRole,
  roleScopes,
  type AccessActor,
  type KeyPolicy,
} from "./index.js";

test("roles define the only supported scopes", () => {
  assert.deepEqual(scopes, ["viewer", "member", "admin"]);
  assert.deepEqual(roleScopes("viewer"), ["viewer"]);
  assert.deepEqual(roleScopes("member"), ["viewer", "member"]);
  assert.deepEqual(roleScopes("admin"), ["viewer", "member", "admin"]);
  for (const unsupported of [
    "deployment.create",
    "repository.read",
    "read",
    "write",
    "*",
    "unknown",
  ])
    assert.equal(isScope(unsupported), false);
});

test("credentials are capped by their saved scopes and live role", () => {
  const actor: AccessActor = {
    kind: "personal-key",
    workspaceId: "w",
    userId: "u",
    role: "admin",
    keyId: "k",
    policy: {
      scope: "personal",
      access: "edit",
      includeAdmin: true,
      grants: ["viewer", "member", "admin"],
    },
  };
  assert.deepEqual(actorScopes(actor), ["viewer", "member", "admin"]);
  assert.equal(actorAllows(actor, ["admin"]), true);
  assert.equal(
    actorAllows(
      { ...actor, policy: { ...actor.policy, grants: ["viewer", "member"] } },
      ["admin"],
    ),
    false,
  );
  assert.equal(actorAllows({ ...actor, role: "member" }, ["admin"]), false);
  assert.equal(actorAllows({ ...actor, role: "viewer" }, ["member"]), false);
  assert.equal(
    actorAllows({ ...actor, policy: { ...actor.policy, access: "read" } }, [
      "member",
    ]),
    false,
  );
  assert.equal(
    actorAllows(
      { ...actor, policy: { ...actor.policy, includeAdmin: false } },
      ["admin"],
    ),
    false,
  );
  assert.equal(actorAllows(actor, ["viewer"], "another-workspace"), false);
  assert.equal(actorAllows(actor, []), false);
});

test("team keys use their saved team ceiling", () => {
  const team: AccessActor = {
    kind: "team-key",
    workspaceId: "w",
    keyId: "k",
    policy: {
      scope: "team",
      access: "edit",
      includeAdmin: true,
      grants: ["viewer", "member", "admin"],
    },
  };
  assert.equal(actorAllows(team, ["admin"]), true);
  assert.equal(
    actorAllows({ ...team, policy: { ...team.policy, scope: "personal" } }, [
      "viewer",
    ]),
    false,
  );
  assert.equal(
    actorAllows({ ...team, policy: { ...team.policy, includeAdmin: false } }, [
      "admin",
    ]),
    false,
  );
});

test("demotion permanently narrows personal grants", () => {
  const admin: KeyPolicy = {
    scope: "personal",
    access: "edit",
    includeAdmin: true,
    grants: keyCeiling("admin", "edit", true),
  };
  const member = constrainPersonalKey(admin, "member");
  assert.deepEqual(member, {
    scope: "personal",
    access: "edit",
    includeAdmin: false,
    grants: ["viewer", "member"],
  });
  assert.deepEqual(constrainPersonalKey(member, "admin"), member);
  const viewer = constrainPersonalKey(member, "viewer");
  assert.deepEqual(viewer, {
    scope: "personal",
    access: "read",
    includeAdmin: false,
    grants: ["viewer"],
  });
  assert.deepEqual(constrainPersonalKey(viewer, "admin"), viewer);
  assert.deepEqual(
    constrainPersonalKey({ ...admin, grants: [] }, "member").grants,
    [],
  );
});

test("creation cannot exceed the issuing person's authority", () => {
  assert.equal(
    canCreateKey("viewer", {
      scope: "personal",
      access: "read",
      includeAdmin: false,
    }),
    true,
  );
  assert.equal(
    canCreateKey("viewer", {
      scope: "personal",
      access: "edit",
      includeAdmin: false,
    }),
    false,
  );
  assert.equal(
    canCreateKey("member", {
      scope: "team",
      access: "edit",
      includeAdmin: false,
    }),
    false,
  );
  assert.equal(
    canCreateKey("member", {
      scope: "personal",
      access: "edit",
      includeAdmin: true,
    }),
    false,
  );
  assert.equal(
    canCreateKey("admin", {
      scope: "team",
      access: "edit",
      includeAdmin: true,
    }),
    true,
  );
  assert.equal(
    canCreateKey("admin", {
      scope: "personal",
      access: "read",
      includeAdmin: true,
    }),
    false,
  );
});

test("queued and system actors retain their captured ceiling", () => {
  const queued: AccessActor = {
    kind: "session",
    workspaceId: "w",
    userId: "u",
    role: "admin",
    grants: ["viewer"],
  };
  assert.equal(actorAllows(queued, ["viewer"]), true);
  assert.equal(actorAllows(queued, ["member"]), false);
  const system: AccessActor = {
    kind: "system",
    workspaceId: "w",
    source: "worker",
    grants: ["viewer", "member"],
  };
  assert.equal(actorAllows(system, ["member"]), true);
  assert.equal(actorAllows(system, ["admin"]), false);
});

test("personal key roles are the lower of live membership and the credential ceiling", () => {
  const policy: KeyPolicy = {
    scope: "personal",
    access: "edit",
    includeAdmin: false,
    grants: ["viewer", "member"],
  };
  assert.equal(keyRole("admin", policy), "member");
  assert.equal(
    keyRole("viewer", {
      ...policy,
      includeAdmin: true,
      grants: ["viewer", "member", "admin"],
    }),
    "viewer",
  );
  assert.equal(keyRole("admin", { ...policy, access: "read" }), "viewer");
});
