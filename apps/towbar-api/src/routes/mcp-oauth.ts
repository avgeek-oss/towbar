import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  authenticateClient,
  registerClient,
} from "../areas/mcp-oauth/clients.js";
import {
  beginAuthorization,
  consentDetails,
  decideConsent,
  exchangeCode,
  revokeOAuthToken,
} from "../areas/mcp-oauth/service.js";
import {
  OAuthError,
  mcpResource,
  oauthIssuer,
  oauthScopes,
  uniqueParameters,
} from "../areas/mcp-oauth/protocol.js";
import { externalRateLimit } from "../http/api-authentication.js";
import {
  requireAuthenticatedUser,
  requireTrustedMutationOrigin,
} from "../http/authentication.js";
import { requireHttpsExternalAccess } from "../http/external-access.js";
import { sessionUser } from "../http/session-user.js";
import { normalizeError } from "../http/error-response.js";
import type { TowbarHonoEnvironment } from "../http/types.js";
import { getAllowedOrigins, getEnv } from "../env.js";

export const mcpOAuthRoutes = new Hono<TowbarHonoEnvironment>();
for (const path of ["/.well-known/*", "/v1/oauth/*"]) {
  mcpOAuthRoutes.use(path, requireHttpsExternalAccess);
  mcpOAuthRoutes.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  mcpOAuthRoutes.use(
    path,
    bodyLimit({
      maxSize: 16384,
      onError: (c) =>
        c.json(
          {
            error: "invalid_request",
            error_description: "Request is too large",
          },
          413,
        ),
    }),
  );
}
mcpOAuthRoutes.onError((error, c) => {
  if (error instanceof OAuthError) {
    if (error.status === 401)
      c.header("WWW-Authenticate", 'Basic realm="Towbar OAuth"');
    return c.json(
      {
        error: error.code,
        error_description: error.message,
        code: error.code,
        message: error.message,
      },
      error.status,
    );
  }
  const normalized = normalizeError(error);
  for (const [name, value] of Object.entries(normalized.headers ?? {}))
    c.header(name, value);
  if (normalized.status >= 500) console.error(error);
  return c.json(
    {
      error:
        normalized.status === 401
          ? "login_required"
          : normalized.status === 403
            ? "access_denied"
            : "server_error",
      error_description: normalized.message,
      code: normalized.code,
      message: normalized.message,
    },
    normalized.status,
  );
});

const discoveryCors = cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] });
mcpOAuthRoutes.use("/.well-known/*", discoveryCors);
mcpOAuthRoutes.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: oauthIssuer(),
    authorization_endpoint: `${oauthIssuer()}/v1/oauth/authorize`,
    token_endpoint: `${oauthIssuer()}/v1/oauth/token`,
    registration_endpoint: `${oauthIssuer()}/v1/oauth/register`,
    revocation_endpoint: `${oauthIssuer()}/v1/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: oauthScopes,
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    revocation_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }),
);
for (const path of [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/v1/mcp",
])
  mcpOAuthRoutes.get(path, (c) =>
    c.json({
      resource: mcpResource(),
      authorization_servers: [oauthIssuer()],
      scopes_supported: oauthScopes,
      bearer_methods_supported: ["header"],
      resource_name: "Towbar MCP",
    }),
  );
for (const path of [
  "/v1/oauth/register",
  "/v1/oauth/token",
  "/v1/oauth/revoke",
])
  mcpOAuthRoutes.use(
    path,
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );
mcpOAuthRoutes.use(
  "/v1/oauth/consent/:id",
  cors({
    origin: (origin) => (getAllowedOrigins().has(origin) ? origin : ""),
    credentials: true,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);
mcpOAuthRoutes.use("/v1/oauth/*", externalRateLimit);
mcpOAuthRoutes.post("/v1/oauth/register", async (c) => {
  if (!c.req.header("content-type")?.startsWith("application/json"))
    throw new OAuthError("invalid_request", "Use application/json");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new OAuthError("invalid_request", "Invalid JSON");
  }
  return c.json(await registerClient(body), 201);
});
mcpOAuthRoutes.get("/v1/oauth/authorize", async (c) => {
  const result = await beginAuthorization(
    uniqueParameters(new URL(c.req.url).searchParams),
  );
  return c.redirect(
    result.redirectTo ??
      `${getEnv().TOWBAR_APP_BASE_URL}/oauth/consent?request=${result.requestId}`,
    302,
  );
});
mcpOAuthRoutes.use(
  "/v1/oauth/consent/:id",
  requireAuthenticatedUser,
  requireTrustedMutationOrigin,
);
mcpOAuthRoutes.get("/v1/oauth/consent/:id", async (c) => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success)
    throw new OAuthError("invalid_request", "Invalid authorization request");
  const user = sessionUser(c);
  return c.json({
    ...(await consentDetails(id.data)),
    user: {
      name: user.name,
      email: user.email,
      teamName: user.teamName,
      role: user.workspaceRole,
      twoFactorEnabled: user.twoFactorEnabled === true,
    },
  });
});
mcpOAuthRoutes.post("/v1/oauth/consent/:id", async (c) => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success)
    throw new OAuthError("invalid_request", "Invalid authorization request");
  if (!c.req.header("content-type")?.startsWith("application/json"))
    throw new OAuthError("invalid_request", "Use application/json");
  const body = z
    .discriminatedUnion("allow", [
      z.strictObject({
        allow: z.literal(true),
        accessLevel: z.enum(["read", "write", "admin"]),
      }),
      z.strictObject({ allow: z.literal(false) }),
    ])
    .safeParse(await c.req.json());
  if (!body.success)
    throw new OAuthError("invalid_request", "Choose whether to allow access");
  return c.json({
    redirectTo: await decideConsent(
      id.data,
      sessionUser(c),
      body.data.allow,
      c.get("currentSessionId"),
      body.data.allow ? body.data.accessLevel : undefined,
    ),
  });
});
async function readForm(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new OAuthError(
      "invalid_request",
      "Use application/x-www-form-urlencoded",
    );
  return uniqueParameters(new URLSearchParams(await request.text()));
}
mcpOAuthRoutes.post("/v1/oauth/token", async (c) => {
  const params = await readForm(c.req.raw);
  const client = await authenticateClient(
    params,
    c.req.header("authorization"),
  );
  return c.json(await exchangeCode(client.id, params));
});
mcpOAuthRoutes.post("/v1/oauth/revoke", async (c) => {
  const params = await readForm(c.req.raw);
  const client = await authenticateClient(
    params,
    c.req.header("authorization"),
  );
  if (!params.token)
    throw new OAuthError("invalid_request", "A token is required");
  await revokeOAuthToken(client.id, params.token);
  return c.body(null, 200);
});
