import { type BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import {
  deleteSessionCookie,
  expireCookie,
  setSessionCookie,
} from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  authPasskeys,
  authRecoveryCodes,
  sessions,
  users,
} from "@workspace/towbar-database/schema";
import type { AuthDatabase } from "../../infrastructure/database.js";
import { recoveryCodeHash } from "./recovery-codes.js";

type AuthContext = Parameters<typeof expireCookie>[0];
const maxAge = 600;
const bindingPrefix = "towbar-passkey-factor:";
const factorCookie = (ctx: AuthContext) =>
  ctx.context.createAuthCookie("two_factor", { maxAge });
async function pendingPassword(
  ctx: AuthContext,
  database: AuthDatabase,
  required = true,
) {
  const identifier = await ctx.getSignedCookie(
    factorCookie(ctx).name,
    ctx.context.secret,
  );
  if (!identifier && !required) return null;
  const pending = identifier
    ? await ctx.context.internalAdapter.findVerificationValue(identifier)
    : null;
  if ((!pending || pending.expiresAt <= new Date()) && !required) {
    expireCookie(ctx, factorCookie(ctx));
    return null;
  }
  if (!pending || pending.expiresAt <= new Date())
    throw new APIError("UNAUTHORIZED", {
      message: "This sign-in has expired. Sign in again.",
    });
  const [user] = await database
    .select()
    .from(users)
    .where(eq(users.id, pending.value));
  if (!user || user.disabledAt)
    throw new APIError("UNAUTHORIZED", { message: "Sign in to continue." });
  return pending;
}
export function passwordSecondFactor(database: AuthDatabase): BetterAuthPlugin {
  return {
    id: "towbar-password-second-factor",
    endpoints: {
      verifyRecoveryCode: createAuthEndpoint(
        "/passkey/verify-recovery-code",
        {
          method: "POST",
          body: z.object({ code: z.string().trim().min(1).max(100) }),
        },
        async (ctx) => {
          if (await getSessionFromCtx(ctx))
            throw new APIError("UNAUTHORIZED", {
              message: "Sign in again to use a recovery code.",
            });
          const pending = (await pendingPassword(ctx, database))!;
          const [user] = await database
            .select()
            .from(users)
            .where(eq(users.id, pending.value))
            .for("update");
          if (!user || user.disabledAt)
            throw new APIError("UNAUTHORIZED", {
              message: "Sign in to continue.",
            });
          const [stored] = await database
            .select()
            .from(authRecoveryCodes)
            .where(eq(authRecoveryCodes.userId, user.id));
          const hash = recoveryCodeHash(ctx.body.code);
          if (!stored?.codeHashes.includes(hash))
            throw new APIError("UNAUTHORIZED", {
              message: "Recovery code is invalid or has already been used.",
            });
          const consumed =
            await ctx.context.internalAdapter.consumeVerificationValue(
              pending.identifier,
            );
          if (!consumed || consumed.value !== user.id)
            throw new APIError("UNAUTHORIZED", {
              message: "This sign-in has expired. Sign in again.",
            });
          await database
            .update(authRecoveryCodes)
            .set({
              codeHashes: stored.codeHashes.filter((value) => value !== hash),
            })
            .where(eq(authRecoveryCodes.userId, user.id));
          expireCookie(ctx, factorCookie(ctx));
          const created = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          const identity = await ctx.context.internalAdapter.findUserById(
            user.id,
          );
          if (!created || !identity)
            throw new APIError("UNAUTHORIZED", {
              message: "Sign in to continue.",
            });
          // A recovery code restores access but is not proof for credential
          // changes, so the session starts outside the recent-authentication
          // window until the user confirms with a passkey.
          const authenticatedAt = new Date(0);
          await database
            .update(sessions)
            .set({ authenticatedAt })
            .where(eq(sessions.id, created.id));
          const session = { ...created, authenticatedAt };
          await setSessionCookie(ctx, { session, user: identity });
          return ctx.json({ session, user: identity });
        },
      ),
    },
    hooks: {
      after: [
        {
          matcher: ({ path }) => path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const session = ctx.context.newSession;
            if (!session) return;
            const keys = await database
              .select({ id: authPasskeys.id })
              .from(authPasskeys)
              .where(eq(authPasskeys.userId, session.user.id))
              .limit(1);
            if (!keys.length) return;
            deleteSessionCookie(ctx, true);
            await ctx.context.internalAdapter.deleteSession(
              session.session.token,
            );
            ctx.context.setNewSession(null);
            const cookie = factorCookie(ctx);
            const previous = await ctx.getSignedCookie(
              cookie.name,
              ctx.context.secret,
            );
            if (previous)
              await ctx.context.internalAdapter.deleteVerificationByIdentifier(
                previous,
              );
            const identifier = `passkey-${generateRandomString(32)}`;
            await ctx.context.internalAdapter.createVerificationValue({
              identifier,
              value: session.user.id,
              expiresAt: new Date(Date.now() + maxAge * 1000),
            });
            await ctx.setSignedCookie(
              cookie.name,
              identifier,
              ctx.context.secret,
              cookie.attributes,
            );
            return ctx.json({
              twoFactorRedirect: true,
              twoFactorMethods: ["passkey"],
            });
          }),
        },
        {
          matcher: ({ path }) =>
            path === "/passkey/generate-authenticate-options",
          handler: createAuthMiddleware(async (ctx) => {
            const result = ctx.context.returned;
            if (
              !result ||
              typeof result !== "object" ||
              !("challenge" in result) ||
              typeof result.challenge !== "string"
            )
              return;
            const session = await getSessionFromCtx(ctx);
            const pending = session
              ? null
              : await pendingPassword(ctx, database, false);
            const userId = session?.user.id ?? pending?.value;
            const keys = userId
              ? await database
                  .select({ id: authPasskeys.credentialID })
                  .from(authPasskeys)
                  .where(eq(authPasskeys.userId, userId))
              : [];
            if (userId && !keys.length)
              throw new APIError("BAD_REQUEST", {
                message: "No passkey is available for this account.",
              });
            await ctx.context.internalAdapter.createVerificationValue({
              identifier: bindingPrefix + result.challenge,
              value: JSON.stringify({
                userId,
                sessionId: session?.session.id,
                pendingId: pending?.identifier,
              }),
              expiresAt:
                pending?.expiresAt ?? new Date(Date.now() + maxAge * 1000),
            });
            return ctx.json({
              ...result,
              userVerification: "required",
              ...(userId
                ? {
                    allowCredentials: keys.map(({ id }) => ({
                      id,
                      type: "public-key",
                    })),
                  }
                : {}),
            });
          }),
        },
      ],
    },
  };
}
export async function completePasskeySecondFactor(
  ctx: AuthContext,
  database: AuthDatabase,
  credential: { id: string; response: { clientDataJSON: string } },
) {
  const [key] = await database
    .select({ userId: authPasskeys.userId })
    .from(authPasskeys)
    .where(eq(authPasskeys.credentialID, credential.id));
  if (!key)
    throw new APIError("UNAUTHORIZED", { message: "Passkey is unavailable." });
  const clientData = JSON.parse(
    Buffer.from(credential.response.clientDataJSON, "base64url").toString(
      "utf8",
    ),
  ) as { challenge: string };
  const stored = await ctx.context.internalAdapter.consumeVerificationValue(
    bindingPrefix + clientData.challenge,
  );
  if (!stored || stored.expiresAt <= new Date())
    throw new APIError("UNAUTHORIZED", {
      message: "This passkey request has expired. Try again.",
    });
  const binding = JSON.parse(stored.value) as {
    userId?: string;
    sessionId?: string;
    pendingId?: string;
  };
  if (binding.userId && binding.userId !== key.userId)
    throw new APIError("UNAUTHORIZED", {
      message: "Use a passkey belonging to your account.",
    });
  const [user] = await database
    .select()
    .from(users)
    .where(eq(users.id, key.userId))
    .for("update");
  if (!user || user.disabledAt)
    throw new APIError("UNAUTHORIZED", {
      message: "Sign in to continue.",
    });
  if (user.mustChangePassword && !binding.pendingId)
    throw new APIError("UNAUTHORIZED", {
      message: "Sign in with your temporary password to finish account setup.",
    });
  const current = await getSessionFromCtx(ctx);
  if (binding.sessionId) {
    if (
      !current ||
      current.session.id !== binding.sessionId ||
      current.user.id !== key.userId
    )
      throw new APIError("UNAUTHORIZED", {
        message: "This session has changed. Try again.",
      });
    await database
      .update(sessions)
      .set({ authenticatedAt: new Date() })
      .where(
        and(
          eq(sessions.id, binding.sessionId),
          eq(sessions.userId, key.userId),
        ),
      );
  } else if (binding.pendingId) {
    const pending = (await pendingPassword(ctx, database))!;
    if (pending.identifier !== binding.pendingId)
      throw new APIError("UNAUTHORIZED", {
        message: "This sign-in has changed. Try again.",
      });
    const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
      pending.identifier,
    );
    if (!consumed || consumed.value !== key.userId)
      throw new APIError("UNAUTHORIZED", {
        message: "This sign-in has expired. Sign in again.",
      });
    expireCookie(ctx, factorCookie(ctx));
  } else if (current || (await pendingPassword(ctx, database, false))) {
    throw new APIError("UNAUTHORIZED", {
      message: "This sign-in has changed. Try again.",
    });
  }
}
