import { replaceRecoveryCodes } from "../../../areas/auth/recovery-codes.js";
import { requestPublicVerificationEmail } from "../../../areas/auth/public-email-verification.js";
import { validatePasskeyRequest } from "../../../areas/auth/passkey-requests.js";
import { preferenceOptions } from "../../../areas/auth/preferences.js";
import { dateTimePreferencesSchema } from "@workspace/towbar-core/date-time";
import { and, eq, ne } from "drizzle-orm";
import {
  authPasskeys,
  authRecoveryCodes,
  sessions,
  users,
} from "@workspace/towbar-database/schema";
import { confirmEmailChange } from "../../../areas/auth/email-change.js";
import { getEnv } from "../../../env.js";
import { requireRecentAuthentication } from "../../../areas/auth/recent-authentication.js";
import { enqueueIdentityEmail } from "../../../areas/team/email-outbox.js";
import { getTowbarDatabase } from "../../../infrastructure/database.js";
import {
  acceptExistingInvitation,
  beginInvitationSignup,
  completeInvitationSignup,
  getInvitationPreview,
} from "../../../areas/team/service.js";
import { Hono } from "hono";
import { z } from "zod";
import {
  authenticatePassword,
  createInitialAdmin,
  findSession,
  getInitialSetupStatus,
  getUserIdentity,
  recordSuccessfulSignIn,
} from "../../../areas/auth/service.js";
import {
  createIdentityAuth,
  getIdentityAuth,
  identityBasePath,
} from "../../../areas/auth/identity.js";
import { requireTrustedMutationOrigin } from "../../../http/authentication.js";
import {
  clearPasswordLoginAccountRateLimit,
  enforceInitialSetupRateLimit,
  enforcePasswordLoginRateLimit,
  getClientAddress,
  incrementPersistentBucket,
} from "../../../http/rate-limit.js";
import { HttpError, forbidden } from "../../../http/errors.js";
import { readJson } from "../../../http/requests.js";

const loginSchema = z
  .object({ email: z.email().max(320), password: z.string().min(1).max(1024) })
  .strict();
