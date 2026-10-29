import assert from "node:assert/strict";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { createApp } from "../../app.js";
import { connectTestMcpClient } from "../external-api/scout-access-test-helper.js";

export async function assertSdkOAuthFlow(
  app: ReturnType<typeof createApp>,
  origin: string,
  sessionHeaders: Headers,
) {
  let information: OAuthClientInformationMixed | undefined,
    tokens: OAuthTokens | undefined,
    verifier = "",
    authorization: URL | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:4312/sdk-callback",
    clientMetadata: {
      client_name: "SDK test",
      redirect_uris: ["http://127.0.0.1:4312/sdk-callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    clientInformation: () => information,
    saveClientInformation: (value) => {
      information = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
    redirectToAuthorization: (url) => {
      authorization = url;
    },
    state: () => "sdk-state",
  };
  const options = {
    serverUrl: `${origin}/v1/mcp`,
    fetchFn: async (input: string | URL | Request, init?: RequestInit) =>
      app.fetch(new Request(input, init)),
  };
  assert.equal(await auth(provider, options), "REDIRECT");
  assert(authorization);
  const browser = await app.fetch(new Request(authorization));
  assert.equal(browser.status, 302);
  const id = new URL(browser.headers.get("location")!).searchParams.get(
    "request",
  )!;
  const headers = new Headers(sessionHeaders);
  headers.set("Content-Type", "application/json");
  const approval = await app.request(`/v1/oauth/consent/${id}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ allow: true, accessLevel: "read" }),
  });
  assert.equal(approval.status, 200, await approval.clone().text());
  const callback = new URL(
    ((await approval.json()) as { redirectTo: string }).redirectTo,
  );
  assert.equal(callback.searchParams.get("iss"), origin);
  assert.equal(callback.searchParams.get("state"), "sdk-state");
  assert.equal(
    await auth(provider, {
      ...options,
      authorizationCode: callback.searchParams.get("code")!,
    }),
    "AUTHORIZED",
  );
  assert(tokens);
  assert.equal(tokens.expires_in, 2592000);
  assert.equal(tokens.refresh_token, undefined);
  const client = await connectTestMcpClient(tokens.access_token, (request) =>
    app.fetch(request),
  );
  try {
    assert((await client.listTools()).tools.length > 0);
  } finally {
    await client.close();
  }
}

export async function assertOAuthDiscovery(
  app: ReturnType<typeof createApp>,
  origin: string,
  resource: string,
) {
  const challenge = await app.request("/v1/mcp");
  assert.equal(challenge.status, 401);
  assert.match(
    challenge.headers.get("www-authenticate")!,
    /resource_metadata=.*oauth-protected-resource\/v1\/mcp/,
  );
  for (const path of [
    "/.well-known/oauth-protected-resource/v1/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    const response = await app.request(path);
    const metadata = (await response.json()) as {
      resource: string;
      scopes_supported: string[];
    };
    assert.equal(metadata.resource, resource);
    assert.deepEqual(metadata.scopes_supported, ["viewer", "member", "admin"]);
  }
  const response = await app.request("/.well-known/oauth-authorization-server");
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.issuer, origin);
  assert.equal(body.client_id_metadata_document_supported, true);
  assert.equal(body.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(body.grant_types_supported, ["authorization_code"]);
  assert.deepEqual(body.scopes_supported, ["viewer", "member", "admin"]);
}
