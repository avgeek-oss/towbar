import { type Scope, actorAllows } from "@workspace/towbar-access";
import { resolveApiKeyPrincipal } from "../areas/api-keys/service.js";
import { findSession } from "../areas/auth/service.js";
import type { Context } from "hono";
import type { TowbarHonoEnvironment } from "./types.js";
export async function streamStillAuthorized(
  context: Context<TowbarHonoEnvironment>,
  permissions: readonly Scope[],
) {
  const workspaceId = context.get("actor").workspaceId;
  const key = context.get("apiKey");
  if (key) {
    const principal = await resolveApiKeyPrincipal(key.id);
    const allowed =
      principal && actorAllows(principal.actor, permissions, workspaceId);
    if (allowed) {
      context.set("user", principal.user);
      context.set("actor", principal.actor);
    }
    return allowed;
  }
  const identity = await findSession(context.req.raw.headers);
  if (identity) context.set("user", identity.user);
  return (
    identity &&
    !identity.user.mustChangePassword &&
    actorAllows(
      {
        kind: "session",
        userId: identity.user.id,
        role: identity.user.workspaceRole,
        workspaceId: identity.user.workspaceId,
      },
      permissions,
      workspaceId,
    )
  );
}
