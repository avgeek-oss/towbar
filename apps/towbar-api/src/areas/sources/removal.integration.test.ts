import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  servers,
  sourceEnvironments,
  sourceSyncs,
  sources,
  workspaces,
} from "@workspace/towbar-database/schema";
import { seedEnvironmentTeam } from "./environment-server-tests.js";
import { testInstanceLinks } from "./instance-test-helper.js";
import { withActor } from "../auth/actor-context.js";
import { connectRepositorySource } from "./connection.js";
import { requestEnvironmentSync, sourceRepository } from "./environments.js";
import { deleteSource, getSource, listSources } from "./service.js";
import {
  mutateSecret,
  readSecretValues,
  requireSecretOwner,
} from "../secrets/store.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "repository removal retains history and reconnects the same identity",
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
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      sourceId = randomUUID(),
      userId = randomUUID(),
      appId = randomUUID();
    const actor = {
      kind: "session" as const,
      workspaceId,
      userId,
      role: "admin" as const,
    };
    try {
      await seedEnvironmentTeam({ workspaceId, sourceId, userId });
      const config = normalizeServerConfiguration({
        ip: "192.0.2.201",
        ssh: { username: "deploy" },
      });
      const [server] = await db
        .insert(servers)
        .values({
          workspaceId,
          canonicalIp: config.ip,
          config,
          configDigest: "test",
        })
        .returning();
      assert(server);
      const links = await testInstanceLinks(sourceId, "history");
      const [environment] = await db
        .select()
        .from(sourceEnvironments)
        .where(eq(sourceEnvironments.id, links.sourceEnvironmentId));
      const [source] = await db
        .select()
        .from(sources)
        .where(eq(sources.id, sourceId));
      assert(environment && source?.integrationInstallationId);
      const [staging] = await db
        .insert(sourceEnvironments)
        .values({
          sourceId,
          name: "staging",
          branch: "develop",
          disconnectedAt: new Date(),
        })
        .returning();
      assert(staging);
      const manifest = normalizeDeploymentManifest({
        version: 2,
        apps: [
          {
            id: "history",
            name: "History",
            server: config.ip,
            dockerfile: "Dockerfile",
            container: { port: 3000 },
          },
        ],
      });
      const [app] = await db
        .insert(apps)
        .values({
          ...links,
          id: appId,
          sourceId,
          workspaceId,
          serverId: server.id,
          manifestId: "history",
          name: "History",
          config: manifest.apps[0]!,
          configDigest: "test",
          sourceRevision: "a".repeat(40),
        })
        .returning();
      assert(app);
      const id = randomUUID();
      await db.insert(deployments).values({
        id,
        workspaceId,
        sourceId,
        appId,
        serverId: server.id,
        idempotencyKey: id,
        temporalWorkflowId: id,
        appSnapshot: app.config,
        serverSnapshot: config,
        commitSha: "a".repeat(40),
        manifestDigest: "a".repeat(64),
        requiredSecrets: app.requiredSecrets,
        targetEnvironment: {
          id: environment.id,
          name: environment.name,
          branch: environment.branch,
          mappingRevision: environment.mappingRevision,
        },
      });
      await assert.rejects(
        deleteSource(sourceId, workspaceId),
        /active Source operations/,
      );
      await db
        .update(deployments)
        .set({ state: "succeeded" })
        .where(eq(deployments.id, id));
      const secretSlot = {
        type: "repository" as const,
        id: sourceId,
        workspaceId,
        environment: "production",
        stage: "deployment",
      };
      await mutateSecret(
        secretSlot,
        {
          expectedRevision: null,
          set: { TOKEN: "fixture-retained-value" },
          delete: [],
        },
        userId,
      );
      const secret = await readSecretValues(secretSlot);
      await assert.rejects(
        deleteSource(sourceId, randomUUID()),
        /Source was not found/,
      );
      const { previewRepositoryRemoval } = await import("./withdrawal.js");
      const review = await previewRepositoryRemoval(sourceId, workspaceId);
      assert.equal(review.summary.retirements, 1);
      await withActor(actor, () =>
        deleteSource(sourceId, workspaceId, review.revision),
      );
      const [retained] = await db.select().from(apps).where(eq(apps.id, appId));
      assert.equal(retained?.manifestState, "retired");
      assert.equal(retained?.archivedAt, null);
      const [disconnected] = await db
        .select()
        .from(sourceEnvironments)
        .where(eq(sourceEnvironments.id, environment.id));
      assert(disconnected?.disconnectedAt);
      const [archived] = await db
        .select()
        .from(sources)
        .where(eq(sources.id, sourceId));
      assert.equal(archived?.status, "archived");
      assert(archived.archivedAt);
      assert.equal((await listSources(workspaceId)).length, 0);
      await assert.rejects(
        getSource(sourceId, workspaceId),
        /Source was not found/,
      );
      await assert.rejects(
        sourceRepository(sourceId, workspaceId),
        /Source was not found/,
      );
      await assert.rejects(
        requireSecretOwner(secretSlot),
        /repository was not found/,
      );
      assert.equal(
        (await db.select().from(deployments).where(eq(deployments.id, id)))
          .length,
        1,
      );
      assert.equal(
        (await db.select().from(apps).where(eq(apps.id, appId))).length,
        1,
      );
      assert.deepEqual(await readSecretValues(secretSlot), secret);
      await deleteSource(sourceId, workspaceId);
      let enqueued = 0;
      const result = await withActor(actor, () =>
        connectRepositorySource(
          {
            provider: "github",
            githubInstallationId: source.integrationInstallationId!,
            workspaceId,
            repositoryOwner: source.repositoryOwner,
            repositoryName: source.repositoryName,
            actorUserId: userId,
            environments: [{ environment: "production", branch: "main" }],
          },
          {
            repository: () =>
              Promise.resolve({
                id: "123456",
                owner: source.repositoryOwner,
                name: source.repositoryName,
              }),
            snapshot: () =>
              Promise.resolve({
                commitSha: "a".repeat(40),
                root: "version: 2\nenvironments:\n  production: {}\n",
                configuration: {
                  version: 2 as const,
                  environments: { production: {} },
                },
                directories: [],
                files: [],
              }),
            requestSync: (input) =>
              requestEnvironmentSync(input, () => {
                enqueued++;
                return Promise.resolve({ workflowId: randomUUID() });
              }),
          },
        ),
      );
      assert.equal(result.source.id, sourceId);
      assert.equal(result.source.status, "active");
      assert.equal(result.environments[0]?.id, environment.id);
      assert.equal(result.environments[0]?.disconnectedAt, null);
      assert.notEqual(
        result.environments[0]?.mappingRevision,
        environment.mappingRevision,
      );
      assert.equal((await listSources(workspaceId)).length, 1);
      assert.equal(enqueued, 1);
      assert.deepEqual(await readSecretValues(secretSlot), secret);
      assert.equal(
        (await db.select().from(deployments).where(eq(deployments.id, id)))
          .length,
        1,
      );
      assert.equal(
        (
          await db
            .select()
            .from(sourceEnvironments)
            .where(eq(sourceEnvironments.sourceId, sourceId))
        ).length,
        2,
      );
      assert(
        (
          await db
            .select()
            .from(sourceEnvironments)
            .where(eq(sourceEnvironments.id, staging.id))
        )[0]?.disconnectedAt,
      );
      assert.equal(
        (
          await db
            .select()
            .from(sourceSyncs)
            .where(eq(sourceSyncs.sourceId, sourceId))
        ).length,
        1,
      );
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await closeDatabase();
    }
  },
);
