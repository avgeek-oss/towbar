import assert from "node:assert/strict";
import { registerClient } from "./clients.js";
import { beginAuthorization, decideConsent, exchangeCode } from "./service.js";
import { digest, mcpResource, secret } from "./protocol.js";
import { findApiKey } from "../api-keys/service.js";
import type { AuthenticatedUser } from "../../http/types.js";

export async function issueTestMcpToken(
  user: AuthenticatedUser,
  access: "read" | "edit",
  accessLevel: "read" | "write" | "admin" = access === "edit"
    ? "write"
    : "read",
  sessionId: string | null = null,
) {
  const redirect = "http://127.0.0.1:4312/callback";
  const client = await registerClient({
    client_name: "Integration client",
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
  });
  const verifier = secret();
  const params = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    resource: mcpResource(),
    scope: access === "edit" ? "viewer member" : "viewer",
    code_challenge: digest(verifier),
    code_challenge_method: "S256",
  };
  const started = await beginAuthorization(params);
  assert(started.requestId);
  const callback = new URL(
    await decideConsent(started.requestId, user, true, sessionId, accessLevel),
  );
  const issued = await exchangeCode(client.client_id, {
    ...params,
    grant_type: "authorization_code",
    code: callback.searchParams.get("code")!,
    code_verifier: verifier,
  });
  assert(issued.access_token);
  const principal = await findApiKey(issued.access_token);
  assert(principal);
  return {
    token: issued.access_token,
    key: principal.key,
    actor: principal.actor,
  };
}
