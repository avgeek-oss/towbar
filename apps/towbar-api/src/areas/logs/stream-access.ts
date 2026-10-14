import { and, eq, gt, isNull } from "drizzle-orm";
import type { AccessActor } from "@workspace/towbar-access";
import {
  sessions,
  users,
  workspaceMembers,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { unauthorized } from "../../http/errors.js";
import { resolveApiKeyPrincipal } from "../api-keys/service.js";

export async function refreshLogStreamActor(
  actor: AccessActor,
  sessionId: string | null,
): Promise<AccessActor> {
  if (actor.kind === "personal-key" || actor.kind === "team-key") {
    const principal = await resolveApiKeyPrincipal(actor.keyId);
    if (!principal || principal.actor.workspaceId !== actor.workspaceId)
      throw unauthorized("This logging connection was revoked.");
    return principal.actor;
  }
  if (actor.kind !== "session" || !sessionId)
    throw unauthorized("A current session is required.");
  const [membership] = await getTowbarDatabase()
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .innerJoin(sessions, eq(sessions.userId, users.id))
    .where(
      and(
        eq(workspaceMembers.workspaceId, actor.workspaceId),
        eq(users.id, actor.userId),
        eq(sessions.id, sessionId),
        gt(sessions.expiresAt, new Date()),
        isNull(users.disabledAt),
        eq(users.mustChangePassword, false),
      ),
    );
  if (!membership) throw unauthorized("Your logging session ended.");
  return { ...actor, role: membership.role };
}
