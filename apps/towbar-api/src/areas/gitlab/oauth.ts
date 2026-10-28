import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  decryptCredential,
  encryptCredential,
  parseCredentialsMasterKey,
} from "@workspace/towbar-core";
import {
  integrationAuthorizationAttempts,
  integrationAuthorizations,
} from "@workspace/towbar-database/schema";
import { z } from "zod";
import { getEnv } from "../../env.js";
import { badRequest, serviceUnavailable } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { integrationFetch } from "../../infrastructure/outbound-network.js";
import { requireGitLabRuntimeConfiguration } from "../../infrastructure/runtime-integrations.js";
import { requireActor } from "../auth/actor-context.js";
import { encryptIntegrationCredentials } from "../integrations/service.js";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  created_at: z.number().int().nonnegative().optional(),
  expires_in: z.number().int().positive().max(31_536_000),
  refresh_token: z.string().min(1).max(16_384),
});

const userSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(255),
  username: z.string().min(1).max(255),
});

export async function beginGitLabAuthorization(input: {
  userId: string;
  workspaceId: string;
}) {
  requireActor(input.workspaceId, ["integration.manage"]);
  const runtime = requireGitLabRuntimeConfiguration();
  const id = randomUUID();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await getTowbarDatabase()
    .insert(integrationAuthorizationAttempts)
    .values({
      encryptedPayload: encryptCredential({
        associatedData: attemptAssociatedData(input.workspaceId, id),
        masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
        value: { verifier },
      }),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      id,
      provider: "gitlab",
      redirectUri: runtime.oauthRedirectUri,
      requestedBy: input.userId,
      stateDigest: digest(state),
      workspaceId: input.workspaceId,
    });
  const url = new URL("/oauth/authorize", runtime.baseUrl);
  url.search = new URLSearchParams({
    client_id: runtime.oauthClientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: runtime.oauthRedirectUri,
    response_type: "code",
    scope: "api read_repository",
    state,
  }).toString();
  return { authorizationUrl: url.toString(), expiresInSeconds: 600 };
}

export async function completeGitLabAuthorization(input: {
  code: string;
  state: string;
  userId: string;
  workspaceId: string;
}) {
  requireActor(input.workspaceId, ["integration.manage"]);
  const runtime = requireGitLabRuntimeConfiguration();
  const stateDigest = digest(input.state);
  const database = getTowbarDatabase();
  const [attempt] = await database
    .select()
    .from(integrationAuthorizationAttempts)
    .where(
      and(
        eq(integrationAuthorizationAttempts.provider, "gitlab"),
        eq(integrationAuthorizationAttempts.workspaceId, input.workspaceId),
        eq(integrationAuthorizationAttempts.requestedBy, input.userId),
        eq(integrationAuthorizationAttempts.stateDigest, stateDigest),
        gt(integrationAuthorizationAttempts.expiresAt, new Date()),
        isNull(integrationAuthorizationAttempts.consumedAt),
      ),
    )
    .limit(1);
  if (!attempt || !safeEqual(attempt.stateDigest, stateDigest))
    throw badRequest("The GitLab authorization request expired or is invalid");
  const payload = decryptCredential<{ verifier: string }>({
    associatedData: attemptAssociatedData(input.workspaceId, attempt.id),
    envelope: attempt.encryptedPayload,
    masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
  });
  const [consumed] = await database
    .update(integrationAuthorizationAttempts)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(integrationAuthorizationAttempts.id, attempt.id),
        isNull(integrationAuthorizationAttempts.consumedAt),
      ),
    )
    .returning({ id: integrationAuthorizationAttempts.id });
  if (!consumed)
    throw badRequest("The GitLab authorization request was already used");

  const response = await integrationFetch(
    new URL("/oauth/token", runtime.baseUrl).toString(),
    {
      allowPrivateNetwork: runtime.allowPrivateNetwork,
      body: new URLSearchParams({
        client_id: runtime.oauthClientId,
        client_secret: runtime.oauthClientSecret,
        code: input.code,
        code_verifier: payload.verifier,
        grant_type: "authorization_code",
        redirect_uri: attempt.redirectUri,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    },
  );
  if (!response.ok)
    throw serviceUnavailable(
      `GitLab rejected the authorization code with status ${response.status}`,
    );
  const tokens = tokenResponseSchema.parse(await response.json());
  const userResponse = await integrationFetch(
    new URL("/api/v4/user", runtime.baseUrl).toString(),
    {
      allowPrivateNetwork: runtime.allowPrivateNetwork,
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  );
  if (!userResponse.ok)
    throw serviceUnavailable("GitLab could not verify the authorized account");
  const user = userSchema.parse(await userResponse.json());
  const issuedAt =
    (tokens.created_at ?? Math.floor(Date.now() / 1_000)) * 1_000;
  const grant = {
    refreshToken: tokens.refresh_token,
    token: tokens.access_token,
    tokenExpiresAt: new Date(
      issuedAt + tokens.expires_in * 1_000,
    ).toISOString(),
  };
  const [existing] = await database
    .select({
      id: integrationAuthorizations.id,
      revision: integrationAuthorizations.revision,
    })
    .from(integrationAuthorizations)
    .where(
      and(
        eq(integrationAuthorizations.workspaceId, input.workspaceId),
        eq(integrationAuthorizations.provider, "gitlab"),
      ),
    )
    .limit(1);
  const id = existing?.id ?? randomUUID();
  const values = {
    credentialHint: user.username.slice(-8),
    description: `GitLab account @${user.username}`,
    disconnectedAt: null,
    encryptedPayload: encryptIntegrationCredentials(
      input.workspaceId,
      id,
      "gitlab",
      grant,
    ),
    name: user.name,
    revision: (existing?.revision ?? 0) + 1,
    scopes: [{ kind: "workspace" as const, purpose: "source" as const }],
    slug: "gitlab",
    updatedAt: new Date(),
    verificationMessage: `GitLab user ${user.username} verified`,
    verificationStatus: "verified" as const,
    verifiedAt: new Date(),
    workspaceId: input.workspaceId,
  };
  if (existing) {
    await database
      .update(integrationAuthorizations)
      .set(values)
      .where(eq(integrationAuthorizations.id, id));
  } else {
    await database.insert(integrationAuthorizations).values({
      ...values,
      id,
      provider: "gitlab",
    });
  }
  return { id, username: user.username };
}

export async function disconnectGitLabAuthorization(input: {
  workspaceId: string;
}) {
  requireActor(input.workspaceId, ["integration.manage"]);
  const database = getTowbarDatabase();
  const [authorization] = await database
    .select({ id: integrationAuthorizations.id })
    .from(integrationAuthorizations)
    .where(
      and(
        eq(integrationAuthorizations.workspaceId, input.workspaceId),
        eq(integrationAuthorizations.provider, "gitlab"),
        isNull(integrationAuthorizations.disconnectedAt),
      ),
    )
    .limit(1);
  if (!authorization) return;
  await database
    .update(integrationAuthorizations)
    .set({
      credentialHint: null,
      disconnectedAt: new Date(),
      encryptedPayload: null,
      revision: sql`${integrationAuthorizations.revision} + 1`,
      updatedAt: new Date(),
      verificationMessage: "GitLab authorization disconnected",
      verificationStatus: "unverified",
      verifiedAt: null,
    })
    .where(eq(integrationAuthorizations.id, authorization.id));
}

function attemptAssociatedData(workspaceId: string, id: string) {
  return `${workspaceId}:integration-authorization-attempt:${id}`;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
