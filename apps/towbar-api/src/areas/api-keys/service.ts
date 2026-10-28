import { createHash, randomUUID } from "node:crypto";
import { defaultKeyHasher } from "@better-auth/api-key";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  type AccessActor,
  type KeyAccess,
  type KeyPolicy,
  type KeyScope,
  actorActions,
  canCreateKey,
  isAction,
  isWorkspaceRole,
  keyCeiling,
} from "@workspace/towbar-access";
import {
  apiKeyPolicies,
  apiKeys,
  users,
  workspaceMembers,
} from "@workspace/towbar-database/schema";
import {
  type AuthDatabase,
  getTowbarDatabase,
} from "../../infrastructure/database.js";
import {
  HttpError,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../../http/errors.js";
import { createIdentityAuth } from "../auth/identity.js";
import {
  currentMembership,
  lockTeam,
  requireTeamAdmin,
} from "../team/authorization.js";
import { enqueueAdminEmail } from "../team/email-outbox.js";
import type { AuthenticatedUser } from "../../http/types.js";
const publicColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  scope: apiKeyPolicies.scope,
  access: apiKeyPolicies.access,
  includeAdmin: apiKeyPolicies.includeAdmin,
  permissionMode: apiKeyPolicies.permissionMode,
  grants: apiKeyPolicies.grants,
  prefix: apiKeys.start,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeyPolicies.revokedAt,
  lastUsedAt: apiKeys.lastRequest,
  createdAt: apiKeys.createdAt,
  creatorUserId: apiKeyPolicies.creatorUserId,
  tokenType: apiKeyPolicies.tokenType,
  oauthClientId: apiKeyPolicies.oauthClientId,
  oauthClientName: apiKeyPolicies.oauthClientName,
  oauthClientLogo: apiKeyPolicies.oauthClientLogo,
  oauthClientTrust: apiKeyPolicies.oauthClientTrust,
};
export async function listApiKeys(
  user: AuthenticatedUser,
  scope: KeyScope = "personal",
) {
  if (scope === "team" && user.workspaceRole !== "admin") throw forbidden();
  return await getTowbarDatabase()
    .select(publicColumns)
    .from(apiKeys)
    .innerJoin(apiKeyPolicies, eq(apiKeys.id, apiKeyPolicies.keyId))
    .where(
      and(
        eq(apiKeyPolicies.workspaceId, user.workspaceId),
        eq(apiKeyPolicies.scope, scope),
        scope === "personal"
          ? eq(apiKeyPolicies.ownerUserId, user.id)
          : undefined,
      ),
    )
    .orderBy(desc(apiKeys.createdAt));
}
function oauthTokenMetadata(
  oauth:
    | {
        clientId: string;
        clientName: string;
        clientLogo: string | null;
        clientTrust: "metadata-document" | "unverified";
        resource: string;
      }
    | undefined,
) {
  return {
    tokenType: oauth ? ("mcp-oauth" as const) : ("api-key" as const),
    oauthClientId: oauth?.clientId ?? null,
    oauthClientName: oauth?.clientName ?? null,
    oauthClientLogo: oauth?.clientLogo ?? null,
    oauthClientTrust: oauth?.clientTrust ?? null,
    oauthResource: oauth?.resource ?? null,
  };
}
export async function createApiKey(
  user: AuthenticatedUser,
  input: {
    name: string;
    access: KeyAccess;
    scope?: KeyScope;
    includeAdmin?: boolean;
    expiresAt?: string | null;
    requestId?: string;
    oauth?: {
      clientId: string;
      clientName: string;
      clientLogo: string | null;
      clientTrust: "metadata-document" | "unverified";
      resource: string;
      grants: readonly string[];
    };
  },
  database: AuthDatabase = getTowbarDatabase(),
) {
  if (input.oauth && input.scope === "team") throw forbidden();
  const tokenMetadata = oauthTokenMetadata(input.oauth);
  const requestId = input.requestId ?? randomUUID();
  const creationDigest = createHash("sha256")
    .update(
      JSON.stringify({
        name: input.name,
        access: input.access,
        scope: input.scope ?? "personal",
        includeAdmin: input.includeAdmin ?? false,
        expiresAt:
          input.expiresAt ?? (input.expiresAt === null ? null : "default"),
      }),
    )
    .digest("hex");
  const scope = input.scope ?? "personal";
  const includeAdmin = input.includeAdmin ?? false;
  const permissionMode =
    !input.oauth && includeAdmin && input.access === "edit"
      ? ("full-admin" as const)
      : ("scoped" as const);
  const expiresAt =
    input.expiresAt === null
      ? null
      : input.expiresAt
        ? new Date(input.expiresAt)
        : new Date(Date.now() + 90 * 86400_000);
  if (
    expiresAt &&
    (!Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() - Date.now() < 86400_000)
  )
    throw badRequest("Choose an expiry at least one day from now");
  return await database.transaction(async (tx) => {
    await lockTeam(tx, user.workspaceId);
    const member = await currentMembership(tx, user.workspaceId, user.id);
    if (
      !canCreateKey(member.role, {
        scope,
        access: input.access,
        includeAdmin,
      }) ||
      (!expiresAt && member.role !== "admin")
    )
      throw forbidden("These API key permissions exceed your role");
    const [replay] = await tx
      .select({
        ...publicColumns,
        creationDigest: apiKeyPolicies.creationDigest,
      })
      .from(apiKeys)
      .innerJoin(apiKeyPolicies, eq(apiKeyPolicies.keyId, apiKeys.id))
      .where(
        and(
          eq(apiKeyPolicies.workspaceId, user.workspaceId),
          eq(apiKeyPolicies.creatorUserId, user.id),
          eq(apiKeyPolicies.creationRequestId, requestId),
        ),
      );
    if (replay) {
      if (replay.creationDigest !== creationDigest)
        throw conflict(
          "This request ID was already used with different key settings",
          "IDEMPOTENCY_CONFLICT",
        );
      const { creationDigest: _digest, ...key } = replay;
      return { key, token: null, replayed: true };
    }
    const auth = createIdentityAuth(tx);
    const grants = keyCeiling(member.role, input.access, includeAdmin).filter(
      (action) => !input.oauth || input.oauth.grants.includes(action),
    );
    const key = await auth.api.createApiKey({
      body: {
        configId: scope,
        name: input.name,
        userId: user.id,
        ...(scope === "team" ? { organizationId: user.workspaceId } : {}),
        expiresIn: expiresAt
          ? Math.ceil((expiresAt.getTime() - Date.now()) / 1000)
          : null,
      },
    });
    await tx.insert(apiKeyPolicies).values({
      ...tokenMetadata,
      creationRequestId: requestId,
      creationDigest,
      keyId: key.id,
      workspaceId: user.workspaceId,
      scope,
      access: input.access,
      includeAdmin,
      permissionMode,
      grants,
      ownerUserId: scope === "personal" ? user.id : null,
      creatorUserId: user.id,
    });
    if (scope === "team")
      await enqueueAdminEmail(tx, {
        workspaceId: user.workspaceId,
        template: "team-key-created",
        dedupeKey: `team-key-created:${key.id}`,
        data: { keyName: input.name },
      });
    return {
      key: {
        ...tokenMetadata,
        id: key.id,
        name: key.name,
        scope,
        access: input.access,
        includeAdmin,
        permissionMode,
        grants,
        prefix: key.start,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
        revokedAt: null,
        lastUsedAt: null,
      },
      token: key.key,
      replayed: false,
    };
  });
}
export async function revokeApiKey(
  user: AuthenticatedUser,
  id: string,
  scope: KeyScope = "personal",
) {
  await getTowbarDatabase().transaction(async (tx) => {
    await lockTeam(tx, user.workspaceId);
    if (scope === "team") await requireTeamAdmin(tx, user.workspaceId, user.id);
    else await currentMembership(tx, user.workspaceId, user.id);
    const [previous] = await tx
      .select({
        revokedAt: apiKeyPolicies.revokedAt,
        name: apiKeys.name,
        tokenType: apiKeyPolicies.tokenType,
        oauthClientId: apiKeyPolicies.oauthClientId,
        oauthClientName: apiKeyPolicies.oauthClientName,
        oauthClientTrust: apiKeyPolicies.oauthClientTrust,
      })
      .from(apiKeyPolicies)
      .innerJoin(apiKeys, eq(apiKeys.id, apiKeyPolicies.keyId))
      .where(
        and(
          eq(apiKeyPolicies.keyId, id),
          eq(apiKeyPolicies.workspaceId, user.workspaceId),
          eq(apiKeyPolicies.scope, scope),
          scope === "personal"
            ? eq(apiKeyPolicies.ownerUserId, user.id)
            : undefined,
        ),
      );
    if (!previous) throw notFound("API key");
    if (previous.revokedAt) return;
    const [policy] = await tx
      .update(apiKeyPolicies)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeyPolicies.keyId, id),
          eq(apiKeyPolicies.workspaceId, user.workspaceId),
          eq(apiKeyPolicies.scope, scope),
          scope === "personal"
            ? eq(apiKeyPolicies.ownerUserId, user.id)
            : undefined,
        ),
      )
      .returning({ id: apiKeyPolicies.keyId });
    if (!policy) throw notFound("API key");
    await tx
      .update(apiKeys)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(apiKeys.id, id));
    if (scope === "team")
      await enqueueAdminEmail(tx, {
        workspaceId: user.workspaceId,
        template: "team-key-revoked",
        dedupeKey: `team-key-revoked:${id}`,
        data: { keyName: previous.name ?? "Team API key" },
      });
  });
}
export async function findApiKey(token: string) {
  if (!token.startsWith("twb_") || token.length < 32 || token.length > 256)
    return null;
  const verification = await getTowbarDatabase().transaction(async (tx) => {
    // Serialize a key's plugin verification: the adapter's guarded subquery
    // can otherwise admit concurrent PostgreSQL updates from the same snapshot.
    const [record] = await tx
      .select({
        configId: apiKeys.configId,
        rateLimitTimeWindow: apiKeys.rateLimitTimeWindow,
      })
      .from(apiKeys)
      .where(eq(apiKeys.key, await defaultKeyHasher(token)))
      .limit(1)
      .for("update");
    if (!record || !["personal", "team"].includes(record.configId)) return null;
    const result = await createIdentityAuth(tx).api.verifyApiKey({
      body: { key: token, configId: record.configId },
    });
    if (result.error?.code === "RATE_LIMITED")
      throw new HttpError(
        429,
        "RATE_LIMITED",
        "This API key has reached its request limit. Try again later",
        {
          responseHeaders: {
            "Retry-After": String(
              Math.max(
                1,
                Math.ceil((record.rateLimitTimeWindow ?? 60_000) / 1000),
              ),
            ),
          },
        },
      );
    return result;
  });
  if (!verification?.valid || !verification.key) return null;
  return await resolveApiKeyPrincipal(verification.key.id);
}
export async function resolveApiKeyPrincipal(id: string) {
  const [stored] = await getTowbarDatabase()
    .select({ policy: apiKeyPolicies, key: apiKeys })
    .from(apiKeyPolicies)
    .innerJoin(apiKeys, eq(apiKeys.id, apiKeyPolicies.keyId))
    .where(
      and(
        eq(apiKeyPolicies.keyId, id),
        isNull(apiKeyPolicies.revokedAt),
        eq(apiKeys.enabled, true),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .limit(1);
  if (
    !stored ||
    stored.key.configId !== stored.policy.scope ||
    stored.policy.grants.some((action) => !isAction(action))
  )
    return null;
  const policy: KeyPolicy = {
    scope: stored.policy.scope,
    access: stored.policy.access,
    includeAdmin: stored.policy.includeAdmin,
    permissionMode: stored.policy.permissionMode,
    grants: stored.policy.grants.filter(isAction),
  };
  if (policy.scope === "team") {
    if (
      stored.key.referenceId !== stored.policy.workspaceId ||
      stored.policy.ownerUserId
    )
      return null;
    const actor: AccessActor = {
      kind: "team-key",
      workspaceId: stored.policy.workspaceId,
      keyId: id,
      policy,
    };
    return {
      actor,
      key: {
        id,
        access: policy.access,
        tokenType: stored.policy.tokenType,
        resource: stored.policy.oauthResource,
      },
      user: {
        id: null,
        email: null,
        name: stored.key.name ?? "Team API key",
        workspaceId: actor.workspaceId,
        workspaceRole: null,
        capabilities: actorActions(actor),
      },
    };
  }
  if (
    !stored.policy.ownerUserId ||
    stored.key.referenceId !== stored.policy.ownerUserId
  )
    return null;
  const [user] = await getTowbarDatabase()
    .select({
      id: users.id,
      email: users.email,
      name: users.displayName,
      role: workspaceMembers.role,
      dateTimePreferences: users.dateTimePreferences,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, users.id),
        eq(workspaceMembers.workspaceId, stored.policy.workspaceId),
      ),
    )
    .where(
      and(eq(users.id, stored.policy.ownerUserId), isNull(users.disabledAt)),
    )
    .limit(1);
  if (!user || user.mustChangePassword || !isWorkspaceRole(user.role))
    return null;
  const actor: AccessActor = {
    kind: "personal-key",
    workspaceId: stored.policy.workspaceId,
    userId: user.id,
    role: user.role,
    keyId: id,
    policy,
    tokenAttribution: {
      tokenType: stored.policy.tokenType,
      oauthClientId: stored.policy.oauthClientId,
      oauthClientName: stored.policy.oauthClientName,
      oauthClientTrust: stored.policy.oauthClientTrust,
    },
  };
  return {
    actor,
    key: {
      id,
      access: policy.access,
      tokenType: stored.policy.tokenType,
      resource: stored.policy.oauthResource,
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      dateTimePreferences: user.dateTimePreferences,
      workspaceId: actor.workspaceId,
      workspaceRole: user.role,
      capabilities: actorActions(actor),
    },
  };
}
