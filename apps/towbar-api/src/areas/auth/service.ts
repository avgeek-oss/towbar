import { validInstallationSetupSecret } from "./setup-secret.js";
import { passkeyEnabled } from "./passkeys.js";
import { requireRecentAuthentication } from "./recent-authentication.js";
import { and, count, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { isWorkspaceRole, roleActions } from "@workspace/towbar-access";
import type { DateTimePreferences } from "@workspace/towbar-core/date-time";
import {
  authAccounts,
  authPasskeys,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { conflict, forbidden, unauthorized } from "../../http/errors.js";
import { recordAuditEvent } from "../../infrastructure/audit.js";
import {
  type AuthDatabase,
  getTowbarDatabase,
} from "../../infrastructure/database.js";
import {
  createIdentityAuth,
  getIdentityAuth,
  identityProvisioning,
} from "./identity.js";
import { enqueueIdentityEmail } from "../team/email-outbox.js";

export async function getInitialSetupStatus() {
  const [workspace] = await getTowbarDatabase()
    .select({ count: count() })
    .from(workspaces);
  return { setupRequired: !workspace?.count };
}
export async function createInitialAdmin(input: {
  setupSecret: string;
  teamName: string;
  displayName: string;
  email: string;
  password: string;
  dateTimePreferences?: DateTimePreferences;
}) {
  if (!validInstallationSetupSecret(input.setupSecret))
    throw forbidden("The installation setup secret is incorrect");
  const email = input.email.trim().toLowerCase();
  await getTowbarDatabase().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('towbar-initial-setup'))`,
    );
    const [existingWorkspace] = await tx
      .select({ count: count() })
      .from(workspaces);
    if (existingWorkspace?.count)
      throw conflict(
        "Towbar setup has already been completed",
        "SETUP_COMPLETED",
      );
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: input.teamName.trim(), slug: "towbar" })
      .returning({ id: workspaces.id });
    if (!workspace) throw new Error("Unable to create team");
    const auth = createIdentityAuth(tx);
    const result = await identityProvisioning.run(
      { reason: "setup", workspaceId: workspace.id },
      () =>
        auth.api.signUpEmail({
          body: {
            name: input.displayName.trim(),
            email,
            password: input.password,
          },
        }),
    );
    if (input.dateTimePreferences)
      await tx
        .update(users)
        .set({ dateTimePreferences: input.dateTimePreferences })
        .where(eq(users.id, result.user.id));
    await tx.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: result.user.id,
      role: "admin",
    });
  });
  const response = await getIdentityAuth().api.signInEmail({
    body: { email, password: input.password },
    asResponse: true,
  });
  await recordSuccessfulSignIn(getTowbarDatabase(), response);
  return response;
}
export async function authenticatePassword(
  input: { email: string; password: string },
  headers?: Headers,
) {
  const email = input.email.trim().toLowerCase();
  return await getTowbarDatabase().transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .for("update");
    const response = await createIdentityAuth(tx).api.signInEmail({
      body: { email, password: input.password },
      headers,
      asResponse: true,
    });
    await recordSuccessfulSignIn(tx, response);
    return response;
  });
}

export async function recordSuccessfulSignIn(
  database: AuthDatabase,
  response: Response,
) {
  if (!response.ok) return;
  const body = (await response.clone().json()) as {
    twoFactorRedirect?: boolean;
    user?: { id?: string };
  };
  const userId = body.twoFactorRedirect ? undefined : body.user?.id;
  if (!userId) return;
  const [membership] = await database
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  if (!membership) return;
  await recordAuditEvent(database, {
    workspaceId: membership.workspaceId,
    actorKind: "session",
    actorUserId: userId,
    action: "account.signed-in",
    targetType: "account",
    targetId: userId,
  });
}
export async function getUserIdentity(userId: string) {
  const [identity] = await getTowbarDatabase()
    .select({
      passwordSetupRequired: sql<boolean>`not exists (select 1 from ${authAccounts} where ${authAccounts.userId} = ${users.id} and ${authAccounts.providerId} = 'credential' and ${authAccounts.password} is not null)`,
      email: users.email,
      id: users.id,
      name: users.displayName,
      dateTimePreferences: users.dateTimePreferences,
      emailVerified: users.emailVerified,
      mustChangePassword: users.mustChangePassword,
      twoFactorEnabled: passkeyEnabled,
      workspaceRole: workspaceMembers.role,
      workspaceId: workspaces.id,
      teamName: workspaces.name,
    })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  if (!identity || !isWorkspaceRole(identity.workspaceRole)) return null;
  return {
    ...identity,
    capabilities: identity.mustChangePassword
      ? (["personal.manage"] as const)
      : roleActions(identity.workspaceRole),
  };
}
export async function findSession(headers: Headers) {
  const session = await getIdentityAuth().api.getSession({ headers });
  if (!session) return null;
  const user = await getUserIdentity(session.user.id);
  if (!user) return null;
  return { sessionId: session.session.id, user };
}
export async function listUserSessions(userId: string) {
  return await getTowbarDatabase()
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.updatedAt,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.updatedAt));
}
export async function revokeUserSession(input: {
  currentSessionId: string | null;
  sessionId: string;
  userId: string;
}) {
  if (input.currentSessionId === input.sessionId)
    throw unauthorized("Use sign out to revoke the current session");
  await getTowbarDatabase()
    .delete(sessions)
    .where(
      and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId)),
    );
}
export async function updateProfile(input: {
  displayName: string;
  userId: string;
}) {
  const [user] = await getTowbarDatabase()
    .update(users)
    .set({ displayName: input.displayName.trim(), updatedAt: new Date() })
    .where(eq(users.id, input.userId))
    .returning({ email: users.email, id: users.id, name: users.displayName });
  return user;
}
export async function changePassword(input: {
  headers: Headers;
  currentPassword?: string;
  newPassword: string;
  userId: string;
}): Promise<Headers> {
  return await getTowbarDatabase().transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    const auth = createIdentityAuth(tx);
    const [credential] = await tx
      .select({ password: authAccounts.password })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, input.userId),
          eq(authAccounts.providerId, "credential"),
        ),
      )
      .limit(1);
    let responseHeaders = new Headers();
    const [key] = await tx
      .select({ id: authPasskeys.id })
      .from(authPasskeys)
      .where(eq(authPasskeys.userId, input.userId))
      .limit(1);
    if (credential?.password && key) {
      const session = await auth.api.getSession({ headers: input.headers });
      if (!session || session.user.id !== input.userId)
        throw forbidden("Sign in to continue");
      await requireRecentAuthentication(input.userId, session.session.id);
      await tx
        .update(authAccounts)
        .set({
          password: await (
            await auth.$context
          ).password.hash(input.newPassword),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(authAccounts.userId, input.userId),
            eq(authAccounts.providerId, "credential"),
          ),
        );
      await tx
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, input.userId),
            ne(sessions.id, session.session.id),
          ),
        );
    } else if (credential?.password) {
      if (!input.currentPassword)
        throw unauthorized("Enter your current password");
      const result = await auth.api.changePassword({
        headers: input.headers,
        body: {
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
          revokeOtherSessions: true,
        },
        returnHeaders: true,
      });
      responseHeaders = result.headers;
    } else {
      const session = await auth.api.getSession({ headers: input.headers });
      if (!session?.user.emailVerified || session.user.id !== input.userId)
        throw forbidden("Verify your email before choosing a password");
      const result = await auth.api.setPassword({
        headers: input.headers,
        body: { newPassword: input.newPassword },
        returnHeaders: true,
      });
      responseHeaders = result.headers;
    }
    await tx
      .update(users)
      .set({ mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, input.userId));
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, input.userId));
    if (user)
      await enqueueIdentityEmail(tx, {
        userId: user.id,
        email: user.email,
        name: user.displayName,
        template: "password-changed",
      });
    return responseHeaders;
  });
}
export { resetAdminPassword } from "./operator-recovery.js";
