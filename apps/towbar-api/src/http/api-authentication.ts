import {
  mcpResource,
  resourceMetadataUrl,
} from "../areas/mcp-oauth/protocol.js";
import { findApiKey } from "../areas/api-keys/service.js";
import { getEnv } from "../env.js";
import { HttpError, forbidden, unauthorized } from "./errors.js";
import { getClientAddress, incrementPersistentBucket } from "./rate-limit.js";
import type { MiddlewareHandler } from "hono";
import type { TowbarHonoEnvironment } from "./types.js";

export const externalRateLimit: MiddlewareHandler<
  TowbarHonoEnvironment
> = async (context, next) => {
  const env = getEnv();
  const now = new Date();
  const bucket = await incrementPersistentBucket(
    `api-address:${getClientAddress(context)}`,
    now,
    env.TOWBAR_API_RATE_LIMIT_WINDOW_SECONDS * 1000,
  );
  const retryAfter = Math.max(
    1,
    Math.ceil((bucket.expiresAt.getTime() - now.getTime()) / 1000),
  );
  context.header("X-RateLimit-Limit", String(env.TOWBAR_API_RATE_LIMIT_MAX));
  context.header(
    "X-RateLimit-Remaining",
    String(Math.max(0, env.TOWBAR_API_RATE_LIMIT_MAX - bucket.attempts)),
  );
  context.header(
    "X-RateLimit-Reset",
    String(Math.ceil(bucket.expiresAt.getTime() / 1000)),
  );
  context.header("Cache-Control", "no-store");
  if (bucket.attempts > env.TOWBAR_API_RATE_LIMIT_MAX)
    throw new HttpError(
      429,
      "RATE_LIMITED",
      "Too many API or MCP requests. Try again later",
      { responseHeaders: { "Retry-After": String(retryAfter) } },
    );
  await next();
};
function requireExternalToken(
  surface: "api" | "mcp",
): MiddlewareHandler<TowbarHonoEnvironment> {
  return async (context, next) => {
    // Browsers must come from the configured control plane. CLI clients have no Origin.
    const origin = context.req.header("origin");
    if (origin && origin !== new URL(getEnv().TOWBAR_APP_BASE_URL).origin)
      throw forbidden("Request origin is not allowed");
    const match = /^Bearer ([^\s]+)$/i.exec(
      context.req.header("authorization") ?? "",
    );
    const identity = match ? await findApiKey(match[1]!) : null;
    if (
      !identity ||
      identity.key.tokenType !==
        (surface === "mcp" ? "mcp-oauth" : "api-key") ||
      (surface === "mcp" && identity.key.resource !== mcpResource())
    ) {
      context.header(
        "WWW-Authenticate",
        surface === "mcp"
          ? `Bearer resource_metadata="${resourceMetadataUrl()}", scope="read"${match ? ', error="invalid_token"' : ""}`
          : 'Bearer realm="Towbar"',
      );
      throw unauthorized(
        surface === "mcp"
          ? "Sign in to Towbar to authorize this MCP connection"
          : "Provide a valid, unexpired Towbar API key",
      );
    }
    context.set("user", identity.user);
    context.set("actor", identity.actor);
    context.set("apiKey", identity.key);
    // A bearer client has no browser session; password changes revoke all browser sessions.
    context.set("currentSessionId", null);
    if (
      surface === "api" &&
      identity.key.access === "read" &&
      !["GET", "HEAD"].includes(context.req.method) &&
      !(
        context.req.method === "POST" &&
        [
          "/v1/api/logs/query",
          "/v1/api/logs/summary",
          "/v1/api/logs/context",
          "/v1/api/logs/tail",
          "/v1/api/logs/follow",
        ].includes(context.req.path)
      )
    )
      throw forbidden("This key has read-only access");
    await next();
  };
}

export const requireRestApiKey = requireExternalToken("api");
export const requireMcpOAuth = requireExternalToken("mcp");