const setupSchema = z
  .object({
    setupSecret: z.string().min(1).max(1024),
    confirmPassword: z.string().min(15).max(1024),
    dateTimePreferences: dateTimePreferencesSchema,
    displayName: z.string().trim().min(1).max(120),
    teamName: z.string().trim().min(1).max(120),
    email: z.email().max(320),
    password: z.string().min(15).max(1024),
  })
  .strict()
  .refine((input) => input.password === input.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export const publicAuthRoutes = new Hono();
publicAuthRoutes.use("*", requireTrustedMutationOrigin);
publicAuthRoutes.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  context.header("Referrer-Policy", "no-referrer");
  await next();
});
publicAuthRoutes.get("/setup-status", async (context) =>
  context.json({
    ...(await getInitialSetupStatus()),
    options: preferenceOptions(),
  }),
);
publicAuthRoutes.post("/request-verification-email", async (context) => {
  if (context.req.header("authorization") || context.req.header("x-api-key"))
    throw forbidden("Use the public verification form");
  const { email } = await readJson(
    context,
    z.object({ email: z.string().trim().pipe(z.email().max(320)) }).strict(),
  );
  await requestPublicVerificationEmail(email, getClientAddress(context));
  return context.json({ status: true });
});
publicAuthRoutes.post("/setup", async (context) => {
  await enforceInitialSetupRateLimit(getClientAddress(context));
  const input = await readJson(context, setupSchema);
  const response = await createInitialAdmin(input);
  return await loginResponse(response, 201);
});
publicAuthRoutes.post("/login-email", async (context) => {
  const input = await readJson(context, loginSchema);
  await enforcePasswordLoginRateLimit({
    clientAddress: getClientAddress(context),
    email: input.email,
  });
  const response = await authenticatePassword(input, context.req.raw.headers);
  if (response.ok) await clearPasswordLoginAccountRateLimit(input.email);
  return await loginResponse(response);
});
publicAuthRoutes.post("/refresh", async (context) => {
  const identity = await findSession(context.req.raw.headers);
  return context.json({ user: identity?.user ?? null }, identity ? 200 : 401);
});
publicAuthRoutes.get("/state", async (context) => {
  const session = await getIdentityAuth().api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session) return context.json({ user: null, account: null });
  const user = await getUserIdentity(session.user.id);
  return context.json({
    user,
    account: {
      email: session.user.email,
      name: session.user.name,
      emailVerified: session.user.emailVerified,
    },
  });
});
async function inviteRateLimit(address: string, id: string) {
  const now = new Date();
  for (const [key, limit] of [
    [`invite:ip:${address}`, 30],
    [`invite:id:${id}`, 10],
  ] as const) {
    const result = await incrementPersistentBucket(key, now, 10 * 60_000);
    if (result.attempts > limit)
      throw new HttpError(
        429,
        "AUTH_RATE_LIMITED",
        "Too many attempts. Try again later",
        { responseHeaders: { "Retry-After": "600" } },
      );
  }
}
publicAuthRoutes.get("/invitations/:invitationId", async (context) =>
  context.json({
    invitation: await getInvitationPreview(
      z.uuid().parse(context.req.param("invitationId")),
    ),
  }),
);
publicAuthRoutes.post("/invitations/:invitationId/verify", async (context) => {
  const id = z.uuid().parse(context.req.param("invitationId"));
  await inviteRateLimit(getClientAddress(context), id);
  return context.json(await beginInvitationSignup(id));
});
publicAuthRoutes.post("/invitations/:invitationId/signup", async (context) => {
  const id = z.uuid().parse(context.req.param("invitationId"));
  await inviteRateLimit(getClientAddress(context), id);
  const input = await readJson(
    context,
    z
      .object({
        name: z.string().trim().min(1).max(120),
        code: z.string().regex(/^\d{6}$/),
      })
      .strict(),
  );
  return await loginResponse(await completeInvitationSignup(id, input));
});
publicAuthRoutes.post("/invitations/:invitationId/accept", async (context) => {
  const id = z.uuid().parse(context.req.param("invitationId"));
  await inviteRateLimit(getClientAddress(context), id);
  return context.json(
    await acceptExistingInvitation(id, context.req.raw.headers),
  );
});
publicAuthRoutes.post("/confirm-email-change", async (c) => {
  const input = await readJson(
    c,
    z
      .object({ id: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict(),
  );
  await inviteRateLimit(getClientAddress(c), `email-change:${input.id}`);
  await confirmEmailChange(input.id, input.token);
  return c.json({ success: true });
});
const publicIdentityPaths = new Set([
  "GET /verify-email",
  "POST /request-password-reset",
  "POST /reset-password",
  "POST /passkey/verify-recovery-code",
  "POST /sign-out",
  "GET /passkey/generate-authenticate-options",
  "POST /passkey/verify-authentication",
]);
const personalIdentityPaths = new Set([
  "POST /send-verification-email",
  "GET /passkey/generate-register-options",
  "POST /passkey/verify-registration",
  "POST /passkey/delete-passkey",
  "POST /passkey/update-passkey",
  "GET /passkey/list-user-passkeys",
]);
publicAuthRoutes.all("/identity/*", async (context) => {
  const path = context.req.path.slice(identityBasePath.length);
  const requestKey = `${context.req.method} ${path}`;
  const resetRedirect =
    context.req.method === "GET" &&
    /^\/reset-password\/[A-Za-z0-9_-]+$/.test(path);
  if (
    !publicIdentityPaths.has(requestKey) &&
    !personalIdentityPaths.has(requestKey) &&
    !resetRedirect
  )
    return context.notFound();
  if (context.req.header("authorization") || context.req.header("x-api-key"))
    throw forbidden("Use a browser session for account settings");
  const now = new Date();
  const bucket = await incrementPersistentBucket(
    `identity:${getClientAddress(context)}:${path.replace(/\/reset-password\/.*/, "/reset-password")}`,
    now,
    60_000,
  );
  if (bucket.attempts > 20)
    throw new HttpError(
      429,
      "AUTH_RATE_LIMITED",
      "Too many attempts. Try again shortly",
      { responseHeaders: { "Retry-After": "60" } },
    );
  if (personalIdentityPaths.has(requestKey)) {
    const identity = await findSession(context.req.raw.headers);
    if (!identity || identity.user.mustChangePassword)
      throw forbidden("Sign in and finish password setup to continue");
    if (
      !["/passkey/list-user-passkeys", "/send-verification-email"].includes(
        path,
      )
    )
      await requireRecentAuthentication(identity.user.id, identity.sessionId);
  }
  if (path.startsWith("/passkey/")) {
    await validatePasskeyRequest(context.req.raw, path);
    return await getTowbarDatabase().transaction(async (tx) => {
      const auth = createIdentityAuth(tx);
      const before = await auth.api.getSession({
        headers: context.req.raw.headers,
      });
      if (before)
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, before.user.id))
          .for("update");
      const response = await auth.handler(context.req.raw);
      if (
        response.ok &&
        !before &&
        [
          "/passkey/verify-authentication",
          "/passkey/verify-recovery-code",
        ].includes(path)
      )
        await recordSuccessfulSignIn(tx, response);
      if (response.ok && before && path === "/passkey/verify-authentication") {
        const body = (await response.clone().json()) as {
          session: { id: string };
        };
        await tx
          .delete(sessions)
          .where(
            and(
              eq(sessions.id, body.session.id),
              ne(sessions.id, before.session.id),
            ),
          );
        return Response.json(
          { authenticated: true },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (
        response.ok &&
        before &&
        ["/passkey/verify-registration", "/passkey/delete-passkey"].includes(
          path,
        )
      ) {
        await enqueueIdentityEmail(tx, {
          userId: before.user.id,
          email: before.user.email,
          name: before.user.name,
          template: "mfa-changed",
          actionUrl: `${new URL(getEnv().TOWBAR_APP_BASE_URL).origin}/settings/passkeys`,
        });
      }
      if (
        response.ok &&
        before &&
        ["/passkey/verify-registration", "/passkey/delete-passkey"].includes(
          path,
        )
      ) {
        const keys = await tx
          .select({ id: authPasskeys.id })
          .from(authPasskeys)
          .where(eq(authPasskeys.userId, before.user.id));
        await tx
          .update(users)
          .set({ twoFactorEnabled: keys.length > 0 })
          .where(eq(users.id, before.user.id));
        if (keys.length === 0)
          await tx
            .delete(authRecoveryCodes)
            .where(eq(authRecoveryCodes.userId, before.user.id));
        await tx
          .delete(sessions)
          .where(
            and(
              eq(sessions.userId, before.user.id),
              ne(sessions.id, before.session.id),
            ),
          );
        if (path === "/passkey/verify-registration") {
          const [stored] = await tx
            .select({ userId: authRecoveryCodes.userId })
            .from(authRecoveryCodes)
            .where(eq(authRecoveryCodes.userId, before.user.id));
          if (!stored) {
            const recoveryCodes = await replaceRecoveryCodes(
              tx,
              before.user.id,
            );
            return Response.json(
              { ...((await response.json()) as object), recoveryCodes },
              { headers: response.headers },
            );
          }
        }
      }
      return response;
    });
  }
  return await getIdentityAuth().handler(context.req.raw);
});
async function loginResponse(response: Response, successStatus = 200) {
  if (!response.ok) return response;
  const body = (await response.json()) as {
    twoFactorRedirect?: boolean;
    twoFactorMethods?: Array<"passkey">;
    user?: { id: string };
  };
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("content-length");
  return Response.json(
    {
      twoFactorRequired: body.twoFactorRedirect === true,
      twoFactorMethods: body.twoFactorMethods ?? [],
      user: body.user ? await getUserIdentity(body.user.id) : null,
    },
    { status: successStatus, headers },
  );
}
