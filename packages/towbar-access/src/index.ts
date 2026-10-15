import {
  createAccessControl,
  type Statements,
} from "better-auth/plugins/access";

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
export const statements = {
  identity: ["read"],
  repository: ["read", "connect", "update", "sync", "disconnect"],
  deployment: ["read", "create", "cancel"],
  workload: ["read", "operate"],
  resource: ["read", "backup", "restore"],
  server: [
    "read",
    "prepare",
    "update",
    "credentials",
    "remove",
    "terminal",
    "collectLogs",
  ],
  secret: ["list", "update", "reveal"],
  sharedSecret: ["list", "update", "reference", "reveal"],
  logs: ["read", "readAdmin"],
  scout: ["read", "configure"],
  alert: ["read", "configure"],
  integration: ["manage"],
  githubInstallation: ["read"],
  notification: ["manage"],
  inbox: ["read", "update"],
  privateKey: ["manage", "reveal"],
  member: ["read", "create", "update", "delete"],
  invitation: ["read", "create", "cancel"],
  organization: ["update", "delete"],
  apikey: ["create", "read", "update", "delete"],
  team: ["read", "update"],
  system: ["read", "manage"],
  personal: ["manage"],
} as const;
export type Resource = keyof typeof statements;
export type Action = {
  [R in Resource]: `${R}.${(typeof statements)[R][number]}`;
}[Resource];
type RolePermissions = {
  [R in Resource]?: readonly (typeof statements)[R][number][];
};
const viewerPermissions = {
  identity: ["read"],
  repository: ["read"],
  deployment: ["read"],
  workload: ["read"],
  resource: ["read"],
  server: ["read"],
  logs: ["read"],
  scout: ["read"],
  alert: ["read"],
  inbox: ["read", "update"],
  personal: ["manage"],
} as const satisfies RolePermissions;
const memberPermissions = {
  ...viewerPermissions,
  secret: ["list", "update"],
  sharedSecret: ["list", "update", "reference"],
  scout: ["read", "configure"],
  alert: ["read", "configure"],
  githubInstallation: ["read"],
} as const satisfies RolePermissions;
const aclStatements: Statements = statements;
export const accessControl = createAccessControl(aclStatements);
export const accessRoles = {
  admin: accessControl.newRole(statements),
  member: accessControl.newRole(memberPermissions),
  viewer: accessControl.newRole(viewerPermissions),
};
export const allActions = Object.entries(statements).flatMap(
  ([resource, actions]) =>
    actions.map((action) => `${resource}.${action}` as Action),
);
export function isAction(value: string): value is Action {
  return allActions.includes(value as Action);
}
export function roleAllows(role: WorkspaceRole, action: Action): boolean {
  const [resource, operation] = action.split(".");
  return accessRoles[role].authorize({ [resource!]: [operation!] }).success;
}
export function roleActions(role: WorkspaceRole): Action[] {
  return allActions.filter((action) => roleAllows(role, action));
}

export type KeyAccess = "read" | "edit";
export type KeyScope = "personal" | "team";
export type KeyPermissionMode = "scoped" | "full-admin";
export type KeyPolicy = {
  scope: KeyScope;
  access: KeyAccess;
  includeAdmin: boolean;
  permissionMode?: KeyPermissionMode;
  grants: readonly Action[];
};
const browserOnlyResources = new Set<Resource>([
  "personal",
  "inbox",
  "member",
  "invitation",
  "organization",
  "apikey",
  "team",
  "privateKey",
]);
const browserOnlyActions = new Set<Action>([
  "server.terminal",
  "secret.reveal",
  "sharedSecret.reveal",
]);
export function automationAllows(action: Action): boolean {
  return (
    !browserOnlyResources.has(action.split(".")[0] as Resource) &&
    !browserOnlyActions.has(action)
  );
}
export function keyCeiling(
  role: WorkspaceRole,
  access: KeyAccess,
  includeAdmin: boolean,
): Action[] {
  const ceilingRole =
    includeAdmin && role === "admin"
      ? "admin"
      : role === "viewer"
        ? "viewer"
        : "member";
  return roleActions(ceilingRole).filter(
    (action) =>
      automationAllows(action) &&
      (access === "edit" ||
        action.endsWith(".read") ||
        action.endsWith(".list")),
  );
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
  const allowed = new Set(keyCeiling(role, access, includeAdmin));
  return {
    ...policy,
    access,
    includeAdmin,
    ...(policy.permissionMode === "full-admin" && role !== "admin"
      ? { permissionMode: "scoped" as const }
      : {}),
    grants: (policy.permissionMode === "full-admin"
      ? keyCeiling("admin", policy.access, policy.includeAdmin)
      : policy.grants
    ).filter((action) => allowed.has(action)),
  };
}
export type AccessActor =
  | {
      kind: "session";
      workspaceId: string;
      userId: string;
      role: WorkspaceRole;
      grants?: readonly Action[];
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
      source: "github" | "gitlab" | "worker";
      grants: readonly Action[];
    };
export function actorAllows(
  actor: AccessActor,
  required: readonly Action[],
  workspaceId = actor.workspaceId,
): boolean {
  if (actor.workspaceId !== workspaceId || required.length === 0) return false;
  if (actor.kind === "session")
    return required.every(
      (action) =>
        roleAllows(actor.role, action) &&
        (!actor.grants || actor.grants.includes(action)),
    );
  if (actor.kind === "system")
    return required.every((action) => actor.grants.includes(action));
  if (
    actor.policy.scope !== (actor.kind === "personal-key" ? "personal" : "team")
  )
    return false;
  const role = actor.kind === "personal-key" ? actor.role : "admin";
  const allowed = new Set(
    keyCeiling(role, actor.policy.access, actor.policy.includeAdmin),
  );
  if (actor.policy.permissionMode === "full-admin") {
    if (
      actor.policy.access !== "edit" ||
      !actor.policy.includeAdmin ||
      (actor.kind === "personal-key" &&
        actor.tokenAttribution?.tokenType === "mcp-oauth")
    )
      return false;
    return required.every((action) => allowed.has(action));
  }
  return required.every(
    (action) => allowed.has(action) && actor.policy.grants.includes(action),
  );
}
export function actorActions(actor: AccessActor): Action[] {
  return allActions.filter((action) => actorAllows(actor, [action]));
}
