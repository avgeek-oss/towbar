import { installationSetupSecret } from "./setup-secret.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  configureSettingsTestEnv,
  settingsTestClient,
} from "../team/settings-test-client.js";

const databaseUrl = process.env.TOWBAR_CREDENTIALS_TEST_DATABASE_URL;
void test(
  "credential changes revoke the user's API keys and MCP tokens",
  { skip: !databaseUrl, timeout: 90000 },
  async (t) => {
    configureSettingsTestEnv(databaseUrl);
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { and, desc, eq } = await import("drizzle-orm");
    const schema = await import("@workspace/towbar-database/schema");
    const { decryptCredential, parseCredentialsMasterKey } =
      await import("@workspace/towbar-core");
    const { keyCeiling } = await import("@workspace/towbar-access");
    const auth = await import("./service.js");
    const emailChange = await import("./email-change.js");
    const teams = await import("../team/service.js");
    const keys = await import("../api-keys/service.js");
    const { mcpResource } = await import("../mcp-oauth/protocol.js");
    const { createApp } = await import("../../app.js");
    const { getEnv } = await import("../../env.js");
    const database = getTowbarDatabase();
    const origin = new URL(getEnv().TOWBAR_APP_BASE_URL).origin;
    const client = settingsTestClient(createApp(), origin);
    const password = "Unique credential test passphrase 270519";
    type User = NonNullable<
      Awaited<ReturnType<typeof auth.findSession>>
    >["user"];

    async function signIn(email: string, secret: string) {
      const headers = client.cookies(
        await auth.authenticatePassword({ email, password: secret }),
      );
      return (await auth.findSession(headers))!.user;
    }
    async function mailLink(email: string, template: string) {
      const [mail] = await database
        .select()
        .from(schema.transactionalEmails)
        .where(
          and(
            eq(schema.transactionalEmails.recipient, email),
            eq(schema.transactionalEmails.template, template),
          ),
        )
        .orderBy(desc(schema.transactionalEmails.createdAt));
      assert(mail?.encryptedData);
      return new URL(
        decryptCredential<{ actionUrl: string }>({
          associatedData: `towbar:transactional-email:${mail.workspaceId}:${mail.id}`,
          masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
          envelope: mail.encryptedData,
        }).actionUrl,
      );
    }
    // Personal API key, MCP token and pending MCP authorization for one user.
    async function personalAccess(user: User, label: string) {
      const personal = await keys.createApiKey(user, {
        name: `${label} key`,
        access: "read",
      });
      const mcp = await keys.createApiKey(user, {
        name: `${label} MCP client`,
        access: "read",
        expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        oauth: {
          clientId: `${label}-client`,
          clientName: `${label} MCP client`,
          clientLogo: null,
          clientTrust: "unverified",
          resource: mcpResource(),
          grants: keyCeiling(user.workspaceRole, "read", false),
        },
      });
      const [pending] = await database
        .insert(schema.mcpOAuthRequests)
        .values({
          clientId: `${label}-client`,
          clientName: `${label} MCP client`,
          clientTrust: "unverified",
          redirectUri: "http://127.0.0.1:8976/callback",
          resource: mcpResource(),
          scope: "mcp:read",
          challenge: "c".repeat(43),
          expiresAt: new Date(Date.now() + 600_000),
          userId: user.id,
          workspaceId: user.workspaceId,
          grants: [],
          codeHash: `${label}-${"h".repeat(40)}`,
        })
        .returning({ id: schema.mcpOAuthRequests.id });
      return { personal, mcp, pendingId: pending!.id };
    }
    async function assertRevoked(
      access: Awaited<ReturnType<typeof personalAccess>>,
      revoked: boolean,
    ) {
      for (const key of [access.personal, access.mcp]) {
        const found = await keys.findApiKey(key.token!);
        assert.equal(found === null, revoked);
      }
      const pending = await database
        .select({ id: schema.mcpOAuthRequests.id })
        .from(schema.mcpOAuthRequests)
        .where(eq(schema.mcpOAuthRequests.id, access.pendingId));
      assert.equal(pending.length === 0, revoked);
    }

    try {
      const setup = await auth.createInitialAdmin({
        setupSecret: installationSetupSecret(),
        teamName: "Credentials",
        displayName: "Admin",
        email: "admin@credentials.test",
        password,
      });
      const admin = (await auth.findSession(client.cookies(setup)))!.user;
      const team = await keys.createApiKey(admin, {
        name: "Team service",
        access: "read",
        scope: "team",
      });
      await teams.createTeamMember(admin, {
        name: "Member",
        email: "member@credentials.test",
        password,
        role: "member",
      });
      // The member has finished account setup.
      await database
        .update(schema.users)
        .set({ mustChangePassword: false })
        .where(eq(schema.users.email, "member@credentials.test"));
      const member = await signIn("member@credentials.test", password);
      const memberAccess = await personalAccess(member, "member");

      await t.test("a password change revokes the user's access", async () => {
        const access = await personalAccess(admin, "change");
        await assertRevoked(access, false);
        const headers = client.cookies(
          await auth.authenticatePassword({
            email: "admin@credentials.test",
            password,
          }),
        );
        await auth.changePassword({
          headers,
          currentPassword: password,
          newPassword: password + " changed",
          userId: admin.id,
        });
        await assertRevoked(access, true);
      });

      await t.test("a password reset revokes the user's access", async () => {
        const access = await personalAccess(admin, "reset");
        await client.ok(
          await client.request(
            "/v1/public/auth/identity/request-password-reset",
            new Headers({ origin }),
            {
              email: "admin@credentials.test",
              redirectTo: `${origin}/reset-password`,
            },
          ),
        );
        const token = (
          await mailLink("admin@credentials.test", "password-reset")
        ).pathname
          .split("/")
          .at(-1);
        await client.ok(
          await client.request(
            "/v1/public/auth/identity/reset-password",
            new Headers({ origin }),
            { token, newPassword: password + " reset" },
          ),
        );
        await assertRevoked(access, true);
      });

      await t.test("an email change revokes the user's access", async () => {
        const current = await signIn(
          "admin@credentials.test",
          password + " reset",
        );
        const access = await personalAccess(current, "email");
        await emailChange.requestEmailChange(
          current,
          "changed@credentials.test",
        );
        const [id, token] = (
          await mailLink(
            "changed@credentials.test",
            "email-change-verification",
          )
        ).hash
          .slice(1)
          .split(".");
        await emailChange.confirmEmailChange(id!, token!);
        await assertRevoked(access, true);
      });

      await t.test("other users' keys and team keys stay valid", async () => {
        await assertRevoked(memberAccess, false);
        assert(await keys.findApiKey(team.token!));
      });
    } finally {
      await closeDatabase();
    }
  },
);
