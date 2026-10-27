import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  sourceEnvironments,
  sourceSyncs,
} from "@workspace/towbar-database/schema";
import { seedEnvironmentTeam } from "../sources/environment-server-tests.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "syncs without deployment still reconcile previews for open pull requests",
  { skip: !url, timeout: 60_000 },
  async (t) => {
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
    const { scheduleSourceAutomaticDeployments } =
      await import("./automatic-deployments.js");
    t.after(closeDatabase);
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      sourceId = randomUUID();
    await seedEnvironmentTeam({ workspaceId, userId, sourceId });
    const [environment] = await db
      .insert(sourceEnvironments)
      .values({ sourceId, name: "production", branch: "main" })
      .returning();
    assert(environment);
    const calls: string[] = [];
    const scheduling = {
      requestDeployment: () => {
        throw new Error("Syncs without deployment must not deploy");
      },
      cleanupPreviews: (source: string, environmentId: string) => {
        calls.push(`cleanup:${source}:${environmentId}`);
        return Promise.resolve(0);
      },
      reconcilePreviews: (source: string) => {
        calls.push(`reconcile:${source}`);
        return Promise.resolve({ pullRequestNumbers: [] });
      },
    };
    const sync = async (status: "succeeded" | "failed") => {
      const [job] = await db
        .insert(sourceSyncs)
        .values({
          sourceId,
          sourceEnvironmentId: environment.id,
          mappingRevision: environment.mappingRevision,
          deployAfterSync: false,
          status,
          commitSha: "a".repeat(40),
        })
        .returning();
      assert(job);
      return job.id;
    };

    const manual = await scheduleSourceAutomaticDeployments(
      await sync("succeeded"),
      scheduling,
    );
    assert.deepEqual(manual.deploymentIds, []);
    assert.deepEqual(calls, [
      `cleanup:${sourceId}:${environment.id}`,
      `reconcile:${sourceId}`,
    ]);

    calls.length = 0;
    await scheduleSourceAutomaticDeployments(await sync("failed"), scheduling);
    assert.deepEqual(calls, [], "a failed sync must not touch previews");
  },
);
