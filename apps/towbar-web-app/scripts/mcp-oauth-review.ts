import { createServer } from "node:http";
import { createFixtureApiServer } from "./fixture-api.ts";
import { fixtureJson } from "./fixture-localization.ts";

// Local visual review only: no OAuth credentials are created or exchanged.
const fixture = createFixtureApiServer({
  authState: process.argv.includes("--signed-out")
    ? "signed-out"
    : "authenticated",
});
const fixtureHandler = fixture.listeners("request")[0]!;
const host = process.argv.includes("--ipv4") ? "127.0.0.1" : "::1";
const empty = process.argv.includes("--empty-keys");
const createdAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
const baseKey = {
  scope: "personal",
  access: "read",
  includeAdmin: false,
  grants: ["viewer"],
  prefix: "twb_review",
  ownerUserId: "review-user",
  createdAt,
  expiresAt,
  lastUsedAt: null,
  revokedAt: null,
};
const keys = [
  {
    ...baseKey,
    id: "review-chatgpt",
    name: "ChatGPT",
    tokenType: "mcp-oauth",
    oauthClientName: "ChatGPT",
    oauthClientLogo: "openai",
    oauthClientId: "https://chatgpt.com/mcp/client.json",
    oauthClientTrust: "metadata-document",
  },
  {
    ...baseKey,
    id: "review-unknown",
    name: "Desktop assistant",
    tokenType: "mcp-oauth",
    oauthClientName: "Desktop assistant",
    oauthClientLogo: null,
    oauthClientId: "review-unverified-app",
    oauthClientTrust: "unverified",
  },
  {
    ...baseKey,
    id: "review-legacy",
    name: "CI automation",
    tokenType: "api-key",
    expiresAt: null,
  },
];
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost:4420");
  if (req.headers.origin === "http://localhost:4038") {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const send = (body: unknown, status = 200) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(fixtureJson(res, body));
  };
  if (url.pathname.startsWith("/v1/oauth/consent/")) {
    const state = url.pathname.split("/").at(-1);
    if (state === "expired")
      return send(
        {
          error_description:
            "This connection link has expired or was already used. Start again from your app.",
        },
        400,
      );
    if (state === "signed-out") return send({}, 401);
    if (
      req.method === "POST" &&
      (state === "admin-stale" || state === "admin-passkey")
    )
      return send(
        {
          error: "access_denied",
          code: "REAUTHENTICATION_REQUIRED",
          message: "Confirm your identity to continue",
        },
        403,
      );
    if (req.method === "POST")
      return send(
        {
          error_description:
            "Review fixture: no access was granted. Start again from your app.",
        },
        400,
      );
    const unknown = state === "unknown";
    return send({
      clientName: unknown ? "Desktop assistant" : "ChatGPT",
      clientId: unknown
        ? "review-unverified-app"
        : "https://chatgpt.com/mcp/client.json",
      clientLogo: unknown ? null : "openai",
      clientTrust: unknown ? "unverified" : "metadata-document",
      redirectUri: unknown
        ? "http://127.0.0.1:51873/callback"
        : "https://chatgpt.com/connector/oauth/callback",
      scope:
        state === "admin" ||
        state === "admin-stale" ||
        state === "admin-member" ||
        state === "admin-viewer" ||
        state === "admin-passkey"
          ? "viewer member admin"
          : state === "edit" || state === "viewer"
            ? "viewer member"
            : "viewer",
      user: {
        name: "Alex Morgan",
        email: "alex@example.com",
        teamName: "Example workspace",
        role:
          state === "viewer" || state === "admin-viewer"
            ? "viewer"
            : state === "admin-member"
              ? "member"
              : "admin",
        twoFactorEnabled: state === "admin-passkey",
      },
    });
  }
  if (
    url.pathname === "/v1/core/settings/api-keys/personal" &&
    req.method === "GET"
  ) {
    return send({
      keys: empty ? [] : keys,
      apiUrl: "https://towbar-api.example/v1/api",
      mcpUrl: "https://towbar-api.example/v1/mcp",
      rateLimit: { requests: 60, windowSeconds: 60 },
    });
  }
  if (
    url.pathname.startsWith("/v1/core/settings/api-keys/personal/") &&
    req.method === "DELETE"
  ) {
    const index = keys.findIndex(
      (key) => key.id === url.pathname.split("/").at(-1),
    );
    if (index < 0) return send({ error: { message: "Key not found" } }, 404);
    keys.splice(index, 1);
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname.startsWith("/v1/")) {
    delete req.headers.origin;
    fixtureHandler(req, res);
    return;
  }
  res.writeHead(404);
  res.end("API review fixture: open the dashboard on http://localhost:4038");
});
server.listen(4420, host, () =>
  console.info(
    "OAuth API fixture: http://localhost:4420; dashboard: http://localhost:4038/oauth/consent?request=review",
  ),
);
