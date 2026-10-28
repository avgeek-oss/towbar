import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  apps,
  sourceEnvironments,
  sourceSyncs,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { environmentSyncDependencies } from "./environment-sync-fixture.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "Members cannot change branch mappings or sync repository inventory",
  { skip: !url },
  async () => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl: url,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { withActor } = await import("../auth/actor-context.js");
    const { connectRepositorySource } = await import("./connection.js");
    const {
      connectSourceEnvironment,
      requestEnvironmentSync,
      updateEnvironmentBranch,
    } = await import("./environments.js");
    const { executeEnvironmentSync } = await import("./environment-sync.js");
    const { seedEnvironmentTeam } =
      await import("./environment-server-tests.js");
    const database = getTowbarDatabase();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      sourceId = randomUUID();
    const admin = {
      kind: "session" as const,
      workspaceId,
      userId,
      role: "admin" as const,
    };
    const member = { ...admin, role: "member" as const };
    try {
      await seedEnvironmentTeam({ workspaceId, userId, sourceId });
      const [environment] = await database
        .insert(sourceEnvironments)
        .values({
          sourceId,
          name: "production",
          branch: "main",
          autoDeployPaused: false,
        })
        .returning();
      assert(environment);
      const input = {
        sourceId,
        environmentId: environment.id,
        workspaceId,
        requestedBy: userId,
        deployAfterSync: false,
      };
      let enqueued = 0;
      const enqueue = () => {
        enqueued++;
        return Promise.resolve({ workflowId: "role-change-proof" });
      };
      const job = await withActor(admin, () =>
        requestEnvironmentSync(input, enqueue),
      );
      await database
        .update(workspaceMembers)
        .set({ role: "member" })
        .where(eq(workspaceMembers.userId, userId));

      await assert.rejects(
        withActor(member, () => requestEnvironmentSync(input, enqueue)),
        /permitted/,
      );
      await assert.rejects(
        withActor(member, () =>
          updateEnvironmentBranch({
            sourceId,
            environmentId: environment.id,
            workspaceId,
            branch: "develop",
            expectedRevision: environment.mappingRevision,
          }),
        ),
        /permitted/,
      );
      await assert.rejects(
        withActor(member, () =>
          connectSourceEnvironment({
            sourceId,
            workspaceId,
            environment: "staging",
            branch: "develop",
          }),
        ),
        /permitted/,
      );
      await assert.rejects(
        withActor(member, () =>
          connectRepositorySource({
            provider: "github",
            githubInstallationId: randomUUID(),
            repositoryOwner: "test",
            repositoryName: "another",
            environments: [{ environment: "production", branch: "main" }],
            workspaceId,
            actorUserId: userId,
          }),
        ),
        /permitted/,
      );
      assert.equal(enqueued, 1);

      const dependencies = environmentSyncDependencies(() => ({
        root: "version: 2\nenvironments:\n  production: {}\n",
        snapshotCommit: "a".repeat(40),
        keys: [],
        broken: false,
      }));
      await assert.rejects(
        executeEnvironmentSync(job.id, workspaceId, dependencies),
        /access|permission|role/i,
      );
      assert.equal(
        (await database.select().from(apps).where(eq(apps.sourceId, sourceId)))
          .length,
        0,
      );
      assert.equal(
        (
          await database
            .select()
            .from(sourceSyncs)
            .where(eq(sourceSyncs.sourceId, sourceId))
        ).length,
        1,
      );
      const [mapped] = await database
        .select()
        .from(sourceEnvironments)
        .where(eq(sourceEnvironments.id, environment.id));
      assert.equal(mapped?.branch, "main");
      assert.equal(mapped?.autoDeployPaused, false);
    } finally {
      await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await database.delete(users).where(eq(users.id, userId));
      await closeDatabase();
    }
  },
);
