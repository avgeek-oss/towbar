import { createPasskeyFixture } from "./passkey-fixture.ts";
import {
  dualFactorFixtureCredential,
  dualFactorFixtureUserId,
} from "./dual-factor-fixture.ts";
import {
  initializeDateTimeRange,
  resolveDateTimeRange,
  rangeInitializationSchema,
  preferredRangeSchema,
} from "@workspace/towbar-core/date-time-range";
import { fixtureJson } from "./fixture-localization.ts";
import {
  createDateTimeFormatter,
  availableTimeZones,
  dateFormatOptions,
  timeFormatOptions,
  dateTimePreferencesSchema,
  defaultDateTimePreferences,
  type DateTimePreferences,
} from "@workspace/towbar-core/date-time";
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  canCreateKey,
  constrainPersonalKey,
  isWorkspaceRole,
  keyCeiling,
  roleActions,
  workspaceRoles,
  type KeyAccess,
  type KeyPolicy,
  type KeyScope,
  type WorkspaceRole,
} from "@workspace/towbar-access";
import type { TowbarUser } from "@workspace/towbar-web-client";

export type FixtureAuthState =
  | "authenticated"
  | "passkey-user"
  | "signed-out"
  | "new-instance"
  | "temporary-password";
export type TeamFixtureOptions = {
  role?: WorkspaceRole;
  authState?: FixtureAuthState;
  smtpAvailable?: boolean;
  emailVerified?: boolean;
};
type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  mustChangePassword: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
};
type Invitation = {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: string;
  expiresAt: string;
  deliveryStatus: string;
  errorCode: string | null;
};
type Key = KeyPolicy & {
  id: string;
  name: string;
  prefix: string;
  ownerUserId: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  tokenType?: "api-key" | "mcp-oauth";
  oauthClientName?: string;
  oauthClientId?: string;
  oauthClientLogo?: string;
  oauthClientTrust?: "metadata-document" | "unverified";
};
const now = () => new Date().toISOString();
const expiry = (days: number) =>
  new Date(Date.now() + days * 86400_000).toISOString();
