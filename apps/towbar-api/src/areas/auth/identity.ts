import { isPasswordCompromised } from "./password-breach-check.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { emailOTP, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { accessControl, accessRoles } from "@workspace/towbar-access";
import {
  apiKeys,
  authAccounts,
  authPasskeys,
  authVerifications,
  sessions,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { getEnv } from "../../env.js";
import {
  type AuthDatabase,
  getTowbarDatabase,
} from "../../infrastructure/database.js";
import { recordAuditEvent } from "../../infrastructure/audit.js";
import { runPasswordOperationWithCapacityLimit } from "./password-verification.js";
import { enqueueIdentityEmail } from "../team/email-outbox.js";
import { enqueueVerificationEmail } from "./email-verification.js";
import {
  completePasskeySecondFactor,
  passwordSecondFactor,
} from "./password-second-factor.js";

export const identityProvisioning = new AsyncLocalStorage<{
  workspaceId: string;
  invitationId?: string;
  reason: "setup" | "invite" | "admin";
}>();
export const identityBasePath = "/v1/public/auth/identity";
function identityOptions(database: AuthDatabase) {
  const env = getEnv();
  const secureCookies = new URL(env.TOWBAR_API_BASE_URL).protocol === "https:";
  return {
    appName: "Towbar",
    baseURL: env.TOWBAR_API_BASE_URL,
    basePath: identityBasePath,
    secret: createHmac("sha256", env.TOWBAR_INTERNAL_HMAC_SECRET)
      .update("towbar:identity:v2")
      .digest("hex"),
    trustedOrigins: [new URL(env.TOWBAR_APP_BASE_URL).origin],
    database: drizzleAdapter(database, {
      provider: "pg",
      transaction: true,
      schema: {
        users,
        sessions,
        authAccounts,
        authPasskeys,
        authVerifications,
        workspaces,
        workspaceMembers,
        workspaceInvitations,
        apiKeys,
      },
    }),
    user: {
      modelName: "users",
      fields: { name: "displayName" },
      additionalFields: {
        disabledAt: {
          type: "date",
          required: false,
          input: false,
          returned: false,
        },
        mustChangePassword: {
          type: "boolean",
          defaultValue: false,
          input: false,
          returned: false,
        },
      },
      changeEmail: { enabled: false },
    },
    account: { modelName: "authAccounts", accountLinking: { enabled: false } },
    verification: { modelName: "authVerifications" },
    session: {
      modelName: "sessions",
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 60 * 60,
      // The account facade checks authenticatedAt, including explicit reauthentication.
      // Better Auth checks createdAt, which would reject an otherwise refreshed session.
      freshAge: 0,
      cookieCache: { enabled: false },
      additionalFields: {
        authenticatedAt: {
          type: "date",
          input: false,
          returned: false,
          defaultValue: () => new Date(),
        },
      },
    },
    advanced: {
      database: { generateId: () => randomUUID() },
      useSecureCookies: secureCookies,
      cookiePrefix: "towbar",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      cookies: {
        session_token: {
          name: secureCookies ? "__Host-towbar-session" : "towbar-session",
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      minPasswordLength: 15,
      maxPasswordLength: 1024,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: (password) =>
          runPasswordOperationWithCapacityLimit(async () => {
            if (password.length < 15 || password.length > 1024)
              throw new APIError("BAD_REQUEST", {
                message: "Use a password between 15 and 1,024 characters",
              });
            if (
              env.TOWBAR_PASSWORD_BREACH_CHECK &&
              (await isPasswordCompromised(password))
            )
              throw new APIError("BAD_REQUEST", {
                code: "PASSWORD_COMPROMISED",
                message:
                  "This password appears in known breaches. Choose a different passphrase",
              });
            return hashPassword(password);
          }),
        verify: (input) =>
          runPasswordOperationWithCapacityLimit(() => verifyPassword(input)),
      },
      sendResetPassword: async ({ user, url }) => {
        await enqueueIdentityEmail(database, {
          userId: user.id,
          email: user.email,
          name: user.name,
          template: "password-reset",
          actionUrl: url,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
      },
      onPasswordReset: async ({ user }) => {
        await database
          .update(users)
          .set({ mustChangePassword: false, updatedAt: new Date() })
          .where(eq(users.id, user.id));
        await enqueueIdentityEmail(database, {
          userId: user.id,
          email: user.email,
          name: user.name,
          template: "password-changed",
        });
      },
    },
    emailVerification: {
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        await enqueueVerificationEmail(database, {
          userId: user.id,
          email: user.email,
          name: user.name,
          actionUrl: url,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          workspaceId: identityProvisioning.getStore()?.workspaceId,
        });
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: (user) => {
            if (!identityProvisioning.getStore())
              throw new APIError("FORBIDDEN", {
                message: "Use a valid invitation to join this team",
              });
            return Promise.resolve({
              data: {
                ...user,
                email: user.email.trim().toLowerCase(),
                emailVerified:
                  identityProvisioning.getStore()?.reason === "setup" ||
                  (identityProvisioning.getStore()?.reason === "invite" &&
                    user.emailVerified),
              },
            });
          },
          after: async (user) => {
            const provisioning = identityProvisioning.getStore();
            if (!provisioning || provisioning.reason === "admin") return;
            await recordAuditEvent(database, {
              workspaceId: provisioning.workspaceId,
              actorKind: "session",
              actorUserId: user.id,
              action: "account.signed-up",
              targetType: "account",
              targetId: user.id,
            });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const [user] = await database
              .select({ disabledAt: users.disabledAt })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);
            if (!user || user.disabledAt)
              throw new APIError("UNAUTHORIZED", {
                message: "Account is unavailable",
              });
            return { data: session };
          },
        },
      },
    },
    plugins: [
      passwordSecondFactor(database),
      passkey({
        rpID: new URL(env.TOWBAR_APP_BASE_URL).hostname,
        rpName: "Towbar",
        origin: new URL(env.TOWBAR_APP_BASE_URL).origin,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        schema: { passkey: { modelName: "authPasskeys" } },
        registration: {
          requireSession: true,
          afterVerification: ({ verification }) => {
            if (!verification.registrationInfo?.userVerified)
              throw new APIError("FORBIDDEN", {
                message:
                  "Verify your identity on your device to create a passkey",
              });
          },
        },
        authentication: {
          afterVerification: async ({ ctx, verification, clientData }) => {
            if (!verification.authenticationInfo.userVerified)
              throw new APIError("FORBIDDEN", {
                message: "Verify your identity on your device to sign in",
              });
            await completePasskeySecondFactor(ctx, database, clientData);
          },
        },
      }),
      organization({
        creatorRole: "admin",
        allowUserToCreateOrganization: false,
        invitationExpiresIn: 7 * 86400,
        ac: accessControl,
        roles: accessRoles,
        requireEmailVerificationOnInvitation: true,
        schema: {
          organization: { modelName: "workspaces" },
          member: {
            modelName: "workspaceMembers",
            fields: { organizationId: "workspaceId" },
          },
          invitation: {
            modelName: "workspaceInvitations",
            fields: { organizationId: "workspaceId" },
          },
        },
      }),
      emailOTP({
        storeOTP: "hashed",
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp }) => {
          const provisioning = identityProvisioning.getStore();
          if (!provisioning || provisioning.reason !== "invite")
            throw new APIError("FORBIDDEN", {
              message: "Use an invitation to verify your email",
            });
          await enqueueIdentityEmail(database, {
            workspaceId: provisioning.workspaceId,
            email,
            name: "",
            template: "invitation-verification",
            invitationId: provisioning.invitationId,
            verificationCode: otp,
            expiresAt: new Date(Date.now() + 600_000),
          });
        },
      }),
      apiKey(
        [
          {
            configId: "personal",
            references: "user",
            defaultPrefix: "twb_",
            enableSessionForAPIKeys: false,
            rateLimit: {
              enabled: true,
              maxRequests: env.TOWBAR_API_RATE_LIMIT_MAX,
              timeWindow: env.TOWBAR_API_RATE_LIMIT_WINDOW_SECONDS * 1000,
            },
          },
          {
            configId: "team",
            references: "organization",
            defaultPrefix: "twb_",
            enableSessionForAPIKeys: false,
            rateLimit: {
              enabled: true,
              maxRequests: env.TOWBAR_API_RATE_LIMIT_MAX,
              timeWindow: env.TOWBAR_API_RATE_LIMIT_WINDOW_SECONDS * 1000,
            },
          },
        ],
        { schema: { apikey: { modelName: "apiKeys" } } },
      ),
    ],
  } satisfies BetterAuthOptions;
}
type IdentityAuth = ReturnType<
  typeof betterAuth<ReturnType<typeof identityOptions>>
>;
export function createIdentityAuth(
  database: AuthDatabase = getTowbarDatabase(),
): IdentityAuth {
  return betterAuth(identityOptions(database));
}
let identity: ReturnType<typeof createIdentityAuth> | undefined;
export function getIdentityAuth(): IdentityAuth {
  return (identity ??= createIdentityAuth());
}
