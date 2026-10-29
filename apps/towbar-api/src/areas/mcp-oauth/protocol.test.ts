import assert from "node:assert/strict";
import test from "node:test";
import {
  clientMetadataSchema,
  digest,
  equalSecret,
  parseScope,
  uniqueParameters,
  validRedirectUri,
} from "./protocol.js";
import {
  clientLogo,
  fetchClientDocument,
  metadataDocumentUrl,
  parseClientDocument,
} from "./clients.js";

void test("OAuth redirects, scopes, and parameters are validated without trusting client labels", () => {
  for (const value of [
    "https://client.example/callback",
    "http://127.0.0.1:4312/callback",
    "http://[::1]:123/callback",
    "http://localhost:345/cb",
  ])
    assert(validRedirectUri(value), value);
  for (const value of [
    "http://client.example/cb",
    "https://user:password@client.example/cb",
    "javascript:alert(1)",
    "https://client.example/cb#fragment",
    "https://client.example/cb#",
    "http://127.0.0.2/cb",
    "//client.example/cb",
  ])
    assert(!validRedirectUri(value), value);
  assert.equal(parseScope(), "viewer");
  assert.equal(parseScope("member"), "viewer member");
  assert.equal(parseScope("admin"), "viewer member admin");
  assert.equal(parseScope("admin viewer admin"), "viewer member admin");
  assert.throws(() => parseScope("mcp:unknown"));
  assert.throws(() =>
    uniqueParameters(new URLSearchParams("client_id=a&client_id=b")),
  );
  assert(
    !clientMetadataSchema.safeParse({
      redirect_uris: ["https://client.example/cb"],
      grant_types: ["client_credentials"],
    }).success,
  );
  assert.equal(equalSecret(digest("a"), digest("b")), false);
});
void test("CIMD identity binds to the exact HTTPS document and never a claimed brand name", async () => {
  const id = "https://client.example/oauth.json";
  const metadata = {
    client_id: id,
    client_name: "Claude",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: ["http://localhost:4312/cb"],
  };
  const longId = `https://client.example/${"a".repeat(150)}/oauth.json`;
  assert.equal(
    parseClientDocument(longId, { ...metadata, client_id: longId }).id,
    longId,
  );
  const client = parseClientDocument(id, metadata);
  assert.equal(client.name, "Claude");
  assert.equal(client.trust, "metadata-document");
  assert.equal(client.logo, null);
  assert.equal(clientLogo("claude.ai.attacker.example"), null);
  assert.equal(clientLogo("claude.ai"), "claude");
  assert.throws(() =>
    parseClientDocument(id, {
      ...metadata,
      client_id: "https://other.example/oauth.json",
    }),
  );
  assert.throws(() =>
    parseClientDocument(id, {
      ...metadata,
      token_endpoint_auth_method: "private_key_jwt",
    }),
  );
  for (const value of [
    "http://client.example/oauth.json",
    "https://client.example/",
    "https://127.0.0.1/oauth.json",
    "https://[::1]/oauth.json",
    "https://client.example/oauth.json#fragment",
  ])
    assert.throws(() => metadataDocumentUrl(value));
  await assert.rejects(fetchClientDocument("https://localhost/oauth.json"));
});
