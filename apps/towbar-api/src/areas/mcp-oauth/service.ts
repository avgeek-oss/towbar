import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import {
  canCreateKey,
  isWorkspaceRole,
  keyCeiling,
} from "@workspace/towbar-access";
import {
  apiKeyPolicies,
  apiKeys,
  mcpOAuthRequests,
  users,
  workspaceMembers,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { createApiKey } from "../api-keys/service.js";
import { requireRecentAuthentication } from "../auth/recent-authentication.js";
import { currentMembership, lockTeam } from "../team/authorization.js";
import type { AuthenticatedUser } from "../../http/types.js";
import { resolveClient } from "./clients.js";
import {
  OAuthError,
  authorizationResponse,
  digest,
  equalSecret,
  mcpResource,
  oauthKeyPermissions,
  parseScope,
  requireResource,
  secret,
  tokenLifetimeSeconds,
} from "./protocol.js";

export async function beginAuthorization(params: Record<string, string>) {
  const client = await resolveClient(params.client_id ?? "");
  if (
    !params.redirect_uri ||
    !client.redirectUris.includes(params.redirect_uri)
  )
    throw new OAuthError(
      "invalid_request",
      "The redirect URI is not registered for this client",
    );
  let scope: string;
  try {
    if (params.response_type !== "code")
      throw new OAuthError(
        "unsupported_response_type",
        "Only authorization code responses are supported",
      );
    if (
      params.code_challenge_method !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? "")
    )
      throw new OAuthError("invalid_request", "S256 PKCE is required");
    requireResource(params.resource);
    scope = parseScope(params.scope);
    if ((params.state?.length ?? 0) > 2048)
      throw new OAuthError("invalid_request", "State is too long");
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    return {
      redirectTo: authorizationResponse(
        {
          redirectUri: params.redirect_uri,
          state:
            (params.state?.length ?? 0) <= 2048 ? (params.state ?? null) : null,
        },
        { error: error.code },
      ),
    };
  }

  const db = getTowbarDatabase();
  // Keep consumed grants briefly so replay attempts can revoke their issued token.
  await db
    .delete(mcpOAuthRequests)
    .where(
      or(
        and(
          isNull(mcpOAuthRequests.codeHash),
          lt(mcpOAuthRequests.expiresAt, new Date()),
        ),
        lt(
          mcpOAuthRequests.expiresAt,
          new Date(Date.now() - tokenLifetimeSeconds * 1000),
        ),
      ),
    );
  const [request] = await db
    .insert(mcpOAuthRequests)
    .values({
      clientId: client.id,
      clientName: client.name,
      clientLogo: client.logo,
      clientTrust: client.trust,
      redirectUri: params.redirect_uri,
      resource: mcpResource(),
      scope,
      state: params.state ?? null,
      challenge: params.code_challenge!,
      expiresAt: new Date(Date.now() + 600_000),
    })
    .returning({ id: mcpOAuthRequests.id });
  return { requestId: request!.id };
}
export async function consentDetails(id: string) {
  const [request] = await getTowbarDatabase()
    .select()
    .from(mcpOAuthRequests)
    .where(
      and(
        eq(mcpOAuthRequests.id, id),
        gt(mcpOAuthRequests.expiresAt, new Date()),
        isNull(mcpOAuthRequests.codeHash),
        isNull(mcpOAuthRequests.consumedAt),
      ),
    );
  if (!request)
    throw new OAuthError(
      "invalid_request",
      "This connection link has expired or was already used. Start again from your app.",
    );
  return {
    clientName: request.clientName,
    clientId: request.clientId,
    clientLogo: request.clientLogo,
    clientTrust: request.clientTrust,
    redirectUri: request.redirectUri,
    scope: request.scope,
    expiresIn: tokenLifetimeSeconds,
  };
}
export function decideConsent(
  id: string,
  user: AuthenticatedUser,
  allow: boolean,
  sessionId: string | null = null,
  accessLevel?: "read" | "write" | "admin",
) {
  return getTowbarDatabase().transaction(async (tx) => {
    await lockTeam(tx, user.workspaceId);
    const member = await currentMembership(tx, user.workspaceId, user.id);
    const [request] = await tx
      .select()
      .from(mcpOAuthRequests)
      .where(eq(mcpOAuthRequests.id, id))
      .for("update");
    if (
      !request ||
      request.expiresAt <= new Date() ||
      request.codeHash ||
      request.consumedAt
    )
      throw new OAuthError(
        "invalid_request",
        "This connection link has expired or was already used. Start again from your app.",
      );
    if (!allow) {
      await tx
        .update(mcpOAuthRequests)
        .set({ consumedAt: new Date() })
        .where(eq(mcpOAuthRequests.id, id));
      return authorizationResponse(request, { error: "access_denied" });
    }
    if (!accessLevel)
      throw new OAuthError(
        "invalid_request",
        "Choose an access level before approving.",
      );
    const scope =
      accessLevel === "admin"
        ? "mcp:read mcp:write mcp:admin"
        : accessLevel === "write"
          ? "mcp:read mcp:write"
          : "mcp:read";
    const { access, includeAdmin } = oauthKeyPermissions(scope);
    if (
      !canCreateKey(member.role, {
        scope: "personal",
        access,
        includeAdmin,
      })
    )
      throw new OAuthError(
        "access_denied",
        "Requested access exceeds your Towbar role",
      );
    if (includeAdmin) await requireRecentAuthentication(user.id, sessionId);
    const code = secret();
    await tx
      .update(mcpOAuthRequests)
      .set({
        userId: user.id,
        workspaceId: user.workspaceId,
        scope,
        grants: keyCeiling(member.role, access, includeAdmin),
        codeHash: digest(code),
        expiresAt: new Date(Date.now() + 120_000),
      })
      .where(eq(mcpOAuthRequests.id, id));
    return authorizationResponse(request, { code });
  });
}
export async function exchangeCode(
  clientId: string,
  params: Record<string, string>,
) {
  if (params.grant_type !== "authorization_code")
    throw new OAuthError(
      "unsupported_grant_type",
      "Authorize again to obtain a new token",
    );
  requireResource(params.resource);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_verifier ?? ""))
    throw new OAuthError("invalid_grant", "Invalid PKCE verifier");
  const result = await getTowbarDatabase().transaction(async (tx) => {
    const [owner] = await tx
      .select({ workspaceId: mcpOAuthRequests.workspaceId })
      .from(mcpOAuthRequests)
      .where(eq(mcpOAuthRequests.codeHash, digest(params.code ?? "")));
    if (!owner?.workspaceId) return null;
    await lockTeam(tx, owner.workspaceId);
    const [request] = await tx
      .select()
      .from(mcpOAuthRequests)
      .where(eq(mcpOAuthRequests.codeHash, digest(params.code ?? "")))
      .for("update");
    if (
      !request ||
      request.clientId !== clientId ||
      request.redirectUri !== params.redirect_uri ||
      request.resource !== mcpResource() ||
      !equalSecret(digest(params.code_verifier!), request.challenge)
    )
      return null;
    if (request.consumedAt) {
      if (request.keyId) {
        await tx
          .update(apiKeyPolicies)
          .set({ revokedAt: new Date() })
          .where(eq(apiKeyPolicies.keyId, request.keyId));
        await tx
          .update(apiKeys)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(apiKeys.id, request.keyId));
      }
      return null;
    }
    if (
      request.expiresAt <= new Date() ||
      !request.userId ||
      !request.workspaceId ||
      !request.grants
    )
      return null;
    const [user] = await tx
      .select({
        id: users.id,
        email: users.email,
        name: users.displayName,
        workspaceRole: workspaceMembers.role,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, request.workspaceId),
        ),
      )
      .where(and(eq(users.id, request.userId), isNull(users.disabledAt)));
    if (
      !user ||
      user.mustChangePassword ||
      !isWorkspaceRole(user.workspaceRole)
    )
      return null;
    const permissions = oauthKeyPermissions(request.scope);
    if (
      !canCreateKey(user.workspaceRole, { scope: "personal", ...permissions })
    )
      return null;
    const created = await createApiKey(
      {
        ...user,
        workspaceId: request.workspaceId,
        workspaceRole: user.workspaceRole,
      },
      {
        name: request.clientName,
        ...permissions,
        expiresAt: new Date(
          Date.now() + tokenLifetimeSeconds * 1000,
        ).toISOString(),
        oauth: {
          clientId: request.clientId,
          clientName: request.clientName,
          clientLogo: request.clientLogo,
          clientTrust: request.clientTrust,
          resource: request.resource,
          grants: request.grants,
        },
      },
      tx,
    );
    await tx
      .update(mcpOAuthRequests)
      .set({ consumedAt: new Date(), keyId: created.key.id })
      .where(eq(mcpOAuthRequests.id, request.id));
    return {
      access_token: created.token,
      token_type: "Bearer" as const,
      expires_in: tokenLifetimeSeconds,
      scope: request.scope,
    };
  });
  if (!result)
    throw new OAuthError(
      "invalid_grant",
      "Authorization code is invalid, expired, or already used",
    );
  return result;
}
export async function revokeOAuthToken(clientId: string, token: string) {
  const { defaultKeyHasher } = await import("@better-auth/api-key");
  await getTowbarDatabase().transaction(async (tx) => {
    const [key] = await tx
      .select({ id: apiKeys.id, policy: apiKeyPolicies })
      .from(apiKeys)
      .innerJoin(apiKeyPolicies, eq(apiKeyPolicies.keyId, apiKeys.id))
      .where(
        and(
          eq(apiKeys.key, await defaultKeyHasher(token)),
          eq(apiKeyPolicies.tokenType, "mcp-oauth"),
          eq(apiKeyPolicies.oauthClientId, clientId),
          isNull(apiKeyPolicies.revokedAt),
        ),
      )
      .for("update");
    if (!key) return;
    await tx
      .update(apiKeyPolicies)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeyPolicies.keyId, key.id));
    await tx
      .update(apiKeys)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(apiKeys.id, key.id));
  });
}
