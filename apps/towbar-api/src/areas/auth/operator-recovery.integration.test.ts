import { installationSetupSecret } from "./setup-secret.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  configureSettingsTestEnv,
  settingsTestClient,
} from "../team/settings-test-client.js";

const databaseUrl = process.env.TOWBAR_RECOVERY_TEST_DATABASE_URL;
void test(
  "host recovery changes only the selected account and revokes stale access",
  { skip: !databaseUrl, timeout: 90000 },
  async () => {
    configureSettingsTestEnv(databaseUrl);
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { eq } = await import("drizzle-orm");
    const schema = await import("@workspace/towbar-database/schema");
    const auth = await import("./service.js");
    const { resetUserMfa } = await import("./operator-recovery.js");
    const teams = await import("../team/service.js");
    const keys = await import("../api-keys/service.js");
    const { createApp } = await import("../../app.js");
    const { getEnv } = await import("../../env.js");
    const database = getTowbarDatabase();
    const client = settingsTestClient(
      createApp(),
      new URL(getEnv().TOWBAR_APP_BASE_URL).origin,
    );
    const password = "Unique recovery test passphrase 813671";
    const temporaryPassword = "Temporary recovery test password 519382";
    try {
      const setup = await auth.createInitialAdmin({
        setupSecret: installationSetupSecret(),
        teamName: "Recovery",
        displayName: "Admin",
        email: "admin@recovery.test",
        password,
      });
      const headers = client.cookies(setup);
      const admin = (await auth.findSession(headers))!.user;
      const member = await teams.createTeamMember(admin, {
        name: "Member",
        email: "member@recovery.test",
        password,
        role: "member",
      });
      const personal = await keys.createApiKey(admin, {
        name: "Personal",
        access: "read",
      });
      const team = await keys.createApiKey(admin, {
        name: "Team",
        access: "read",
        scope: "team",
      });
      await database.insert(schema.authRecoveryCodes).values({
        userId: admin.id,
        codeHashes: ["a".repeat(64)],
      });
      await database
        .update(schema.users)
        .set({ twoFactorEnabled: true, emailVerified: true })
        .where(eq(schema.users.id, admin.id));
      await database.insert(schema.authPasskeys).values({
        userId: admin.id,
        publicKey: "fixture-public-key",
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      });
      await database.insert(schema.authVerifications).values({
        identifier: "reset-password:old-token",
        value: admin.id,
        expiresAt: new Date(Date.now() + 3600000),
      });
      await database.insert(schema.emailChanges).values({
        userId: admin.id,
        previousEmail: admin.email,
        newEmail: "pending@recovery.test",
        tokenHash: "a".repeat(64),
        expiresAt: new Date(Date.now() + 3600000),
      });
      await assert.rejects(
        auth.resetAdminPassword({
          email: admin.email,
          newEmail: "member@recovery.test",
          temporaryPassword,
        }),
        /already in use/,
      );
      assert(await auth.findSession(headers));
      await auth.resetAdminPassword({
        email: admin.email,
        newEmail: "NEW@recovery.test",
        temporaryPassword,
      });
      assert.equal(await auth.findSession(headers), null);
      assert.equal(await keys.findApiKey(personal.token!), null);
      assert(await keys.findApiKey(team.token!));
      const user = (
        await database
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, admin.id))
      )[0]!;
      assert.equal(user.email, "new@recovery.test");
      assert.equal(user.emailVerified, false);
      assert.equal(user.mustChangePassword, true);
      assert.equal(user.twoFactorEnabled, true);
      assert.equal(
        (
          await database
            .select()
            .from(schema.authPasskeys)
            .where(eq(schema.authPasskeys.userId, admin.id))
        ).length,
        1,
      );
      assert.equal(
        (
          await database
            .select()
            .from(schema.authVerifications)
            .where(eq(schema.authVerifications.value, admin.id))
        ).length,
        0,
      );
      assert.equal(
        (
          await database
            .select()
            .from(schema.emailChanges)
            .where(eq(schema.emailChanges.userId, admin.id))
        ).length,
        0,
      );
      const reset = await client.request(
        "/v1/public/auth/identity/reset-password",
        new Headers({ origin: new URL(getEnv().TOWBAR_APP_BASE_URL).origin }),
        { token: "old-token", newPassword: password + " changed" },
      );
      assert.equal(reset.status, 400);
      assert.equal(
        (await auth.authenticatePassword({ email: admin.email, password }))
          .status,
        401,
      );
      await auth.resetAdminPassword({
        email: user.email,
        temporaryPassword,
        resetMfa: true,
        removePasskeys: true,
      });
      assert.equal(
        (
          await database
            .select()
            .from(schema.authRecoveryCodes)
            .where(eq(schema.authRecoveryCodes.userId, admin.id))
        ).length,
        0,
      );
      assert.equal(
        (
          await database
            .select()
            .from(schema.authPasskeys)
            .where(eq(schema.authPasskeys.userId, admin.id))
        ).length,
        0,
      );
      const recovered = await auth.authenticatePassword({
        email: user.email,
        password: temporaryPassword,
      });
      assert(
        (await auth.findSession(client.cookies(recovered)))!.user
          .mustChangePassword,
      );
      await assert.rejects(
        auth.resetAdminPassword({
          email: "member@recovery.test",
          temporaryPassword,
        }),
        /admin account/,
      );
      await database.insert(schema.authRecoveryCodes).values({
        userId: member.userId,
        codeHashes: ["a".repeat(64)],
      });
      await database
        .update(schema.users)
        .set({ twoFactorEnabled: true })
        .where(eq(schema.users.id, member.userId));
      await resetUserMfa({ email: "member@recovery.test" });
      assert.equal(
        (
          await database
            .select()
            .from(schema.authRecoveryCodes)
            .where(eq(schema.authRecoveryCodes.userId, member.userId))
        ).length,
        0,
      );
      assert.equal(
        (
          await auth.authenticatePassword({
            email: "member@recovery.test",
            password,
          })
        ).status,
        200,
      );
      const audit = await database
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, admin.id));
      assert(
        audit.some((event) => event.action === "account.operator-recovery"),
      );
      assert(!JSON.stringify(audit).includes(temporaryPassword));
      await database
        .update(schema.users)
        .set({ disabledAt: new Date() })
        .where(eq(schema.users.id, member.userId));
      await assert.rejects(
        resetUserMfa({ email: "member@recovery.test" }),
        /Active team member/,
      );
    } finally {
      await closeDatabase();
    }
  },
);
