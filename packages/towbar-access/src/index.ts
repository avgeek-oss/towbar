export const workspaceRoles = ["admin", "member", "viewer"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
export const roleLabels: Record<WorkspaceRole, string> = {
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};
export const roleDescriptions: Record<WorkspaceRole, string> = {
  admin:
    "Full access, including team, integrations, infrastructure, and credentials.",
  member:
    "Manage secret values, Scout Agent, and alert rules. View repositories and operational activity.",
  viewer: "View operational activity without changing shared resources.",
};
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "admin" || value === "member" || value === "viewer";
}
export const scopes = ["viewer", "member", "admin"] as const;
export type Scope = (typeof scopes)[number];
export function isScope(value: string): value is Scope {
  return value === "viewer" || value === "member" || value === "admin";
}
export function scopesAllow(grants: readonly Scope[], scope: Scope): boolean {
  return (
    grants.includes(scope) ||
    grants.includes("admin") ||
    (scope === "viewer" && grants.includes("member"))
  );
}
export function roleAllows(role: WorkspaceRole, scope: Scope): boolean {
  return (
    scope === "viewer" ||
    (scope === "member" && role !== "viewer") ||
    (scope === "admin" && role === "admin")
  );
}
export function roleScopes(role: WorkspaceRole): Scope[] {
  return scopes.filter((scope) => roleAllows(role, scope));
}

export type KeyAccess = "read" | "edit";
export type KeyScope = "personal" | "team";
export type KeyPolicy = {
  scope: KeyScope;
  access: KeyAccess;
  includeAdmin: boolean;
  grants: readonly Scope[];
};
export function keyCeiling(
  role: WorkspaceRole,
  access: KeyAccess,
  includeAdmin: boolean,
): Scope[] {
  return roleScopes(
    access === "read" || role === "viewer"
      ? "viewer"
      : includeAdmin && role === "admin"
        ? "admin"
        : "member",
  );
}
export function keyRole(role: WorkspaceRole, policy: KeyPolicy): WorkspaceRole {
  const allowed = keyCeiling(role, policy.access, policy.includeAdmin);
  if (allowed.includes("admin") && scopesAllow(policy.grants, "admin"))
    return "admin";
  if (allowed.includes("member") && scopesAllow(policy.grants, "member"))
    return "member";
  return "viewer";
}
export function canCreateKey(
  role: WorkspaceRole,
  policy: Omit<KeyPolicy, "grants">,
): boolean {
  return (
    !(policy.scope === "team" && role !== "admin") &&
    !(policy.includeAdmin && (role !== "admin" || policy.access !== "edit")) &&
    !(role === "viewer" && policy.access !== "read")
  );
}
export function constrainPersonalKey(
  policy: KeyPolicy,
  role: WorkspaceRole,
): KeyPolicy {
  const access = role === "viewer" ? "read" : policy.access;
  const includeAdmin = role === "admin" && policy.includeAdmin;
  const allowed = keyCeiling(role, access, includeAdmin);
  return {
    ...policy,
    access,
    includeAdmin,
    grants: scopes.filter(
      (scope) => scopesAllow(policy.grants, scope) && allowed.includes(scope),
    ),
  };
}
export type AccessActor =
  | {
      kind: "session";
      workspaceId: string;
      userId: string;
      role: WorkspaceRole;
      grants?: readonly Scope[];
    }
  | {
      kind: "personal-key";
      workspaceId: string;
      userId: string;
      role: WorkspaceRole;
      keyId: string;
      tokenAttribution?: {
        tokenType: "api-key" | "mcp-oauth";
        oauthClientId: string | null;
        oauthClientName: string | null;
        oauthClientTrust: string | null;
      };
      policy: KeyPolicy;
    }
  | { kind: "team-key"; workspaceId: string; keyId: string; policy: KeyPolicy }
  | {
      kind: "system";
      workspaceId: string;
      source: "github" | "worker";
      grants: readonly Scope[];
    };
export function actorAllows(
  actor: AccessActor,
  required: readonly Scope[],
  workspaceId = actor.workspaceId,
): boolean {
  if (actor.workspaceId !== workspaceId || required.length === 0) return false;
  if (actor.kind === "session")
    return required.every(
      (scope) =>
        roleAllows(actor.role, scope) &&
        (!actor.grants || scopesAllow(actor.grants, scope)),
    );
  if (actor.kind === "system")
    return required.every((scope) => scopesAllow(actor.grants, scope));
  if (
    actor.policy.scope !== (actor.kind === "personal-key" ? "personal" : "team")
  )
    return false;
  const role = actor.kind === "personal-key" ? actor.role : "admin";
  const allowed = keyCeiling(
    role,
    actor.policy.access,
    actor.policy.includeAdmin,
  );
  return required.every(
    (scope) =>
      allowed.includes(scope) && scopesAllow(actor.policy.grants, scope),
  );
}
export function actorScopes(actor: AccessActor): Scope[] {
  return scopes.filter((scope) => actorAllows(actor, [scope]));
}
