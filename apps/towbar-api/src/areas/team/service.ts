import { invitationAccepted } from "./invitation-email.js";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  type WorkspaceRole,
  constrainPersonalKey,
  isScope,
} from "@workspace/towbar-access";
import {
  apiKeyPolicies,
  apiKeys,
  sessions,
  transactionalEmails,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { getEnv } from "../../env.js";
import { conflict, forbidden, notFound } from "../../http/errors.js";
import {
  type AuthDatabase,
  getTowbarDatabase,
} from "../../infrastructure/database.js";
import type { AuthenticatedUser } from "../../http/types.js";
import {
  createIdentityAuth,
  getIdentityAuth,
  identityProvisioning,
} from "../auth/identity.js";
import { getNotificationProviderConfiguration } from "../notifications/configuration.js";
import { lockTeam, requireTeamAdmin } from "./authorization.js";
import { enqueueTeamEmail } from "./email-outbox.js";
export { listTeamMembers } from "./member-list.js";

export async function getTeam(user: AuthenticatedUser) {
  await requireTeamAdmin(getTowbarDatabase(), user.workspaceId, user.id);
  const [team] = await getTowbarDatabase()
    .select({
      id: workspaces.id,
      name: workspaces.name,
      description: workspaces.description,
    })
    .from(workspaces)
    .where(eq(workspaces.id, user.workspaceId));
  return team;
}
export async function updateTeam(
  user: AuthenticatedUser,
  input: { name: string; description?: string | null },
) {
  return await getTowbarDatabase().transaction(async (tx) => {
    await lockTeam(tx, user.workspaceId);
    await requireTeamAdmin(tx, user.workspaceId, user.id);
    const [team] = await tx
      .update(workspaces)
      .set({
        name: input.name.trim(),
        description: input.description?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, user.workspaceId))
      .returning({
        id: workspaces.id,
        name: workspaces.name,
        description: workspaces.description,
      });
    return team;
  });
}
export async function createTeamMember(
  user: AuthenticatedUser,
  input: { name: string; email: string; password: string; role: WorkspaceRole },
) {
  return await getTowbarDatabase().transaction(async (tx) => {
    const workspace = await lockTeam(tx, user.workspaceId);
    await requireTeamAdmin(tx, user.workspaceId, user.id);
    const email = input.email.trim().toLowerCase();
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing)
      throw conflict(
        "This email already has an account. Invite them to join instead",
      );
    const auth = createIdentityAuth(tx);
    const account = await identityProvisioning.run(
      { workspaceId: user.workspaceId, reason: "admin" },
      () =>
        auth.api.signUpEmail({
          body: { name: input.name, email, password: input.password },
        }),
    );
    await tx
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.id, account.user.id));
    const [member] = await tx
      .insert(workspaceMembers)
      .values({
        workspaceId: user.workspaceId,
        userId: account.user.id,
        role: input.role,
      })
      .returning({ id: workspaceMembers.id });
    await enqueueTeamEmail(tx, {
      workspaceId: user.workspaceId,
      recipient: email,
      template: "account-created",
      dedupeKey: `account-created:${account.user.id}`,
      data: {
        name: input.name,
        teamName: workspace.name,
        role: input.role,
        actionUrl: `${getEnv().TOWBAR_APP_BASE_URL}/login`,
      },
    });
    return { id: member!.id, userId: account.user.id };
  });
}
async function ensureAnotherAdmin(tx: AuthDatabase, workspaceId: string) {
  const [admins] = await tx
    .select({ value: count() })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, "admin"),
        isNull(users.disabledAt),
      ),
    );
  if ((admins?.value ?? 0) <= 1)
    throw conflict(
      "Keep at least one admin. Promote another member before removing your admin access",
      "LAST_ADMIN",
    );
}
export async function updateMemberRole(
  user: AuthenticatedUser,
  memberId: string,
  role: WorkspaceRole,
  name?: string,
) {
  return await getTowbarDatabase().transaction(async (tx) => {
    const workspace = await lockTeam(tx, user.workspaceId);
    await requireTeamAdmin(tx, user.workspaceId, user.id);
    const [target] = await tx
      .select({ member: workspaceMembers, user: users })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.id, memberId),
          eq(workspaceMembers.workspaceId, user.workspaceId),
        ),
      )
      .for("update");
    if (!target) throw notFound("Member");
    if (name && name !== target.user.displayName) {
      await tx
        .update(users)
        .set({ displayName: name, updatedAt: new Date() })
        .where(eq(users.id, target.user.id));
    }
    if (target.member.role === role) return { role };
    if (target.member.role === "admin" && role !== "admin")
      await ensureAnotherAdmin(tx, user.workspaceId);
    await tx
      .update(workspaceMembers)
      .set({ role })
      .where(eq(workspaceMembers.id, memberId));
    if (isRoleReduction(target.member.role, role))
      await tx.delete(sessions).where(eq(sessions.userId, target.user.id));
    const policies = await tx
      .select()
      .from(apiKeyPolicies)
      .where(
        and(
          eq(apiKeyPolicies.ownerUserId, target.user.id),
          eq(apiKeyPolicies.workspaceId, user.workspaceId),
          isNull(apiKeyPolicies.revokedAt),
        ),
      );
    for (const policy of policies) {
      const constrained = constrainPersonalKey(
        { ...policy, grants: policy.grants.filter(isScope) },
        role,
      );
      await tx
        .update(apiKeyPolicies)
        .set({
          access: constrained.access,
          includeAdmin: constrained.includeAdmin,
          grants: [...constrained.grants],
          version: policy.version + 1,
        })
        .where(eq(apiKeyPolicies.keyId, policy.keyId));
    }
    if (target.member.role === "admin" && role !== "admin")
      await revokeInviterInvitations(tx, user.workspaceId, target.user.id);
    await enqueueTeamEmail(tx, {
      workspaceId: user.workspaceId,
      recipient: target.user.email,
      template: "role-changed",
      dedupeKey: `role:${randomUUID()}`,
      data: {
        teamName: workspace.name,
        name: target.user.displayName,
        role,
        previousRole: target.member.role,
      },
    });
    return { role };
  });
}

