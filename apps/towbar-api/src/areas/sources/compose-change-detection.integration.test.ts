import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  digestValue,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  releases,
  servers,
  sourceEnvironments,
  sourceSyncs,
  sources,
  users,
  workspaces,
} from "@workspace/towbar-database/schema";
import { seedEnvironmentTeam } from "./environment-server-tests.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "Compose config-only sync queues a release with immutable source inputs",
  {
    skip: !url || !process.env.TOWBAR_TEST_TEMPORAL_ADDRESS,
    timeout: 120_000,
  },
  async (t) => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    process.env.DATABASE_TOWBAR_URL = url;
    process.env.TEMPORAL_ADDRESS = process.env.TOWBAR_TEST_TEMPORAL_ADDRESS!;
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
    const { closeTemporalClient } =
      await import("../../infrastructure/temporal.js");
    const { withActor, captureQueuedActor } =
      await import("../auth/actor-context.js");
    const { executeEnvironmentSync } = await import("./environment-sync.js");
    const { scheduleSourceAutomaticDeployments } =
      await import("../apps/automatic-deployments.js");
    const { requestAppDeployment } = await import("../apps/service.js");
    const { commitDeploymentRelease } =
      await import("../deployments/service.js");
    t.after(async () => {
      await closeTemporalClient();
      await closeDatabase();
    });
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      sourceId = randomUUID();
    const actor = {
      kind: "session" as const,
      role: "admin" as const,
      workspaceId,
      userId,
    };
    let commitSha = "a".repeat(40),
      configSha = "a".repeat(40);
    let autoDeploy: boolean | { inputs: string[] } = true;
    const server = normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "deploy" },
    });
    const dependencies = {
      snapshot: () =>
        Promise.resolve({
          commitSha,
          root: "version: 2\nenvironments:\n  production: {}\n",
          configuration: {
            version: 2 as const,
            environments: { production: {} },
          },
          directories: [".towbar/services"],
          files: [
            {
              path: ".towbar/services/stack.compose.yml",
              content: JSON.stringify({
                id: "stack",
                name: "Stack",
                file: "stack/compose.yml",
                autoDeploy,
                environments: { production: { server: server.ip } },
              }),
            },
          ],
        }),
      tree: () =>
        Promise.resolve({
          complete: true,
          entries: [
            {
              path: ".towbar/services/stack.compose.yml",
              mode: "100644",
              type: "blob" as const,
              sha: digestValue(autoDeploy),
            },
            {
              path: "towbar.yml",
              mode: "100644",
              type: "blob" as const,
              sha: "a".repeat(40),
            },
            {
              path: "stack/compose.yml",
              mode: "100644",
              type: "blob" as const,
              sha: "a".repeat(40),
            },
            {
              path: "stack/config/collector.yml",
              mode: "100644",
              type: "blob" as const,
              sha: configSha,
            },
            {
              path: "stack/src/server.js",
              mode: "100644",
              type: "blob" as const,
              sha: "a".repeat(40),
            },
          ],
        }),
    };
    const scheduling = {
      requestDeployment: requestAppDeployment,
      cleanupPreviews: () => Promise.resolve(0),
      reconcilePreviews: () => Promise.resolve({ pullRequestNumbers: [] }),
    };
    try {
      await seedEnvironmentTeam({ workspaceId, userId, sourceId });
      await db.insert(servers).values({
        workspaceId,
        canonicalIp: server.ip,
        config: server,
        configDigest: digestValue(server),
        preparedConfigDigest: digestValue(server),
        preparedAt: new Date(),
      });
      const [environment] = await db
        .insert(sourceEnvironments)
        .values({ sourceId, name: "production", branch: "main" })
        .returning();
      assert(environment);
      async function sync() {
        const [job] = await db
          .insert(sourceSyncs)
          .values({
            sourceId,
            sourceEnvironmentId: environment!.id,
            mappingRevision: environment!.mappingRevision,
            deployAfterSync: true,
            ...withActor(actor, () =>
              captureQueuedActor(workspaceId, ["admin"]),
            ),
          })
          .returning();
        assert(job);
        await executeEnvironmentSync(job.id, workspaceId, dependencies);
        return job.id;
      }
      async function publish(deploymentId: string) {
        await commitDeploymentRelease(deploymentId, {
          containerName: "compose-stack",
          containerNames: ["compose-stack-web"],
          composeServices: ["web"],
          imageDigest: `sha256:${"a".repeat(64)}`,
          imagePlatform: "compose",
          imageTag: `compose:${deploymentId}`,
        });
        await db
          .update(deployments)
          .set({ state: "succeeded", finishedAt: new Date() })
          .where(eq(deployments.id, deploymentId));
      }
      const initialSync = await sync();
      const initial = await scheduleSourceAutomaticDeployments(
        initialSync,
        scheduling,
      );
      assert.equal(initial.deploymentIds.length, 1);
      await publish(initial.deploymentIds[0]!);
      commitSha = "b".repeat(40);
      configSha = "b".repeat(40);
      const configSync = await sync();
      const changed = await scheduleSourceAutomaticDeployments(
        configSync,
        scheduling,
      );
      assert.equal(
        changed.deploymentIds.length,
        1,
        "a config-only edit must queue a deployment",
      );
      const queuedId = changed.deploymentIds[0]!;
      const [queued] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, queuedId));
      assert(queued && queued.appSnapshot.kind === "compose");
      assert.deepEqual(queued.appSnapshot.deploymentInputs, ["**"]);
      assert.equal(queued.commitSha, commitSha);
      autoDeploy = { inputs: ["stack/src/**"] };
      commitSha = "c".repeat(40);
      await sync();
      await publish(queuedId);
      const [release] = await db
        .select()
        .from(releases)
        .where(eq(releases.deploymentId, queuedId));
      assert.equal(release?.sourceInputDigest, queued.sourceInputDigest);
      assert.equal(release?.deploymentDigest, queued.deploymentDigest);
      assert.equal(release?.commitSha, queued.commitSha);
      autoDeploy = true;
      const sameTreeSync = await sync();
      assert.deepEqual(
        (await scheduleSourceAutomaticDeployments(sameTreeSync, scheduling))
          .deploymentIds,
        [],
        "a current release must clear the pending change even at a newer identical-tree commit",
      );
      const [app] = await db
        .select()
        .from(apps)
        .where(eq(apps.sourceId, sourceId));
      assert.equal(app?.deploymentDigest, release?.deploymentDigest);
    } finally {
      await db
        .delete(releases)
        .where(
          inArray(
            releases.deploymentId,
            db
              .select({ id: deployments.id })
              .from(deployments)
              .where(eq(deployments.sourceId, sourceId)),
          ),
        );
      await db.delete(deployments).where(eq(deployments.sourceId, sourceId));
      await db.delete(apps).where(eq(apps.sourceId, sourceId));
      await db.delete(sources).where(eq(sources.id, sourceId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
);
