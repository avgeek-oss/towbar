import { installationSetupSecret } from "../auth/setup-secret.js";
import {
  configureSettingsTestEnv,
  settingsTestClient,
} from "./settings-test-client.js";
import assert from "node:assert/strict";
import test from "node:test";
import { verifyPasskeySecurity } from "./passkey-security-tests.js";
import {
  verifyEmailResendLimits,
  verifyPublicEmailResend,
} from "./email-verification-security-tests.js";

const databaseUrl = process.env.TOWBAR_SETTINGS_TEST_DATABASE_URL;
void test(
  "account settings security",
  { skip: !databaseUrl, timeout: 120000 },
  async (t) => {
    configureSettingsTestEnv(databaseUrl);
    const { eq, and, desc } = await import("drizzle-orm");
    const schema = await import("@workspace/towbar-database/schema");
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const database = getTowbarDatabase();
    const auth = await import("../auth/service.js");
    const { getEnv } = await import("../../env.js");
    const { createApp } = await import("../../app.js");
    const app = createApp();
    const origin = new URL(getEnv().TOWBAR_APP_BASE_URL).origin;
    const password = "A unique settings passphrase 48176";
    const client = settingsTestClient(app, origin);
    const { cookies, request, ok } = client;
    const publicHeaders = new Headers({ origin });
    try {
      assert((await auth.getInitialSetupStatus()).setupRequired);
      const setup = await auth.createInitialAdmin({
        setupSecret: installationSetupSecret(),
        teamName: "Settings test",
        displayName: "Admin",
        email: "admin@settings.test",
        password,
      });
      let adminHeaders = cookies(setup);
      const admin = (await auth.findSession(adminHeaders))!.user;
      let memberHeaders: Headers;
      let memberId: string;
      await t.test(
        "reject direct member creation and enforce member edit boundaries",
        async () => {
          assert.equal(
            (
              await request("/v1/core/team/members", adminHeaders, {
                name: "Member",
                email: "member@settings.test",
                password,
                role: "member",
              })
            ).status,
            404,
          );
          const teams = await import("./service.js");
          const member = await teams.createTeamMember(admin, {
            name: "Member",
            email: "member@settings.test",
            password,
            role: "member",
          });
          memberId = member.id;
          const login = await auth.authenticatePassword({
            email: "member@settings.test",
            password,
          });
          memberHeaders = cookies(login);
          assert.equal(
            (
              await request(
                "/v1/core/profile/passkeys/recovery-codes",
                memberHeaders,
                {},
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await request(
                "/v1/public/auth/identity/passkey/generate-register-options",
                memberHeaders,
              )
            ).status,
            403,
          );
          await ok(
            await request(
              "/v1/core/team/members/" + memberId,
              adminHeaders,
              { name: "Updated member", role: "viewer" },
              "PATCH",
            ),
          );
          assert.equal(
            (
              await database
                .select()
                .from(schema.users)
                .where(eq(schema.users.id, member.userId))
            )[0]!.displayName,
            "Updated member",
          );
          memberHeaders = cookies(
            await auth.authenticatePassword({
              email: "member@settings.test",
              password,
            }),
          );
          const changed = await ok(
            await request(
              "/v1/core/profile/password",
              memberHeaders,
              {
                currentPassword: password,
                newPassword: password + " updated",
                confirmPassword: password + " updated",
              },
              "PUT",
            ),
          );
          memberHeaders = cookies(changed, memberHeaders);
          assert.equal(
            (
              await request(
                "/v1/core/team/members/" + memberId,
                memberHeaders,
                { role: "admin" },
                "PATCH",
              )
            ).status,
            403,
          );
        },
      );
      await t.test(
        "retired authenticator endpoints cannot be used",
        async () => {
          for (const path of [
            "/v1/public/auth/identity/two-factor/enable",
            "/v1/public/auth/identity/two-factor/verify-totp",
            "/v1/core/profile/two-factor/setup",
          ])
            assert.equal((await request(path, adminHeaders, {})).status, 404);
        },
      );
      await t.test(
        "passkeys require origin, device verification, ownership and single-use challenges",
        async () => {
          adminHeaders = await verifyPasskeySecurity({
            database,
            auth,
            adminHeaders,
            memberHeaders,
            publicHeaders,
            adminId: admin.id,
            origin,
            password,
            client,
          });
        },
      );
      // Resend checks need an unverified account; the installation admin is verified.
      await database
        .update(schema.users)
        .set({ emailVerified: false })
        .where(eq(schema.users.id, admin.id));
      await t.test(
        "email verification is limited to five sends per day with a concurrent-safe one-minute cooldown",
        () =>
          verifyEmailResendLimits({
            database,
            client,
            headers: adminHeaders,
            publicHeaders,
            email: admin.email,
          }),
      );
      await t.test(
        "public verification requests keep account eligibility private and enforce uniform budgets",
        () =>
          verifyPublicEmailResend({
            database,
            client,
            headers: adminHeaders,
            publicHeaders,
            email: admin.email,
            memberEmail: "member@settings.test",
          }),
      );
      await database
        .update(schema.users)
        .set({ emailVerified: true })
        .where(eq(schema.users.id, admin.id));
      await t.test(
        "email changes are verified, expiring, replaceable and consumed once",
        async () => {
          const { decryptCredential, parseCredentialsMasterKey } =
            await import("@workspace/towbar-core");
          async function latestProof(email: string) {
            const [mail] = await database
              .select()
              .from(schema.transactionalEmails)
              .where(
                and(
                  eq(schema.transactionalEmails.recipient, email),
                  eq(
                    schema.transactionalEmails.template,
                    "email-change-verification",
                  ),
                ),
              )
              .orderBy(desc(schema.transactionalEmails.createdAt));
            const data = decryptCredential<{ actionUrl: string }>({
              associatedData: `towbar:transactional-email:${mail!.workspaceId}:${mail!.id}`,
              masterKey: parseCredentialsMasterKey(
                getEnv().TOWBAR_CREDENTIALS_KEY,
              ),
              envelope: mail!.encryptedData!,
            });
            const [id, token] = new URL(data.actionUrl).hash
              .slice(1)
              .split(".");
            return { id, token };
          }
          assert.equal(
            (
              await request("/v1/core/profile/email-change", publicHeaders, {
                email: "new@settings.test",
              })
            ).ok,
            false,
          );
          const firstEmail = "first@settings.test";
          await ok(
            await request("/v1/core/profile/email-change", adminHeaders, {
              email: firstEmail,
            }),
          );
          const first = await latestProof(firstEmail);
          assert.equal(
            (await auth.findSession(adminHeaders))!.user.email,
            "admin@settings.test",
          );
          assert.equal(
            (
              await request(
                "/v1/public/auth/confirm-email-change",
                publicHeaders,
                { ...first, token: "x".repeat(43) },
              )
            ).status,
            400,
          );
          await database
            .update(schema.emailChanges)
            .set({ expiresAt: new Date(0) })
            .where(eq(schema.emailChanges.userId, admin.id));
          assert.equal(
            (
              await request(
                "/v1/public/auth/confirm-email-change",
                publicHeaders,
                first,
              )
            ).status,
            400,
          );
          await ok(
            await request("/v1/core/profile/email-change", adminHeaders, {
              email: "new@settings.test",
            }),
          );
          assert.equal(
            (
              await request(
                "/v1/public/auth/confirm-email-change",
                publicHeaders,
                first,
              )
            ).status,
            400,
          );
          const proof = await latestProof("new@settings.test");
          const pending = await (
            await request("/v1/core/profile/email-change", adminHeaders)
          ).json();
          assert(!JSON.stringify(pending).includes(proof.token!));
          const confirmations = await Promise.all([
            request(
              "/v1/public/auth/confirm-email-change",
              publicHeaders,
              proof,
            ),
            request(
              "/v1/public/auth/confirm-email-change",
              publicHeaders,
              proof,
            ),
          ]);
          assert.equal(
            confirmations.filter((response) => response.ok).length,
            1,
          );
          assert.equal(await auth.findSession(adminHeaders), null);
          const updated = (
            await database
              .select()
              .from(schema.users)
              .where(eq(schema.users.id, admin.id))
          )[0]!;
          assert.equal(updated.email, "new@settings.test");
          assert.equal(updated.emailVerified, true);
          const notices = await database
            .select()
            .from(schema.transactionalEmails)
            .where(
              and(
                eq(schema.transactionalEmails.template, "email-changed"),
                eq(schema.transactionalEmails.recipient, "admin@settings.test"),
              ),
            );
          assert.equal(notices.length, 1);
          const login = await ok(
            await request("/v1/public/auth/login-email", publicHeaders, {
              email: "new@settings.test",
              password,
            }),
          );
          adminHeaders = cookies(login);
          await ok(
            await request("/v1/core/profile/email-change", adminHeaders, {
              email: "cancelled@settings.test",
            }),
          );
          const cancelled = await latestProof("cancelled@settings.test");
          await ok(
            await request(
              "/v1/core/profile/email-change",
              adminHeaders,
              undefined,
              "DELETE",
            ),
          );
          assert.equal(
            (
              await request(
                "/v1/public/auth/confirm-email-change",
                publicHeaders,
                cancelled,
              )
            ).status,
            400,
          );
        },
      );
    } finally {
      await closeDatabase();
    }
  },
);