function send(response: ServerResponse, payload: unknown, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(status === 204 ? undefined : fixtureJson(response, payload));
  return true;
}
function fail(response: ServerResponse, message: string, status = 403) {
  return send(response, { error: { message } }, status);
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid form");
  return value as Record<string, unknown>;
}
export function createTeamAccessFixture(
  baseUser: TowbarUser,
  options: TeamFixtureOptions = {},
) {
  let team = {
    id: baseUser.workspaceId,
    name: "Platform team",
    description: "Our deployment workspace",
  };
  const members: Member[] = workspaceRoles.map((role, index) => ({
    id: `a1111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    userId:
      role === "admin"
        ? baseUser.id
        : `71111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    name:
      role === "admin"
        ? baseUser.name
        : `Towbar ${role[0]!.toUpperCase()}${role.slice(1)}`,
    email: role === "admin" ? baseUser.email : `${role}@example.com`,
    role,
    mustChangePassword: false,
    emailVerified: true,
    twoFactorEnabled: false,
  }));
  members.push({
    id: "a1111111-1111-4111-8111-000000000005",
    userId: dualFactorFixtureUserId,
    name: "Passkey test user",
    email: "2fa-both@example.com",
    role: "member",
    mustChangePassword: false,
    emailVerified: true,
    twoFactorEnabled: true,
  });
  let selected = members.find(
    (member) => member.role === (options.role ?? "admin"),
  )!;
  if (options.authState === "passkey-user")
    selected = members.find(
      (member) => member.userId === dualFactorFixtureUserId,
    )!;
  if (options.emailVerified !== undefined)
    selected.emailVerified = options.emailVerified;
  const verificationRequests = new Map<string, number[]>();
  const publicVerificationRequests = new Map<string, number[]>();
  let signedIn = !["new-instance", "signed-out"].includes(
    options.authState ?? "authenticated",
  );
  let setupRequired = options.authState === "new-instance";
  let pendingSignIn: { id: string; userId: string; expiresAt: number } | null =
    null;
  if (options.authState === "temporary-password")
    selected.mustChangePassword = true;
  const passkeys = createPasskeyFixture(
    () =>
      signedIn && !selected.mustChangePassword
        ? {
            id: selected.userId,
            email: selected.email,
            name: selected.name,
          }
        : null,
    (userId) => {
      const member = members.find((item) => item.userId === userId);
      if (!member) throw new Error("Account is unavailable");
      selected = member;
      signedIn = true;
      pendingSignIn = null;
    },
    () => pendingSignIn,
    [
      {
        id: "b1111111-1111-4111-8111-000000000005",
        userId: dualFactorFixtureUserId,
        name: "Fixture passkey (virtual authenticator)",
        createdAt: now(),
        credential: dualFactorFixtureCredential,
      },
    ],
  );
  const pendingEmails = new Map<
    string,
    { id: string; email: string; token: string; expiresAt: string }
  >();
  const invitations: Invitation[] = workspaceRoles.map((role, index) => ({
    id: `f1111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    email: `invited-${role}@example.com`,
    role,
    status: "pending",
    expiresAt: expiry(7),
    deliveryStatus: options.smtpAvailable === false ? "failed" : "sent",
    errorCode: options.smtpAvailable === false ? "SMTP_NOT_CONFIGURED" : null,
  }));
  const keys: Key[] = ["personal", "team"].map((scope) => ({
    id: randomUUID(),
    name: scope === "team" ? "CI automation" : "Local tools",
    prefix: "twb_fixture",
    scope: scope as KeyScope,
    access: "read",
    includeAdmin: false,
    grants: keyCeiling("viewer", "read", false),
    ownerUserId: scope === "team" ? null : selected.userId,
    createdAt: now(),
    expiresAt: expiry(90),
    lastUsedAt: null,
    revokedAt: null,
  }));
  const keyRequests = new Map<string, string>();
  const mcpConnectedAt = Date.now() - 5 * 60_000;
  keys.push({
    id: randomUUID(),
    name: "ChatGPT",
    prefix: "twb_fixture",
    scope: "personal",
    access: "read",
    includeAdmin: false,
    grants: keyCeiling("viewer", "read", false),
    ownerUserId: selected.userId,
    createdAt: new Date(mcpConnectedAt).toISOString(),
    expiresAt: new Date(mcpConnectedAt + 30 * 86400_000).toISOString(),
    lastUsedAt: new Date(mcpConnectedAt + 4 * 60_000).toISOString(),
    revokedAt: null,
    tokenType: "mcp-oauth",
    oauthClientName: "ChatGPT",
    oauthClientId: "https://chatgpt.com/mcp/client.json",
    oauthClientLogo: "openai",
    oauthClientTrust: "metadata-document",
  });
  const preferencesByUser = new Map<string, DateTimePreferences>();
  const getPreferences = () =>
    signedIn
      ? (preferencesByUser.get(selected.userId) ?? defaultDateTimePreferences)
      : defaultDateTimePreferences;
  const getUser = (): TowbarUser | null =>
    signedIn
      ? {
          ...baseUser,
          id: selected.userId,
          name: selected.name,
          email: selected.email,
          teamName: team.name,
          workspaceRole: selected.role,
          capabilities: roleActions(selected.role),
          mustChangePassword: selected.mustChangePassword,
          passwordSetupRequired:
            selected.mustChangePassword && !passwords.has(selected.userId),
          emailVerified: selected.emailVerified,
          twoFactorEnabled: selected.twoFactorEnabled,
        }
      : null;
  const passwords = new Map(
    members.map((member) => [member.userId, "Towbar fixture passphrase 2026"]),
  );
  const reusable = (request: IncomingMessage) =>
    request.headers.origin ?? "http://localhost:4021";
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname,
      method = request.method ?? "GET";
    try {
      if (
        path === "/v1/public/auth/request-verification-email" &&
        method === "POST"
      ) {
        const input = await body(request);
        if (
          Object.keys(input).some((key) => key !== "email") ||
          typeof input.email !== "string" ||
          input.email.length > 320 ||
          !/^\S+@[^@\s]+\.[^@\s]+$/.test(input.email.trim())
        )
          return fail(response, "Enter a valid email address", 400);
        const email = input.email.trim().toLowerCase();
        const recent = (publicVerificationRequests.get(email) ?? []).filter(
          (createdAt) => createdAt > Date.now() - 24 * 60 * 60_000,
        );
        if (recent.length >= 5 || (recent.at(-1) ?? 0) > Date.now() - 60_000)
          return fail(
            response,
            "Too many verification requests. Try again later.",
            429,
          );
        publicVerificationRequests.set(email, [...recent, Date.now()]);
        return send(response, { status: true });
      }
      if (path === "/v1/public/auth/setup-status")
        return send(response, {
          setupRequired,
          options: {
            dateFormats: dateFormatOptions,
            timeFormats: timeFormatOptions,
            timeZones: availableTimeZones(),
          },
        });
      if (path === "/v1/public/auth/state") {
        const user = getUser();
        return send(response, {
          user,
          account: user
            ? {
                email: user.email,
                name: user.name,
                emailVerified: user.emailVerified,
              }
            : null,
        });
      }
      if (path === "/v1/public/auth/setup" && method === "POST") {
        const input = await body(request);
        if (!setupRequired)
          return fail(response, "This instance is already configured", 409);
        if (input.setupSecret !== "fixture-installation-secret")
          return fail(
            response,
            "The installation setup secret is incorrect",
            403,
          );
        if (
          String(input.password).length < 15 ||
          input.password !== input.confirmPassword
        )
          return fail(
            response,
            "Use matching passwords with at least 15 characters",
            400,
          );
        selected = members[0]!;
        Object.assign(selected, {
          name: input.displayName,
          email: input.email,
          emailVerified: true,
        });
        passwords.set(selected.userId, String(input.password));
        team.name = String(input.teamName);
        setupRequired = false;
        signedIn = true;
        return send(
          response,
          { user: getUser(), twoFactorRequired: false },
          201,
        );
      }
      if (path === "/v1/public/auth/login-email" && method === "POST") {
        const input = await body(request);
        const target = members.find((member) => member.email === input.email);
        if (!target || input.password !== passwords.get(target.userId))
          return fail(response, "Invalid email or password", 401);
        selected = target;
        const twoFactorMethods = [
          ...(passkeys.hasPasskey(target.userId) ? ["passkey"] : []),
        ];
        signedIn = twoFactorMethods.length === 0;
        pendingSignIn = signedIn
          ? null
          : {
              id: randomUUID(),
              userId: target.userId,
              expiresAt: Date.now() + 600000,
            };
        return send(response, {
          user: signedIn ? getUser() : null,
          twoFactorRequired: !signedIn,
          twoFactorMethods,
        });
      }
      if (path === "/v1/core/session") {
        if (method === "DELETE") {
          signedIn = false;
          pendingSignIn = null;
          return send(response, null, 204);
        }
        return signedIn
          ? send(response, { user: getUser() })
          : fail(response, "Sign in to continue", 401);
      }
      if (path.startsWith("/v1/public/auth/invitations/")) {
        const [, id, action] =
          path.match(
            /^\/v1\/public\/auth\/invitations\/([^/]+)(?:\/([^/]+))?$/,
          ) ?? [];
        const invitation = invitations.find(
          (item) =>
            item.id === id &&
            item.status === "pending" &&
            item.expiresAt > now(),
        );
        if (!invitation)
          return fail(response, "Invitation is unavailable", 404);
        if (method === "GET")
          return send(response, {
            invitation: { ...invitation, teamName: team.name },
          });
        if (action === "verify")
          return options.smtpAvailable === false
            ? fail(
                response,
                "Ask your admin to configure SMTP before joining",
                409,
              )
            : send(response, {
                existingAccount: members.some(
                  (member) => member.email === invitation.email,
                ),
              });
        if (action === "signup") {
          const input = await body(request);
          if (input.code !== "123456")
            return fail(response, "Invalid verification code", 400);
          selected = {
            id: randomUUID(),
            userId: randomUUID(),
            name: String(input.name),
            email: invitation.email,
            role: invitation.role,
            mustChangePassword: true,
            emailVerified: true,
            twoFactorEnabled: false,
          };
          members.push(selected);
          signedIn = true;
          invitation.status = "accepted";
          return send(response, { user: getUser() });
        }
        if (
          action === "accept" &&
          signedIn &&
          selected.email === invitation.email &&
          selected.emailVerified
        ) {
          invitation.status = "accepted";
          return send(response, { accepted: true });
        }
        return fail(response, "Sign in using the invited email");
      }
      if (path === "/v1/public/auth/confirm-email-change") {
        const input = await body(request);
        const pending = [...pendingEmails.entries()].find(
          ([, change]) =>
            change.id === input.id &&
            change.token === input.token &&
            Date.parse(change.expiresAt) > Date.now(),
        );
        if (!pending)
          return fail(
            response,
            "This link has expired or is no longer valid",
            400,
          );
        const member = members.find((item) => item.userId === pending[0]);
        if (!member) return fail(response, "Account unavailable", 400);
        member.email = pending[1].email;
        member.emailVerified = true;
        pendingEmails.delete(member.userId);
        signedIn = false;
        return send(response, { success: true });
      }
      if (path.startsWith("/v1/public/auth/identity/")) {
        const action = path.slice("/v1/public/auth/identity/".length);
        if (action.startsWith("passkey/")) {
          try {
            const result = await passkeys.handle(
              action,
              method === "POST" ? await body(request) : {},
            );
            selected.twoFactorEnabled = passkeys.hasPasskey(selected.userId);
            return send(response, result);
          } catch (error) {
            return fail(
              response,
              error instanceof Error ? error.message : "Passkey failed",
              400,
            );
          }
        }
        if (action === "sign-out") {
          signedIn = false;
          pendingSignIn = null;
          return send(response, { success: true });
        }
        if (action === "send-verification-email") {
          if (!signedIn || selected.mustChangePassword)
            return fail(
              response,
              "Sign in and finish password setup to continue",
            );
          const input = await body(request);
          if (
            String(input.email).trim().toLowerCase() !== selected.email ||
            selected.emailVerified
          )
            return fail(
              response,
              "This email address does not need verification.",
              400,
            );
          const now = Date.now();
          const recent = (
            verificationRequests.get(selected.userId) ?? []
          ).filter((sentAt) => sentAt > now - 24 * 60 * 60_000);
          if (recent.length >= 5)
            return fail(
              response,
              "You’ve requested 5 confirmation emails in the last 24 hours. Try again later.",
              429,
            );
          if (recent.at(-1) && recent.at(-1)! > now - 60_000)
            return fail(
              response,
              "Wait at least one minute before requesting another confirmation email.",
              429,
            );
          verificationRequests.set(selected.userId, [...recent, now]);
          return send(response, { status: true });
        }
        if (action === "request-password-reset")
          return send(response, { status: true });
        if (action === "reset-password") {
          const input = await body(request);
          if (input.token !== "fixture-reset-token")
            return fail(response, "This reset link has expired", 400);
          passwords.set(selected.userId, String(input.newPassword));
          signedIn = false;
          return send(response, { status: true });
        }
        return fail(response, "Not found", 404);
      }
      if (!path.startsWith("/v1/core/")) return false;
      if (!signedIn) return fail(response, "Sign in to continue", 401);
      if (
        selected.mustChangePassword &&
        ![
          "/v1/core/profile/password",
          "/v1/core/profile",
          "/v1/core/session",
        ].includes(path)
      )
        return fail(response, "Replace your temporary password first");
      if (path === "/v1/core/profile/passkeys" && method === "GET") {
        return send(response, {
          passkeys: await passkeys.handle("passkey/list-user-passkeys", {}),
        });
      }
      if (path === "/v1/core/profile/preferences") {
        if (method === "PUT") {
          preferencesByUser.set(
            selected.userId,
            dateTimePreferencesSchema.parse(await body(request)),
          );
        } else if (method !== "GET")
          return fail(response, "Method not allowed", 405);
        const preferences = getPreferences();
        const instant = now();
        return send(response, {
          preferences,
          options: {
            dateFormats: dateFormatOptions,
            timeFormats: timeFormatOptions,
            timeZones: availableTimeZones(),
          },
          preview: {
            instant,
            display: createDateTimeFormatter(preferences)(instant),
          },
        });
      }
      if (path === "/v1/core/profile/preferences/range" && method === "POST")
        return send(response, {
          form: initializeDateTimeRange(
            getPreferences(),
            rangeInitializationSchema.parse(await body(request)),
          ),
        });
      if (
        path === "/v1/core/profile/preferences/range/resolve" &&
        method === "POST"
      )
        return send(
          response,
          resolveDateTimeRange(
            getPreferences(),
            preferredRangeSchema.parse(await body(request)),
          ),
        );
      if (
        path === "/v1/core/profile/preferences/preview" &&
        method === "POST"
      ) {
        const preferences = dateTimePreferencesSchema.parse(
          await body(request),
        );
        const instant = now();
        return send(response, {
          preview: {
            instant,
            display: createDateTimeFormatter(preferences)(instant),
          },
        });
      }
      if (path === "/v1/core/date-time/localize" && method === "POST") {
        const input = await body(request);
        if (
          !Array.isArray(input.timestamps) ||
          input.timestamps.length > 2000 ||
          input.timestamps.some(
            (value) =>
              typeof value !== "string" ||
              !createDateTimeFormatter(getPreferences())(value),
          )
        )
          return fail(response, "Provide valid timestamps", 400);
        return send(response, { timestamps: input.timestamps });
      }
      if (path === "/v1/core/profile/email-change") {
        if (method === "GET")
          return send(response, {
            pending: pendingEmails.get(selected.userId) ?? null,
          });
        if (method === "DELETE") {
          pendingEmails.delete(selected.userId);
          return send(response, null, 204);
        }
        const input = await body(request);
        if (
          !String(input.email).includes("@") ||
          members.some((m) => m.email === input.email)
        )
          return fail(response, "Enter an available email address", 409);
        const pending = {
          id: randomUUID(),
          email: String(input.email),
          token: randomBytes(32).toString("base64url"),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
        pendingEmails.set(selected.userId, pending);
        return send(response, {
          email: pending.email,
          expiresAt: pending.expiresAt,
        });
      }
      if (path === "/v1/core/profile/passkeys/recovery-codes") {
        if (!passkeys.hasPasskey(selected.userId))
          return fail(response, "Add a passkey first");
        return send(response, {
          recoveryCodes: passkeys.replaceRecoveryCodes(selected.userId),
        });
      }
      if (path === "/v1/core/profile") {
        if (method === "PATCH")
          selected.name = String((await body(request)).displayName);
        return send(response, { user: getUser() });
      }
      if (path === "/v1/core/profile/password") {
        const input = await body(request);
        if (
          String(input.newPassword).length < 15 ||
          input.newPassword !== input.confirmPassword
        )
          return fail(
            response,
            "Passwords must match and contain at least 15 characters",
            400,
          );
        passwords.set(selected.userId, String(input.newPassword));
        selected.mustChangePassword = false;
        return send(response, null, 204);
      }
      if (path === "/v1/core/session/reauthenticate") {
        const input = await body(request);
        return input.password === passwords.get(selected.userId)
          ? send(response, { success: true })
          : fail(response, "Invalid password", 401);
      }
      if (path.startsWith("/v1/core/team")) {
        if (selected.role !== "admin")
          return fail(response, "Only admins can manage the team");
        if (path === "/v1/core/team") {
          if (method === "PATCH") {
            const input = await body(request);
            team = {
              ...team,
              name: String(input.name),
              description: String(input.description ?? ""),
            };
          }
          return send(response, { team });
        }
        if (path === "/v1/core/team/members") {
          if (method === "GET") {
            const offset = Number(url.searchParams.get("offset") ?? 0);
            return send(response, {
              members: members.slice(offset, offset + 25),
              total: members.length,
            });
          }
          const input = await body(request);
          if (
            !isWorkspaceRole(input.role) ||
            !input.name ||
            !input.email ||
            String(input.password).length < 15
          )
            return fail(response, "Check the required fields", 400);
          if (members.some((member) => member.email === input.email))
            return fail(response, "This person already has an account", 409);
          const member: Member = {
            id: randomUUID(),
            userId: randomUUID(),
            name: String(input.name),
            email: String(input.email),
            role: input.role,
            mustChangePassword: true,
            emailVerified: false,
            twoFactorEnabled: false,
          };
          members.push(member);
          passwords.set(member.userId, String(input.password));
          return send(response, member, 201);
        }
        const memberId = path.match(
          /^\/v1\/core\/team\/members\/([^/]+)$/,
        )?.[1];
        if (memberId) {
          const target = members.find((member) => member.id === memberId);
          if (!target) return fail(response, "Member not found", 404);
          const input = method === "DELETE" ? {} : await body(request);
          if (
            target.role === "admin" &&
            input.role !== "admin" &&
            members.filter((member) => member.role === "admin").length <= 1
          )
            return fail(
              response,
              "Keep at least one admin. Promote another member first",
              409,
            );
          if (method === "DELETE") {
            members.splice(members.indexOf(target), 1);
            if (target === selected) signedIn = false;
            for (const key of keys)
              if (key.ownerUserId === target.userId) key.revokedAt = now();
            return send(response, null, 204);
          }
          if (!isWorkspaceRole(input.role))
            return fail(response, "Choose a valid role", 400);
          target.role = input.role;
          if (typeof input.name === "string" && input.name.trim())
            target.name = input.name.trim();
          for (const key of keys)
            if (key.ownerUserId === target.userId)
              Object.assign(key, constrainPersonalKey(key, target.role));
          return send(response, { role: target.role });
        }
        if (path === "/v1/core/team/invitations") {
          if (method === "GET") return send(response, { invitations });
          const input = await body(request);
          if (!isWorkspaceRole(input.role))
            return fail(response, "Choose a valid role", 400);
          for (const invitation of invitations)
            if (invitation.email === input.email)
              invitation.status = "canceled";
          const invitation: Invitation = {
            id: randomUUID(),
            email: String(input.email),
            role: input.role,
            status: "pending",
            expiresAt: expiry(7),
            deliveryStatus: options.smtpAvailable === false ? "failed" : "sent",
            errorCode:
              options.smtpAvailable === false ? "SMTP_NOT_CONFIGURED" : null,
          };
          invitations.push(invitation);
          return send(
            response,
            {
              ...invitation,
              inviteUrl: `${reusable(request)}/invite/${invitation.id}`,
            },
            201,
          );
        }
        const invitation = invitations.find(
          (item) => path === `/v1/core/team/invitations/${item.id}`,
        );
        if (invitation && method === "DELETE") {
          invitation.status = "canceled";
          return send(response, null, 204);
        }
      }
      const keyMatch = path.match(
        /^\/v1\/core\/settings\/api-keys\/(personal|team)(?:\/([^/]+))?$/,
      );
      if (keyMatch) {
        const scope = keyMatch[1] as KeyScope;
        if (scope === "team" && selected.role !== "admin")
          return fail(response, "Only admins can manage team keys");
        if (keyMatch[2]) {
          const key = keys.find(
            (key) =>
              key.id === keyMatch[2] &&
              key.scope === scope &&
              (scope === "team" || key.ownerUserId === selected.userId),
          );
          if (!key) return fail(response, "Key not found", 404);
          key.revokedAt = now();
          return send(response, null, 204);
        }
        if (method === "GET")
          return send(response, {
            keys: keys.filter(
              (key) =>
                key.scope === scope &&
                (scope === "team" || key.ownerUserId === selected.userId),
            ),
            apiUrl: "https://api.example.com/v1/api",
            mcpUrl: "https://api.example.com/v1/mcp",
            rateLimit: { requests: 60, windowSeconds: 60 },
          });
        const input = await body(request),
          access = input.access as KeyAccess,
          includeAdmin = input.includeAdmin === true;
        if (
          typeof input.name !== "string" ||
          !input.name.trim() ||
          typeof input.includeAdmin !== "boolean" ||
          !(
            input.expiresAt === null ||
            (typeof input.expiresAt === "string" &&
              Number.isFinite(Date.parse(input.expiresAt)))
          ) ||
          (includeAdmin && access !== "edit")
        )
          return fail(response, "Enter a name, permissions and expiry", 400);
        if (
          !["read", "edit"].includes(access) ||
          !canCreateKey(selected.role, { scope, access, includeAdmin })
        )
          return fail(response, "These permissions exceed your role");
        const requestId = String(
          request.headers["idempotency-key"] ?? randomUUID(),
        );
        const replay = keys.find(
          (key) => key.id === keyRequests.get(requestId),
        );
        if (replay)
          return send(response, { key: replay, token: null, replayed: true });
        const key: Key = {
          id: randomUUID(),
          name: String(input.name).trim(),
          scope,
          access,
          includeAdmin,
          grants: keyCeiling(selected.role, access, includeAdmin),
          prefix: "twb_fixture",
          ownerUserId: scope === "team" ? null : selected.userId,
          createdAt: now(),
          expiresAt: input.expiresAt === null ? null : String(input.expiresAt),
          lastUsedAt: null,
          revokedAt: null,
        };
        keys.push(key);
        keyRequests.set(requestId, key.id);
        return send(
          response,
          { key, token: `twb_fixture_only_${randomUUID()}`, replayed: false },
          201,
        );
      }
      if (
        selected.role !== "admin" &&
        /\/v1\/core\/(?:team(?:\/|$)|settings\/private-keys|aws|gcp|system-health|notifications\/|github(?:$|\/configuration|\/install)|.*\/(?:credentials|host-keys|orphans|auto-deploy-control)(?:\/|$))/.test(
          path,
        )
      )
        return fail(response, "Your role cannot access this setting");
      if (
        selected.role !== "admin" &&
        /\/(?:reveal|reveal-all|secret)$/.test(path)
      )
        return fail(response, "Only admins can reveal stored credentials");
      if (
        selected.role === "viewer" &&
        /\/(?:secrets|settings\/secrets)(?:\/|$)/.test(path)
      )
        return fail(response, "Your role cannot manage secrets");
      if (method !== "GET" && selected.role !== "admin") {
        const personal =
          /\/(?:profile|sessions|notification-center)(?:\/|$)/.test(path);
        const member =
          selected.role === "member" &&
          ((/\/sources(?:\/|$)/.test(path) &&
            !/\/(?:deploy|backups|previews|auto-deploy)/.test(path)) ||
            /\/(?:secrets|settings\/secrets|monitoring|scout)(?:\/|$)/.test(
              path,
            ));
        if (!personal && !member)
          return fail(response, "Your role cannot perform this action");
      }
      return false;
    } catch {
      return fail(response, "Unable to apply fixture form", 400);
    }
  }
  return { handle, getUser, getPreferences };
}