function isRoleReduction(previous: WorkspaceRole, next: WorkspaceRole) {
  const rank: Record<WorkspaceRole, number> = {
    admin: 2,
    member: 1,
    viewer: 0,
  };
  return rank[next] < rank[previous];
}
export async function removeTeamMember(
  user: AuthenticatedUser,
  memberId: string,
) {
  await getTowbarDatabase().transaction(async (tx) => {
    const workspace = await lockTeam(tx, user.workspaceId);
    await requireTeamAdmin(tx, user.workspaceId, user.id);
    const [target] = await tx
      .select({ member: workspaceMembers, user: users })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.id, memberId),
          eq(workspaceMembers.workspaceId, user.workspaceId),
        ),
      )
      .for("update");
    if (!target) throw notFound("Member");
    if (target.member.role === "admin")
      await ensureAnotherAdmin(tx, user.workspaceId);
    const keys = await tx
      .update(apiKeyPolicies)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeyPolicies.ownerUserId, target.user.id),
          eq(apiKeyPolicies.workspaceId, user.workspaceId),
        ),
      )
      .returning({ id: apiKeyPolicies.keyId });
    for (const key of keys)
      await tx
        .update(apiKeys)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(apiKeys.id, key.id));
    await tx.delete(sessions).where(eq(sessions.userId, target.user.id));
    await tx.delete(workspaceMembers).where(eq(workspaceMembers.id, memberId));
    await revokeInviterInvitations(tx, user.workspaceId, target.user.id);
    await enqueueTeamEmail(tx, {
      workspaceId: user.workspaceId,
      recipient: target.user.email,
      template: "access-removed",
      dedupeKey: `removed:${randomUUID()}`,
      data: { teamName: workspace.name, name: target.user.displayName },
    });
  });
}
async function revokeInviterInvitations(
  tx: AuthDatabase,
  workspaceId: string,
  inviterId: string,
) {
  const revoked = await tx
    .update(workspaceInvitations)
    .set({ status: "canceled" })
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.inviterId, inviterId),
        eq(workspaceInvitations.status, "pending"),
      ),
    )
    .returning({ id: workspaceInvitations.id });
  for (const invitation of revoked)
    await cancelInvitationEmails(tx, invitation.id);
}
async function cancelInvitationEmails(tx: AuthDatabase, invitationId: string) {
  await tx
    .update(transactionalEmails)
    .set({ status: "canceled", encryptedData: null })
    .where(
      and(
        eq(transactionalEmails.invitationId, invitationId),
        inArray(transactionalEmails.status, ["pending", "sending"]),
      ),
    );
}
export async function listInvitations(user: AuthenticatedUser) {
  await requireTeamAdmin(getTowbarDatabase(), user.workspaceId, user.id);
  return await getTowbarDatabase()
    .select({
      id: workspaceInvitations.id,
      email: workspaceInvitations.email,
      role: workspaceInvitations.role,
      status: workspaceInvitations.status,
      expiresAt: workspaceInvitations.expiresAt,
      createdAt: workspaceInvitations.createdAt,
      deliveryStatus: transactionalEmails.status,
      errorCode: transactionalEmails.errorCode,
    })
    .from(workspaceInvitations)
    .leftJoin(
      transactionalEmails,
      and(
        eq(transactionalEmails.invitationId, workspaceInvitations.id),
        eq(transactionalEmails.template, "invitation"),
      ),
    )
    .where(
      and(
        eq(workspaceInvitations.workspaceId, user.workspaceId),
        eq(workspaceInvitations.status, "pending"),
        gt(workspaceInvitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(workspaceInvitations.createdAt))
    .limit(100);
}
export async function createTeamInvitation(
  user: AuthenticatedUser,
  input: { email: string; role: WorkspaceRole },
  headers: Headers,
) {
  return await getTowbarDatabase().transaction(async (tx) => {
    const workspace = await lockTeam(tx, user.workspaceId);
    await requireTeamAdmin(tx, user.workspaceId, user.id);
    const email = input.email.trim().toLowerCase();
    const [existingMember] = await tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(workspaceMembers, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(users.email, email),
          eq(workspaceMembers.workspaceId, user.workspaceId),
        ),
      )
      .limit(1);
    if (existingMember) throw conflict("This person is already a team member");
    const old = await tx
      .update(workspaceInvitations)
      .set({ status: "canceled" })
      .where(
        and(
          eq(workspaceInvitations.workspaceId, user.workspaceId),
          eq(workspaceInvitations.email, email),
          eq(workspaceInvitations.status, "pending"),
        ),
      )
      .returning({ id: workspaceInvitations.id });
    for (const invitation of old)
      await cancelInvitationEmails(tx, invitation.id);
    const invitation = await createIdentityAuth(tx).api.createInvitation({
      headers,
      body: { email, role: input.role, organizationId: user.workspaceId },
    });
    const inviteUrl = `${getEnv().TOWBAR_APP_BASE_URL}/invite/${invitation.id}`;
    await enqueueTeamEmail(tx, {
      workspaceId: user.workspaceId,
      recipient: email,
      template: "invitation",
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt,
      dedupeKey: `invite:${invitation.id}`,
      data: {
        teamName: workspace.name,
        role: input.role,
        actionUrl: inviteUrl,
      },
    });
    return { id: invitation.id, inviteUrl, expiresAt: invitation.expiresAt };
  });
}
export async function revokeInvitation(user: AuthenticatedUser, id: string) {
  await getTowbarDatabase().transaction(async (tx) => {
    await lockTeam(tx, user.workspaceId);
    await requireTeamAdmin(tx, user.workspaceId, user.id);
    const [invitation] = await tx
      .update(workspaceInvitations)
      .set({ status: "canceled" })
      .where(
        and(
          eq(workspaceInvitations.id, id),
          eq(workspaceInvitations.workspaceId, user.workspaceId),
          eq(workspaceInvitations.status, "pending"),
        ),
      )
      .returning({ id: workspaceInvitations.id });
    if (!invitation) throw notFound("Pending invitation");
    await cancelInvitationEmails(tx, id);
  });
}
async function findPendingInvitation(
  tx: AuthDatabase,
  id: string,
  lock = false,
) {
  const query = tx
    .select({ invitation: workspaceInvitations, teamName: workspaces.name })
    .from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .where(
      and(
        eq(workspaceInvitations.id, id),
        eq(workspaceInvitations.status, "pending"),
        gt(workspaceInvitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Valid invitation");
  const [inviter] = await tx
    .select({ id: users.id })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, row.invitation.workspaceId),
        eq(workspaceMembers.userId, row.invitation.inviterId),
        eq(workspaceMembers.role, "admin"),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  if (!inviter) throw notFound("Valid invitation");
  return row;
}
export async function getInvitationPreview(id: string) {
  const row = await findPendingInvitation(getTowbarDatabase(), id);
  return {
    id,
    email: row.invitation.email,
    role: row.invitation.role,
    teamName: row.teamName,
    expiresAt: row.invitation.expiresAt,
  };
}
export async function beginInvitationSignup(id: string) {
  const row = await findPendingInvitation(getTowbarDatabase(), id);
  if (
    !(await getNotificationProviderConfiguration(
      row.invitation.workspaceId,
      "smtp",
    ))
  )
    throw conflict(
      "Ask your team admin to configure email delivery before accepting this invitation",
      "SMTP_REQUIRED",
    );
  const [existing] = await getTowbarDatabase()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, row.invitation.email))
    .limit(1);
  if (existing) return { existingAccount: true };
  await identityProvisioning.run(
    {
      reason: "invite",
      workspaceId: row.invitation.workspaceId,
      invitationId: id,
    },
    () =>
      getIdentityAuth().api.sendVerificationOTP({
        body: { email: row.invitation.email, type: "sign-in" },
      }),
  );
  return { existingAccount: false };
}
export async function completeInvitationSignup(
  id: string,
  input: { name: string; code: string },
) {
  return await getTowbarDatabase().transaction(async (tx) => {
    const preview = await findPendingInvitation(tx, id);
    await lockTeam(tx, preview.invitation.workspaceId);
    const row = await findPendingInvitation(tx, id, true);
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, row.invitation.email))
      .limit(1);
    if (existing)
      throw conflict(
        "This email already has an account. Sign in to accept the invitation",
      );
    const auth = createIdentityAuth(tx);
    const response = await identityProvisioning.run(
      {
        reason: "invite",
        workspaceId: row.invitation.workspaceId,
        invitationId: id,
      },
      () =>
        auth.api.signInEmailOTP({
          body: {
            email: row.invitation.email,
            otp: input.code,
            name: input.name,
          },
          asResponse: true,
        }),
    );
    if (!response.ok) return response;
    const result = (await response.clone().json()) as { user: { id: string } };
    const headers = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    });
    await auth.api.acceptInvitation({ headers, body: { invitationId: id } });
    await tx
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.id, result.user.id));
    await cancelInvitationEmails(tx, id);
    await invitationAccepted(tx, row);
    return response;
  });
}
export async function acceptExistingInvitation(id: string, headers: Headers) {
  return await getTowbarDatabase().transaction(async (tx) => {
    const preview = await findPendingInvitation(tx, id);
    await lockTeam(tx, preview.invitation.workspaceId);
    const row = await findPendingInvitation(tx, id, true);
    const auth = createIdentityAuth(tx);
    const session = await auth.api.getSession({ headers });
    if (!session || session.user.email !== row.invitation.email)
      throw forbidden("Sign in with the email address on the invitation");
    if (!session.user.emailVerified)
      throw forbidden("Verify your email before accepting the invitation");
    await auth.api.acceptInvitation({ headers, body: { invitationId: id } });
    await cancelInvitationEmails(tx, id);
    await invitationAccepted(tx, row);
    return { accepted: true };
  });
}
