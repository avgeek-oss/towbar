import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AccessActor,
  type Action,
  actorActions,
  actorAllows,
  isAction,
} from "@workspace/towbar-access";
import { and, eq, isNull } from "drizzle-orm";
import { users, workspaceMembers } from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { forbidden } from "../../http/errors.js";

export type QueuedActor = {
  kind: AccessActor["kind"];
  workspaceId: string;
  userId?: string;
  keyId?: string;
  source?: "github" | "gitlab" | "worker";
  grants?: string[];
};
const actorContext = new AsyncLocalStorage<AccessActor>();
export function withActor<T>(actor: AccessActor, run: () => T): T {
  return actorContext.run(actor, run);
}
export function currentActor() {
  return actorContext.getStore();
}
export function requireActor(
  workspaceId: string,
  permissions: readonly Action[],
) {
  const actor = currentActor();
  if (!actor || !actorAllows(actor, permissions, workspaceId))
    throw forbidden("This action is not permitted by your current access");
  return actor;
}
export function captureQueuedActor(
  workspaceId: string,
  permissions: readonly Action[],
) {
  const actor = requireActor(workspaceId, permissions);
  const reference: QueuedActor = {
    kind: actor.kind,
    workspaceId,
    grants: actorActions(actor),
    ...("userId" in actor ? { userId: actor.userId } : {}),
    ...("keyId" in actor ? { keyId: actor.keyId } : {}),
    ...(actor.kind === "system" ? { source: actor.source } : {}),
  };
  return {
    requestedByActor: reference,
    requestedByKeyId: "keyId" in actor ? actor.keyId : null,
  };
}
async function resolveQueuedActor(
  reference: QueuedActor | null | undefined,
): Promise<AccessActor> {
  if (
    !reference?.grants ||
    reference.grants.some((action) => !isAction(action))
  )
    throw forbidden("The operation has no valid authorization");
  if (reference.kind === "system") {
    if (!reference.source)
      throw forbidden("The operation has no system authority");
    return {
      kind: "system",
      workspaceId: reference.workspaceId,
      source: reference.source,
      grants: reference.grants.filter(isAction),
    };
  }
  let actor: AccessActor;
  if (reference.kind === "session") {
    if (!reference.userId)
      throw forbidden("The operation has no requesting user");
    const [membership] = await getTowbarDatabase()
      .select({
        role: workspaceMembers.role,
        mustChangePassword: users.mustChangePassword,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, reference.workspaceId),
          eq(users.id, reference.userId),
          isNull(users.disabledAt),
        ),
      );
    if (!membership || membership.mustChangePassword)
      throw forbidden("The requesting user no longer has access");
    actor = {
      kind: "session",
      workspaceId: reference.workspaceId,
      userId: reference.userId,
      role: membership.role,
      grants: reference.grants.filter(isAction),
    };
  } else {
    if (!reference.keyId)
      throw forbidden("The operation has no requesting API key");
    const { resolveApiKeyPrincipal } = await import("../api-keys/service.js");
    const principal = await resolveApiKeyPrincipal(reference.keyId);
    if (
      !principal ||
      principal.actor.kind !== reference.kind ||
      principal.actor.workspaceId !== reference.workspaceId ||
      (principal.actor.kind === "personal-key" &&
        principal.actor.userId !== reference.userId)
    )
      throw forbidden("The requesting API key no longer has access");
    actor = {
      ...principal.actor,
      policy: {
        ...principal.actor.policy,
        permissionMode: "scoped",
        grants: actorActions(principal.actor).filter((action) =>
          reference.grants!.includes(action),
        ),
      },
    };
  }
  return actor;
}
export async function authorizeQueuedEffect(
  reference: QueuedActor | null | undefined,
  workspaceId: string,
  permissions: readonly Action[],
) {
  const actor = await resolveQueuedActor(reference);
  if (
    !reference?.grants ||
    !permissions.every((action) => reference.grants!.includes(action)) ||
    !actorAllows(actor, permissions, workspaceId)
  )
    throw forbidden("Access changed before this operation could run");
  return actor;
}
