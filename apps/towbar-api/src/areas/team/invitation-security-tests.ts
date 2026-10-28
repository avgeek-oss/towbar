import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@workspace/towbar-database/schema";
import type { AuthDatabase } from "../../infrastructure/database.js";
import type { AuthenticatedUser } from "../../http/types.js";
import { createIdentityAuth, identityProvisioning } from "../auth/identity.js";
import * as auth from "../auth/service.js";
import * as keys from "../api-keys/service.js";
import * as teams from "./service.js";
import { enqueueTeamEmail } from "./email-outbox.js";

export async function assertInvitationSecurity({
  t,
  database,
  admin,
  adminHeaders,
  password,
  headersFor,
}: {
  t: TestContext;
  database: AuthDatabase;
  admin: AuthenticatedUser;
  adminHeaders: Headers;
  password: string;
  headersFor: (response: Response) => Headers;
}) {
  await t.test(
    "invite previews are read-only and reissue/expiry invalidates prior invitations",
    async () => {
      const first = await teams.createTeamInvitation(
        admin,
        { email: "reissue@example.test", role: "viewer" },
        adminHeaders,
      );
      assert.equal((await teams.getInvitationPreview(first.id)).role, "viewer");
      assert.equal(
        (await teams.getInvitationPreview(first.id)).email,
        "reissue@example.test",
      );
      const [unconsumed] = await database
        .select()
        .from(schema.workspaceInvitations)
        .where(eq(schema.workspaceInvitations.id, first.id));
      assert.equal(unconsumed!.status, "pending");
      const next = await teams.createTeamInvitation(
        admin,
        { email: "reissue@example.test", role: "member" },
        adminHeaders,
      );
      assert.notEqual(next.id, first.id);
      assert(
        (await teams.listInvitations(admin)).some(
          (item) => item.id === next.id,
        ),
      );
      assert(
        !(await teams.listInvitations(admin)).some(
          (item) => item.id === first.id,
        ),
      );
      await assert.rejects(teams.getInvitationPreview(first.id));
      const [oldMail] = await database
        .select()
        .from(schema.transactionalEmails)
        .where(eq(schema.transactionalEmails.invitationId, first.id));
      assert.equal(oldMail!.encryptedData, null);
      await database
        .update(schema.workspaceInvitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.workspaceInvitations.id, next.id));
      await assert.rejects(teams.getInvitationPreview(next.id));
      assert(
        !(await teams.listInvitations(admin)).some(
          (item) => item.id === next.id,
        ),
      );
      await assert.rejects(
        teams.completeInvitationSignup(next.id, {
          name: "Expired",
          code: "123456",
        }),
      );
    },
  );
  await t.test(
    "existing accounts require matching verified email; concurrent acceptance creates one membership",
    async () => {
      const identity = createIdentityAuth(database);
      const email = "returning@example.test";
      const created = await identityProvisioning.run(
        { reason: "admin", workspaceId: admin.workspaceId },
        () =>
          identity.api.signUpEmail({
            body: { email, password, name: "Returning" },
          }),
      );
      const invitation = await teams.createTeamInvitation(
        admin,
        { email, role: "viewer" },
        adminHeaders,
      );
      await assert.rejects(
        teams.acceptExistingInvitation(invitation.id, adminHeaders),
        /email address/,
      );
      const login = await auth.authenticatePassword({ email, password });
      const headers = headersFor(login);
      await assert.rejects(
        teams.acceptExistingInvitation(invitation.id, headers),
        /Verify your email/,
      );
      const [before] = await database
        .select()
        .from(schema.authAccounts)
        .where(eq(schema.authAccounts.userId, created.user.id));
      await database
        .update(schema.users)
        .set({ emailVerified: true })
        .where(eq(schema.users.id, created.user.id));
      const accepted = await Promise.allSettled([
        teams.acceptExistingInvitation(invitation.id, headers),
        teams.acceptExistingInvitation(invitation.id, headers),
      ]);
      assert.equal(
        accepted.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const memberships = await database
        .select()
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.userId, created.user.id));
      assert.equal(memberships.length, 1);
      assert.equal(memberships[0]!.role, "viewer");
      const [after] = await database
        .select()
        .from(schema.authAccounts)
        .where(eq(schema.authAccounts.userId, created.user.id));
      assert.equal(after!.password, before!.password);
    },
  );
  await t.test(
    "inviter demotion revokes pending invitations and their queued messages",
    async () => {
      const member = await teams.createTeamMember(admin, {
        name: "Inviter",
        email: "inviter@example.test",
        password,
        role: "admin",
      });
      const login = await auth.authenticatePassword({
        email: "inviter@example.test",
        password,
      });
      const headers = headersFor(login);
      await auth.changePassword({
        headers,
        userId: member.userId,
        currentPassword: password,
        newPassword: password + " updated",
      });
      const activeHeaders = headersFor(
        await auth.authenticatePassword({
          email: "inviter@example.test",
          password: password + " updated",
        }),
      );
      const inviter = (await auth.getUserIdentity(member.userId))!;
      const invitation = await teams.createTeamInvitation(
        inviter,
        { email: "delegated@example.test", role: "admin" },
        activeHeaders,
      );
      await teams.updateMemberRole(admin, member.id, "member");
      await assert.rejects(teams.getInvitationPreview(invitation.id));
      const [mail] = await database
        .select()
        .from(schema.transactionalEmails)
        .where(eq(schema.transactionalEmails.invitationId, invitation.id));
      assert.equal(mail!.status, "canceled");
      assert.equal(mail!.encryptedData, null);
    },
  );
  await t.test(
    "outbox insertion rolls back with its domain transaction",
    async () => {
      const dedupeKey = randomUUID();
      await assert.rejects(
        database.transaction(async (tx) => {
          await enqueueTeamEmail(tx, {
            workspaceId: admin.workspaceId,
            recipient: admin.email,
            template: "password-changed",
            dedupeKey,
            data: { teamName: "Test team" },
          });
          throw new Error("domain rollback");
        }),
        /domain rollback/,
      );
      const rows = await database
        .select()
        .from(schema.transactionalEmails)
        .where(eq(schema.transactionalEmails.dedupeKey, dedupeKey));
      assert.equal(rows.length, 0);
    },
  );
  await t.test(
    "operator recovery revokes sessions and personal keys, requires a new password, and rejects non-admins",
    async () => {
      const member = await teams.createTeamMember(admin, {
        name: "Recovery admin",
        email: "operator@example.test",
        password,
        role: "admin",
      });
      const headers = headersFor(
        await auth.authenticatePassword({
          email: "operator@example.test",
          password,
        }),
      );
      await auth.changePassword({
        headers,
        userId: member.userId,
        currentPassword: password,
        newPassword: password + " updated",
      });
      const activeHeaders = headersFor(
        await auth.authenticatePassword({
          email: "operator@example.test",
          password: password + " updated",
        }),
      );
      const identity = (await auth.getUserIdentity(member.userId))!;
      const key = await keys.createApiKey(identity, {
        name: "Recovery key",
        access: "read",
      });
      assert(key.token);
      await auth.resetAdminPassword({
        email: identity.email,
        temporaryPassword: "Temporary recovery passphrase 52917",
        resetMfa: true,
      });
      assert.equal(await auth.findSession(activeHeaders), null);
      assert.equal(await keys.findApiKey(key.token), null);
      assert.equal(
        (await auth.getUserIdentity(member.userId))!.mustChangePassword,
        true,
      );
      await teams.updateMemberRole(admin, member.id, "viewer");
      await assert.rejects(
        auth.resetAdminPassword({
          email: identity.email,
          temporaryPassword: "Another recovery passphrase 95731",
        }),
        /admin account/,
      );
    },
  );
}
