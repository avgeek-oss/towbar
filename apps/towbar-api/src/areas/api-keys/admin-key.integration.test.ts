import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { actorAllows } from "@workspace/towbar-access";
import {
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "full admin personal keys permanently narrow on demotion while team keys remain independent",
  { skip: !url },
  async () => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    process.env.TOWBAR_PASSWORD_BREACH_CHECK = "false";
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl: url,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const keys = await import("./service.js");
    const teams = await import("../team/service.js");
    const { withActor, captureQueuedActor, authorizeQueuedEffect } =
      await import("../auth/actor-context.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID();
    const admin = {
      id: randomUUID(),
      email: `${randomUUID()}@example.test`,
      name: "Admin",
      workspaceId,
      workspaceRole: "admin" as const,
    };
    const owner = {
      ...admin,
      id: randomUUID(),
      email: `${randomUUID()}@example.test`,
      name: "Owner",
    };
    try {
      await db
        .insert(workspaces)
        .values({ id: workspaceId, slug: workspaceId, name: "Key policy" });
      await db.insert(users).values(
        [admin, owner].map((user) => ({
          id: user.id,
          email: user.email,
          displayName: user.name,
        })),
      );
      const members = await db
        .insert(workspaceMembers)
        .values(
          [admin, owner].map((user) => ({
            workspaceId,
            userId: user.id,
            role: "admin" as const,
          })),
        )
        .returning();
      const ownerMembership = members.find(
        (member) => member.userId === owner.id,
      )!;
      const team = await keys.createApiKey(owner, {
        name: "Independent team",
        scope: "team",
        access: "edit",
        includeAdmin: true,
      });
      assert(team.token);
      const teamToken = team.token;
      const full = await keys.createApiKey(owner, {
        name: "Full personal",
        access: "edit",
        includeAdmin: true,
      });
      assert(full.token);
      assert.deepEqual(full.key.grants, ["viewer", "member", "admin"]);
      const principal = (await keys.findApiKey(full.token))!;
      assert(actorAllows(principal.actor, ["admin"]));
      const reference = withActor(principal.actor, () =>
        captureQueuedActor(admin.workspaceId, ["admin"]),
      ).requestedByActor;
      const admitted = await authorizeQueuedEffect(
        reference,
        admin.workspaceId,
        ["admin"],
      );
      assert(actorAllows(admitted, ["admin"]));
      const narrowed = await authorizeQueuedEffect(
        { ...reference, grants: ["viewer"] },
        admin.workspaceId,
        ["viewer"],
      );
      assert(!actorAllows(narrowed, ["admin"]));
      assert(!actorAllows(narrowed, ["admin"]));
      await teams.updateMemberRole(admin, ownerMembership.id, "member");
      const demoted = (await keys.findApiKey(full.token))!;
      assert.equal(demoted.actor.kind, "personal-key");
      if (demoted.actor.kind === "personal-key") {
        assert.equal(demoted.actor.policy.includeAdmin, false);
      }
      assert(!actorAllows(demoted.actor, ["admin"]));
      assert(actorAllows(demoted.actor, ["member"]));
      await assert.rejects(
        authorizeQueuedEffect(reference, admin.workspaceId, ["admin"]),
      );
      await teams.updateMemberRole(admin, ownerMembership.id, "admin");
      assert(
        !actorAllows((await keys.findApiKey(full.token))!.actor, ["admin"]),
      );
      await assert.rejects(
        authorizeQueuedEffect(reference, admin.workspaceId, ["admin"]),
      );
      assert(actorAllows((await keys.findApiKey(teamToken))!.actor, ["admin"]));

      const replacement = await keys.createApiKey(owner, {
        name: "Replacement full",
        access: "edit",
        includeAdmin: true,
      });
      assert(replacement.token);
      assert(
        actorAllows((await keys.findApiKey(replacement.token))!.actor, [
          "admin",
        ]),
      );
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, owner.id));
      assert.equal(await keys.findApiKey(full.token), null);
      assert.equal(await keys.findApiKey(replacement.token), null);
      assert(await keys.findApiKey(teamToken));
      await db
        .update(users)
        .set({ disabledAt: null })
        .where(eq(users.id, owner.id));
      await teams.removeTeamMember(admin, ownerMembership.id);
      assert.equal(await keys.findApiKey(full.token), null);
      assert.equal(await keys.findApiKey(replacement.token), null);
      assert(actorAllows((await keys.findApiKey(teamToken))!.actor, ["admin"]));
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, owner.id));
      await db.delete(users).where(eq(users.id, admin.id));
      await closeDatabase();
    }
  },
);
