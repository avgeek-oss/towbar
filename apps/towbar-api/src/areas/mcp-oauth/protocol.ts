import { scopes as oauthScopes } from "@workspace/towbar-access";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getEnv } from "../../env.js";

export const tokenLifetimeSeconds = 30 * 86400;
export { scopes as oauthScopes } from "@workspace/towbar-access";
export const oauthIssuer = () =>
  getEnv().TOWBAR_API_BASE_URL.replace(/\/$/, "");
export const mcpResource = () => `${oauthIssuer()}/v1/mcp`;
export const resourceMetadataUrl = () =>
  `${oauthIssuer()}/.well-known/oauth-protected-resource/v1/mcp`;
export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
export function equalSecret(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 = 400,
  ) {
    super(message);
  }
}
export function validRedirectUri(raw: string) {
  try {
    const url = new URL(raw);
    return (
      !url.username &&
      !url.password &&
      !raw.includes("#") &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export const clientMetadataSchema = z.object({
  client_name: z.string().trim().min(1).max(120).default("Unknown MCP client"),
  redirect_uris: z
    .array(z.string().max(2048).refine(validRedirectUri))
    .min(1)
    .max(20),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_basic", "client_secret_post"])
    .default("client_secret_basic"),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .min(1)
    .max(2)
    .refine((types) => types.includes("authorization_code"))
    .default(["authorization_code"]),
  response_types: z.array(z.literal("code")).length(1).default(["code"]),
});
export function parseScope(value = "viewer") {
  const scopes = [...new Set(value.split(" "))];
  if (
    !scopes.length ||
    scopes.some((s) => !oauthScopes.some((scope) => scope === s))
  )
    throw new OAuthError(
      "invalid_scope",
      "Supported scopes are viewer, member and admin",
    );
  if (scopes.includes("admin")) return "viewer member admin";
  return scopes.includes("member") ? "viewer member" : "viewer";
}
export function oauthKeyPermissions(scope: string) {
  const scopes = scope.split(" ");
  return {
    access: scopes.includes("member") ? ("edit" as const) : ("read" as const),
    includeAdmin: scopes.includes("admin"),
  };
}
export function requireResource(value: string | undefined) {
  let resource: string | undefined;
  try {
    resource = value ? new URL(value).href : undefined;
  } catch {
    /* Invalid URLs follow the same invalid_target response. */
  }
  if (resource !== mcpResource())
    throw new OAuthError(
      "invalid_target",
      "The resource must be this Towbar MCP endpoint",
    );
}
export function uniqueParameters(params: URLSearchParams) {
  for (const key of params.keys())
    if (params.getAll(key).length !== 1)
      throw new OAuthError("invalid_request", `Repeated parameter: ${key}`);
  return Object.fromEntries(params);
}
export function authorizationResponse(
  request: { redirectUri: string; state: string | null },
  result: { code: string } | { error: string },
) {
  const url = new URL(request.redirectUri);
  for (const [key, value] of Object.entries(result))
    url.searchParams.set(key, value);
  if (request.state !== null) url.searchParams.set("state", request.state);
  url.searchParams.set("iss", oauthIssuer());
  return url.href;
}
