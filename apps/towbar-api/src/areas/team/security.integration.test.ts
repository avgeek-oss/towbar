import { installationSetupSecret } from "../auth/setup-secret.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
const databaseUrl = process.env.TOWBAR_TEAM_TEST_DATABASE_URL;
void test(
  "team access database security boundaries",
  { skip: !databaseUrl, timeout: 120_000 },
  async (t) => {
    assert(
      databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"),
      "Use a disposable test database",
    );
    process.env.DATABASE_TOWBAR_URL = databaseUrl;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    process.env.TOWBAR_APP_BASE_URL = "https://app.towbar.test";
    process.env.TOWBAR_API_BASE_URL = "https://api.towbar.test";
    process.env.TOWBAR_PASSWORD_BREACH_CHECK = "false";
    process.env.TOWBAR_NOTIFICATIONS_ENABLED = "true";
    process.env.TOWBAR_NOTIFICATION_CONFIG_JSON = JSON.stringify({
      providers: {
        smtp: {
          from: "no-reply@example.test",
          host: "smtp.example.test",
          port: 465,
          secure: true,
        },
      },
      routes: [],
    });
    const { eq, and } = await import("drizzle-orm");
    const schema = await import("@workspace/towbar-database/schema");
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const database = getTowbarDatabase();
    const auth = await import("../auth/service.js");
    const teams = await import("./service.js");
    const keys = await import("../api-keys/service.js");
    const { withActor, captureQueuedActor, authorizeQueuedEffect } =
      await import("../auth/actor-context.js");
    const { actorAllows } = await import("@workspace/towbar-access");
    const { createApp } = await import("../../app.js");
    const app = createApp();
    const { getEnv } = await import("../../env.js");
    const origin = new URL(getEnv().TOWBAR_APP_BASE_URL).origin;
    const password = "A unique integration passphrase 5831";
    const updatedPassword = "A different integration passphrase 9052";
    const headersFor = (response: Response) =>
      new Headers({
        cookie: response.headers
          .getSetCookie()
          .map((item) => item.split(";")[0])
          .join("; "),
        origin,
      });
    const request = (
      path: string,
      headers: Headers,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
    ) =>
      app.request(path, {
        method,
        headers: (() => {
          const value = new Headers(headers);
          value.set("content-type", "application/json");
          return value;
        })(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      assert.equal(
        (await auth.getInitialSetupStatus()).setupRequired,
        true,
        "This suite requires a fresh test schema",
      );
      const setupInput = {
        setupSecret: installationSetupSecret(),
        teamName: "Test team",
        displayName: "Admin",
        email: "admin@example.test",
        password,
      };
      const competingSetup = await Promise.allSettled([
        auth.createInitialAdmin(setupInput),
        auth.createInitialAdmin(setupInput),
      ]);
      assert.equal(
        competingSetup.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const successfulSetup = competingSetup.find(
        (result) => result.status === "fulfilled",
      )!;
      const setup = successfulSetup.value;
      assert.equal(setup.status, 200);
      let adminHeaders = headersFor(setup);
      const admin = (await auth.findSession(adminHeaders))!.user;
      assert.equal(admin.workspaceRole, "admin");
      assert.equal(admin.emailVerified, true);
      const emails = await database.select().from(schema.transactionalEmails);
      assert.equal(emails.length, 0);
      await t.test(
        "raw enrollment and organization/key APIs cannot bypass the facade",
        async () => {
          for (const path of [
            "sign-up/email",
            "organization/create",
            "organization/update-member-role",
            "api-key/create",
            "sign-in/email-otp",
          ]) {
            const response = await request(
              `/v1/public/auth/identity/${path}`,
              adminHeaders,
              {},
            );
            assert.equal(response.status, 404, path);
          }
          await assert.rejects(
            auth.createInitialAdmin({
              ...setupInput,
              teamName: "Other",
              displayName: "Attacker",
              email: "attacker@example.test",
            }),
          );
        },
      );
      const member = await teams.createTeamMember(admin, {
        name: "Member",
        email: "member@example.test",
        password,
        role: "member",
      });
      let memberHeaders = headersFor(
        await auth.authenticatePassword({
          email: "member@example.test",
          password,
        }),
      );
      await t.test(
        "temporary passwords cannot reach team data or API keys",
        async () => {
          assert.equal(
            (await request("/v1/core/apps", memberHeaders)).status,
            403,
          );
          assert.equal(
            (
              await request(
                "/v1/core/settings/api-keys/personal",
                memberHeaders,
              )
            ).status,
            403,
          );
          assert.equal(
            (await auth.findSession(memberHeaders))?.user.mustChangePassword,
            true,
          );
          const oldHeaders = memberHeaders;
          const changed = await request(
            "/v1/core/profile/password",
            memberHeaders,
            {
              currentPassword: password,
              newPassword: updatedPassword,
              confirmPassword: updatedPassword,
            },
            "PUT",
          );
          assert.equal(changed.status, 204);
          memberHeaders = headersFor(changed);
          assert(
            memberHeaders.get("cookie"),
            "Password replacement forwards the rotated session cookie",
          );
          assert.equal(await auth.findSession(oldHeaders), null);
          assert.equal(
            (await request("/v1/core/apps", memberHeaders)).status,
            200,
          );
          assert.equal(
            (await auth.findSession(memberHeaders))?.user.mustChangePassword,
            false,
          );
        },
      );
      const memberUser = (await auth.findSession(memberHeaders))!.user;
      const personal = await keys.createApiKey(memberUser, {
        name: "Member automation",
        access: "edit",
      });
      const adminKey = await keys.createApiKey(admin, {
        name: "Team automation",
        scope: "team",
        access: "edit",
        includeAdmin: true,
      });
      assert(personal.token);
      assert(adminKey.token);
      const personalToken = personal.token;
      const teamToken = adminKey.token;
      await t.test(
        "members are denied admin routes through sessions and bearer keys",
        async () => {
          const bearer = new Headers({
            authorization: `Bearer ${personal.token}`,
          });
          for (const path of [
            "/team",
            "/settings/private-keys",
            "/github",
            "/settings/api-keys/team",
          ]) {
            assert(
              [403, 404].includes(
                (await request(`/v1/core${path}`, memberHeaders)).status,
              ),
              path,
            );
            assert(
              [403, 404].includes(
                (await request(`/v1/api${path}`, bearer)).status,
              ),
              path,
            );
          }
          await assert.rejects(
            keys.createApiKey(memberUser, {
              name: "Forged",
              access: "edit",
              includeAdmin: true,
            }),
          );
          await assert.rejects(
            keys.createApiKey(memberUser, {
              name: "Forged team",
              scope: "team",
              access: "read",
            }),
          );
        },
      );
      const queued = withActor(
        (await keys.findApiKey(personalToken))!.actor,
        () => captureQueuedActor(admin.workspaceId, ["secret.update"]),
      );
      await t.test(
        "demotion immediately caps personal keys and queued work, and promotion cannot restore grants",
        async () => {
          await teams.updateMemberRole(admin, member.id, "viewer");
          const capped = (await keys.findApiKey(personalToken))!;
          assert.equal(capped.key.access, "read");
          assert.equal(actorAllows(capped.actor, ["secret.update"]), false);
          assert.equal(actorAllows(capped.actor, ["repository.read"]), true);
          await assert.rejects(
            authorizeQueuedEffect(queued.requestedByActor, admin.workspaceId, [
              "secret.update",
            ]),
          );
          memberHeaders = headersFor(
            await auth.authenticatePassword({
              email: "member@example.test",
              password: updatedPassword,
            }),
          );
          const viewer = (await auth.findSession(memberHeaders))!.user;
          await assert.rejects(
            keys.createApiKey(viewer, {
              name: "Edit forbidden",
              access: "edit",
            }),
          );
          await keys.createApiKey(viewer, {
            name: "Viewer read",
            access: "read",
          });
          assert.equal(
            (await request("/v1/core/sources/discover", memberHeaders, {}))
              .status,
            403,
          );
          await teams.updateMemberRole(admin, member.id, "admin");
          memberHeaders = headersFor(
            await auth.authenticatePassword({
              email: "member@example.test",
              password: updatedPassword,
            }),
          );
          assert.equal(
            (await keys.findApiKey(personalToken))?.key.access,
            "read",
          );
        },
      );
      await t.test(
        "last-admin changes are serialized under concurrent requests",
        async () => {
          const secondAdmin = (await auth.findSession(memberHeaders))!.user;
          const [firstMembership] = await database
            .select()
            .from(schema.workspaceMembers)
            .where(eq(schema.workspaceMembers.userId, admin.id));
          const results = await Promise.allSettled([
            teams.updateMemberRole(admin, member.id, "viewer"),
            teams.updateMemberRole(secondAdmin, firstMembership!.id, "viewer"),
          ]);
          assert.equal(
            results.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const admins = await database
            .select()
            .from(schema.workspaceMembers)
            .where(eq(schema.workspaceMembers.role, "admin"));
          assert.equal(admins.length, 1);
          // Restore the initial test admin using the surviving live admin.
          if (admins[0]!.userId !== admin.id)
            await teams.updateMemberRole(
              (await auth.getUserIdentity(admins[0]!.userId))!,
              firstMembership!.id,
              "admin",
            );
        },
      );
      adminHeaders = headersFor(
        await auth.authenticatePassword({
          email: "admin@example.test",
          password,
        }),
      );
      await t.test(
        "an invitation link cannot create an account without mailbox proof",
        async () => {
          const invitation = await teams.createTeamInvitation(
            admin,
            { email: "invitee@example.test", role: "viewer" },
            adminHeaders,
          );
          assert.equal(
            (await teams.getInvitationPreview(invitation.id)).role,
            "viewer",
          );
          assert.equal(
            (
              await teams.completeInvitationSignup(invitation.id, {
                name: "Attempt",
                code: "000000",
              })
            ).ok,
            false,
          );
          assert.equal(
            (
              await database
                .select()
                .from(schema.users)
                .where(eq(schema.users.email, "invitee@example.test"))
            ).length,
            0,
          );
          assert.deepEqual(await teams.beginInvitationSignup(invitation.id), {
            existingAccount: false,
          });
          const [mail] = await database
            .select()
            .from(schema.transactionalEmails)
            .where(
              and(
                eq(
                  schema.transactionalEmails.recipient,
                  "invitee@example.test",
                ),
                eq(
                  schema.transactionalEmails.template,
                  "invitation-verification",
                ),
              ),
            );
          assert(mail?.encryptedData);
          const { decryptCredential, parseCredentialsMasterKey } =
            await import("@workspace/towbar-core");
          const data = decryptCredential<{ verificationCode: string }>({
            associatedData: `towbar:transactional-email:${mail.workspaceId}:${mail.id}`,
            masterKey: parseCredentialsMasterKey(
              getEnv().TOWBAR_CREDENTIALS_KEY,
            ),
            envelope: mail.encryptedData,
          });
          const accepted = await teams.completeInvitationSignup(invitation.id, {
            name: "Invitee",
            code: data.verificationCode,
          });
          assert.equal(accepted.status, 200);
          const invitedHeaders = headersFor(accepted);
          const identity = (await auth.findSession(invitedHeaders))!;
          assert.equal(identity.user.emailVerified, true);
          assert.equal(identity.user.workspaceRole, "viewer");
          assert.equal(identity.user.mustChangePassword, true);
          await auth.changePassword({
            headers: invitedHeaders,
            userId: identity.user.id,
            newPassword: password,
          });
          await assert.rejects(
            teams.completeInvitationSignup(invitation.id, {
              name: "Replay",
              code: data.verificationCode,
            }),
          );
        },
      );
      await t.test(
        "revoked invitations suppress delivery and never emit secret content to the worker",
        async () => {
          const invitation = await teams.createTeamInvitation(
            admin,
            { email: "revoked@example.test", role: "member" },
            adminHeaders,
          );
          const [mail] = await database
            .select()
            .from(schema.transactionalEmails)
            .where(eq(schema.transactionalEmails.invitationId, invitation.id));
          await teams.revokeInvitation(admin, invitation.id);
          const { executeTransactionalEmail } =
            await import("./email-delivery.js");
          let sends = 0;
          const { getNotificationProviderConfiguration } =
            await import("../notifications/configuration.js");
          const result = await executeTransactionalEmail(mail!.id, {
            configuration: getNotificationProviderConfiguration,
            now: () => new Date(),
            send: () => {
              sends++;
              return Promise.resolve({ providerStatus: "accepted" });
            },
          });
          assert.deepEqual(result, { outcome: "done" });
          assert.equal(sends, 0);
          const [stored] = await database
            .select()
            .from(schema.transactionalEmails)
            .where(eq(schema.transactionalEmails.id, mail!.id));
          assert.equal(stored!.encryptedData, null);
        },
      );
      await t.test(
        "API key retries are idempotent without replaying the one-time token",
        async () => {
          const requestId = randomUUID();
          const input = {
            name: "Idempotent",
            access: "read" as const,
            requestId,
          };
          const created = await keys.createApiKey(admin, input);
          const replay = await keys.createApiKey(admin, input);
          assert(created.token);
          assert.equal(replay.token, null);
          assert.equal(replay.key.id, created.key.id);
          assert.equal(replay.replayed, true);
          await assert.rejects(
            keys.createApiKey(admin, { ...input, name: "Changed request" }),
          );
          await keys.revokeApiKey(admin, created.key.id);
          assert.equal(await keys.findApiKey(created.token), null);
          await keys.revokeApiKey(admin, created.key.id);
        },
      );
      const { assertAuthenticationSecurity } =
        await import("./authentication-security-tests.js");
      await assertAuthenticationSecurity({
        t,
        database,
        admin,
        adminHeaders,
        password,
        updatedPassword,
        request,
        headersFor,
        origin,
      });
      await t.test(
        "email claims prevent concurrent sends, retry outages, and purge sensitive payloads",
        async () => {
          const { enqueueTeamEmail } = await import("./email-outbox.js");
          const { executeTransactionalEmail } =
            await import("./email-delivery.js");
          const { getNotificationProviderConfiguration } =
            await import("../notifications/configuration.js");
          const { NotificationProviderError } =
            await import("../notifications/providers.js");
          const id = await enqueueTeamEmail(database, {
            workspaceId: admin.workspaceId,
            recipient: "delivery@example.test",
            template: "password-changed",
            dedupeKey: `test:${randomUUID()}`,
            data: { teamName: "Test team" },
          });
          assert(id);
          let now = new Date(Date.now() + 1000);
          let sends = 0;
          const failing = {
            configuration: getNotificationProviderConfiguration,
            now: () => now,
            send: () => {
              sends++;
              return Promise.reject(
                new NotificationProviderError(
                  "SMTP_UNAVAILABLE",
                  "Unavailable",
                  true,
                ),
              );
            },
          };
          const failed = await executeTransactionalEmail(id, failing);
          assert.equal(failed.outcome, "wait");
          assert.equal(
            (await executeTransactionalEmail(id, failing)).outcome,
            "wait",
          );
          assert.equal(sends, 1);
          now = new Date(now.getTime() + 20_000);
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          let claimed!: () => void;
          const admitted = new Promise<void>((resolve) => {
            claimed = resolve;
          });
          const sending = executeTransactionalEmail(id, {
            ...failing,
            send: async () => {
              sends++;
              claimed();
              await held;
              return { providerStatus: "accepted" };
            },
          });
          await admitted;
          assert.equal(
            (await executeTransactionalEmail(id, failing)).outcome,
            "wait",
          );
          release();
          await sending;
          const [stored] = await database
            .select()
            .from(schema.transactionalEmails)
            .where(eq(schema.transactionalEmails.id, id));
          assert.equal(stored!.status, "sent");
          assert.equal(stored!.encryptedData, null);
          assert.equal(stored!.leaseToken, null);
          assert.equal(sends, 2);
          assert.equal(
            (await executeTransactionalEmail(id, failing)).outcome,
            "done",
          );
          assert.equal(sends, 2);
        },
      );
      const { assertInvitationSecurity } =
        await import("./invitation-security-tests.js");
      const { assertKeyRateLimits } = await import("./key-rate-limit-tests.js");
      await assertKeyRateLimits({ t, database, admin, request });
      await assertInvitationSecurity({
        t,
        database,
        admin,
        adminHeaders,
        password,
        headersFor,
      });
      await t.test(
        "team keys survive creator removal without impersonating that user",
        async () => {
          await teams.updateMemberRole(admin, member.id, "admin");
          const secondAdmin = (await auth.getUserIdentity(member.userId))!;
          const [firstMembership] = await database
            .select()
            .from(schema.workspaceMembers)
            .where(eq(schema.workspaceMembers.userId, admin.id));
          await teams.removeTeamMember(secondAdmin, firstMembership!.id);
          const teamKey = (await keys.findApiKey(teamToken))!;
          assert.equal(teamKey.actor.kind, "team-key");
          assert.equal(teamKey.user.id, null);
          assert.equal(await auth.findSession(adminHeaders), null);
          assert.equal(actorAllows(teamKey.actor, ["deployment.create"]), true);
        },
      );
    } finally {
      await closeDatabase();
    }
  },
);
