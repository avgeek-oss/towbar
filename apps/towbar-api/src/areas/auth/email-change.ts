import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  emailChanges,
  sessions,
  users,
  workspaceMembers,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { getEnv } from "../../env.js";
import { HttpError, conflict, forbidden } from "../../http/errors.js";
import type { AuthenticatedUser } from "../../http/types.js";
import { enqueueIdentityEmail } from "../team/email-outbox.js";
import { incrementPersistentBucket } from "../../http/rate-limit.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function requestEmailChange(
  user: AuthenticatedUser,
  email: string,
) {
  const newEmail = email.trim().toLowerCase();
  const bucket = await incrementPersistentBucket(
    `email-change:${user.id}`,
    new Date(),
    60 * 60_000,
  );
  if (bucket.attempts > 5)
    throw new HttpError(
      429,
      "AUTH_RATE_LIMITED",
      "Too many requests. Try again in an hour.",
    );
  return getTowbarDatabase().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .for("update");
    if (!current || current.disabledAt)
      throw forbidden("Account is unavailable");
    if (newEmail === current.email)
      throw conflict("Enter a different email address");
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, newEmail));
    if (existing) throw conflict("This email address is unavailable");
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await tx.delete(emailChanges).where(eq(emailChanges.userId, user.id));
    await tx.insert(emailChanges).values({
      id,
      userId: user.id,
      tokenHash: digest(token),
      previousEmail: current.email,
      newEmail,
      expiresAt,
    });
    await enqueueIdentityEmail(tx, {
      userId: user.id,
      email: newEmail,
      name: current.displayName,
      template: "email-change-verification",
      expiresAt,
      actionUrl: `${new URL(getEnv().TOWBAR_APP_BASE_URL).origin}/confirm-email-change#${id}.${token}`,
    });
    return { email: newEmail, expiresAt: expiresAt.toISOString() };
  });
}
export async function pendingEmailChange(userId: string) {
  const [pending] = await getTowbarDatabase()
    .select({ email: emailChanges.newEmail, expiresAt: emailChanges.expiresAt })
    .from(emailChanges)
    .where(
      and(
        eq(emailChanges.userId, userId),
        gt(emailChanges.expiresAt, new Date()),
      ),
    );
  return pending ?? null;
}
export async function cancelEmailChange(userId: string) {
  await getTowbarDatabase().transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    await tx.delete(emailChanges).where(eq(emailChanges.userId, userId));
  });
}
export async function confirmEmailChange(id: string, token: string) {
  const invalid = () =>
    new HttpError(
      400,
      "EMAIL_CHANGE_INVALID",
      "This link has expired or is no longer valid. Request a new link from Email & Password in Personal Settings.",
    );
  try {
    await getTowbarDatabase().transaction(async (tx) => {
      // Lock the user before the request, matching the request/cancel lock order.
      const [candidate] = await tx
        .select({ userId: emailChanges.userId })
        .from(emailChanges)
        .where(eq(emailChanges.id, id));
      if (!candidate) throw invalid();
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, candidate.userId))
        .for("update");
      const [change] = await tx
        .select()
        .from(emailChanges)
        .where(eq(emailChanges.id, id))
        .for("update");
      if (
        !change ||
        !user ||
        user.disabledAt ||
        user.email !== change.previousEmail ||
        change.expiresAt <= new Date() ||
        !timingSafeEqual(
          Buffer.from(change.tokenHash, "hex"),
          Buffer.from(digest(token), "hex"),
        )
      )
        throw invalid();
      const [membership] = await tx
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, user.id));
      if (!membership) throw invalid();
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, change.newEmail));
      if (existing)
        throw conflict(
          "This email address is unavailable. Request a new link for another address.",
        );
      await tx
        .update(users)
        .set({
          email: change.newEmail,
          emailVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      await tx.delete(emailChanges).where(eq(emailChanges.id, id));
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
      await enqueueIdentityEmail(tx, {
        userId: user.id,
        email: change.previousEmail,
        name: user.displayName,
        template: "email-changed",
        actionUrl: `${new URL(getEnv().TOWBAR_APP_BASE_URL).origin}/login`,
      });
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "23505"
    )
      throw conflict(
        "This email address is unavailable. Request a new link for another address.",
      );
    throw error;
  }
}
