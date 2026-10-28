import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";
import {
  apiKeyPolicies,
  apiKeys,
  authAccounts,
  authPasskeys,
  authRecoveryCodes,
  authVerifications,
  emailChanges,
  sessions,
  transactionalEmails,
  users,
  workspaceMembers,
} from "@workspace/towbar-database/schema";
import { badRequest, conflict } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueueIdentityEmail } from "../team/email-outbox.js";

const emailSchema = z.string().trim().toLowerCase().email().max(320);

export async function resetAdminPassword(input: {
  email: string;
  temporaryPassword: string;
  newEmail?: string;
  resetMfa?: boolean;
  removePasskeys?: boolean;
}) {
  if (
    input.temporaryPassword.length < 15 ||
    input.temporaryPassword.length > 1024
  )
    throw badRequest("Use a password between 15 and 1,024 characters");
  return recoverAccount({
    ...input,
    adminOnly: true,
    password: await hashPassword(input.temporaryPassword),
  });
}

export async function resetUserMfa(input: {
  email: string;
  removePasskeys?: boolean;
}) {
  return recoverAccount({ ...input, adminOnly: false, resetMfa: true });
}

async function recoverAccount(input: {
  email: string;
  newEmail?: string;
  password?: string;
  adminOnly: boolean;
  resetMfa?: boolean;
  removePasskeys?: boolean;
}) {
  const email = emailSchema.parse(input.email);
  const newEmail =
    input.newEmail === undefined
      ? undefined
      : emailSchema.parse(input.newEmail);
  await getTowbarDatabase().transaction(async (tx) => {
    const [user] = await tx
      .select({
        id: users.id,
        email: users.email,
        name: users.displayName,
        workspaceId: workspaceMembers.workspaceId,
      })
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .where(
        and(
          eq(users.email, email),
          input.adminOnly ? eq(workspaceMembers.role, "admin") : undefined,
          isNull(users.disabledAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!user)
      throw new Error(
        input.adminOnly
          ? "Active admin account was not found"
          : "Active team member was not found",
      );
    const emailChanged = Boolean(newEmail && newEmail !== user.email);
    if (emailChanged) {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, newEmail!));
      if (existing) throw conflict("This email address is already in use");
    }
    if (input.password) {
      const [credential] = await tx
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.userId, user.id),
            eq(authAccounts.providerId, "credential"),
          ),
        );
      if (credential)
        await tx
          .update(authAccounts)
          .set({ password: input.password, updatedAt: new Date() })
          .where(eq(authAccounts.id, credential.id));
      else
        await tx.insert(authAccounts).values({
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: input.password,
        });
    }
    await tx
      .update(users)
      .set({
        ...(input.password ? { mustChangePassword: true } : {}),
        ...(input.removePasskeys ? { twoFactorEnabled: false } : {}),
        ...(emailChanged ? { email: newEmail, emailVerified: false } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    if (input.resetMfa)
      await tx
        .delete(authRecoveryCodes)
        .where(eq(authRecoveryCodes.userId, user.id));
    if (input.removePasskeys)
      await tx.delete(authPasskeys).where(eq(authPasskeys.userId, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    // Better Auth stores reset links, MFA challenges and trusted devices by user ID.
    await tx
      .delete(authVerifications)
      .where(eq(authVerifications.value, user.id));
    const pendingChanges = await tx
      .select({ email: emailChanges.newEmail })
      .from(emailChanges)
      .where(eq(emailChanges.userId, user.id));
    await tx.delete(emailChanges).where(eq(emailChanges.userId, user.id));
    await tx
      .update(transactionalEmails)
      .set({ status: "canceled", encryptedData: null })
      .where(
        and(
          eq(transactionalEmails.workspaceId, user.workspaceId),
          inArray(transactionalEmails.recipient, [
            user.email,
            ...pendingChanges.map((change) => change.email),
          ]),
          inArray(transactionalEmails.status, ["pending", "sending"]),
          inArray(transactionalEmails.template, [
            "password-reset",
            "email-change-verification",
            "email-verification",
          ]),
        ),
      );
    const personalKeys = await tx
      .update(apiKeyPolicies)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeyPolicies.ownerUserId, user.id),
          eq(apiKeyPolicies.scope, "personal"),
          isNull(apiKeyPolicies.revokedAt),
        ),
      )
      .returning({ id: apiKeyPolicies.keyId });
    if (personalKeys.length)
      await tx
        .update(apiKeys)
        .set({ enabled: false, updatedAt: new Date() })
        .where(
          inArray(
            apiKeys.id,
            personalKeys.map((key) => key.id),
          ),
        );
    const notice = { userId: user.id, email: user.email, name: user.name };
    if (input.password)
      await enqueueIdentityEmail(tx, {
        ...notice,
        template: "password-changed",
      });
    if (input.resetMfa || input.removePasskeys)
      await enqueueIdentityEmail(tx, { ...notice, template: "mfa-changed" });
    if (emailChanged) {
      await enqueueIdentityEmail(tx, { ...notice, template: "email-changed" });
      await enqueueIdentityEmail(tx, {
        ...notice,
        email: newEmail!,
        template: "password-changed",
      });
    }
  });
}
