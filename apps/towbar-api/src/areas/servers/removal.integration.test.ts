import { testInstanceLinks } from "../sources/instance-test-helper.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  integrationInstallations,
  managedSecrets,
  monitoringAgents,
  serverChecks,
  serverDeployableOwnership,
  serverPreparations,
  servers,
  sources,
  sshHostKeys,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import type { TowbarHonoEnvironment } from "../../http/types.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "server removal and ownership retained after source deletion",
  { skip: !url },
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
    const { removeServer: removeServerService, createServer } =
      await import("./lifecycle.js");
    const { trustServerHostKey } = await import("./trusted-host-keys.js");
    const { deleteSource } = await import("../sources/service.js");
    const { getCleanupExpected } =
      await import("../resource-operations/queries.js");
    const { serverRoutes } = await import("../../routes/v1/core/servers.js");
    const { mutateSecret } = await import("../secrets/store.js");
    const { HttpError } = await import("../../http/errors.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      sourceId = randomUUID(),
      appId = randomUUID();
    const config = normalizeServerConfiguration({
      ip: "192.0.2.111",
      ssh: { username: "deploy" },
    });
    const { withActor } = await import("../auth/actor-context.js");
    const removeServer = (input: Parameters<typeof removeServerService>[0]) =>
      withActor({ kind: "session", workspaceId, userId, role: "admin" }, () =>
        removeServerService(input),
      );
    let serverId = "";
    try {
      await db
        .insert(workspaces)
        .values({ id: workspaceId, slug: workspaceId, name: "Removal test" });
      await db.insert(users).values({
        id: userId,
        email: `${userId}@example.com`,
        displayName: "Test",
      });
      await db
        .insert(workspaceMembers)
        .values({ workspaceId, userId, role: "admin" });
      const server = await createServer({ config, workspaceId });
      serverId = server.id;
      const removal = { serverId, workspaceId, requestedBy: userId };
      const [installation] = await db
        .insert(integrationInstallations)
        .values({
          provider: "github",
          workspaceId,
          externalId: randomUUID(),
          principalName: "example",
          principalType: "Organization",
        })
        .returning();
      await db.insert(sources).values({
        id: sourceId,
        workspaceId,
        integrationInstallationId: installation!.id,
        repositoryOwner: "example",
        repositoryName: "platform",
      });
      const manifest = normalizeDeploymentManifest({
        version: 2,
        apps: [
          {
            id: "app",
            name: "App",
            server: config.ip,
            dockerfile: "Dockerfile",
            context: ".",
            container: { port: 3000 },
            health: { path: "/health" },
          },
        ],
      });
      const values = {
        ...(await testInstanceLinks(sourceId, "app")),
        id: appId,
        workspaceId,
        sourceId,
        serverId,
        manifestId: "app",
        name: "App",
        config: manifest.apps[0]!,
        configDigest: "test",
        sourceRevision: "1234567",
      };
      await db.insert(apps).values(values);
      let role: "member" | "admin" = "member";
      const api = new Hono<TowbarHonoEnvironment>();
      api.use("*", async (c, next) => {
        c.set("user", {
          id: userId,
          workspaceId,
          workspaceRole: role,
          email: "test@example.com",
          name: "Test",
        });
        c.set("actor", { kind: "session", workspaceId, userId, role });
        await next();
      });
      api.onError((error, c) =>
        c.json(
          { error: error.message },
          error instanceof HttpError ? error.status : 500,
        ),
      );
      api.route("/servers", serverRoutes);
      await t.test("owner and workspace boundaries", async () => {
        assert.equal(
          (await api.request(`/servers/${serverId}`, { method: "DELETE" }))
            .status,
          403,
        );
        await assert.rejects(
          removeServer({ ...removal, workspaceId: randomUUID() }),
          (error: unknown) =>
            error instanceof HttpError && error.status === 404,
        );
      });
      role = "admin";
      const canRemove = async () => {
        const response = await api.request(`/servers/${serverId}`);
        assert.equal(response.status, 200);
        return ((await response.json()) as { canRemoveServer: boolean })
          .canRemoveServer;
      };
      await t.test(
        "source-backed apps and archived inventory allow removal",
        async () => {
          for (const archivedAt of [null, new Date()]) {
            await db.update(apps).set({ archivedAt }).where(eq(apps.id, appId));
            assert.equal(await canRemove(), true);
          }
        },
      );
      const resourceId = randomUUID();
      await t.test(
        "a resource without any apps also allows removal",
        async () => {
          await db.delete(apps).where(eq(apps.id, appId));
          const resource = normalizeDeploymentManifest({
            version: 2,
            resources: [
              { id: "db", name: "DB", type: "postgres", server: config.ip },
            ],
          }).resources![0]!;
          await db.insert(apps).values({
            ...values,
            ...(await testInstanceLinks(sourceId, "db", "resource")),
            id: resourceId,
            kind: "postgres",
            config: resource,
            manifestId: "db",
            name: "DB",
          });
          for (const archivedAt of [null, new Date()]) {
            await db
              .update(apps)
              .set({ archivedAt })
              .where(eq(apps.id, resourceId));
            assert.equal(await canRemove(), true);
          }
        },
      );
      await t.test(
        "removal archives assigned inventory and the same server can be restored",
        async () => {
          await db
            .update(apps)
            .set({ archivedAt: null })
            .where(eq(apps.id, resourceId));
          assert.deepEqual(await removeServer(removal), { pending: false });
          assert(
            (await db.select().from(servers).where(eq(servers.id, serverId)))[0]
              ?.archivedAt,
          );
          assert(
            (await db.select().from(apps).where(eq(apps.id, resourceId)))[0]
              ?.archivedAt,
          );
          const restored = await createServer({ config, workspaceId });
          assert.equal(restored.id, serverId);
          assert.equal(restored.setupStatus, "pending");
          assert(
            (
              await db.select().from(servers).where(eq(servers.id, serverId))
            )[0]!.lastRemovedAt,
          );

          await db
            .update(apps)
            .set({ archivedAt: null })
            .where(eq(apps.id, resourceId));
        },
      );
      await t.test(
        "repository withdrawal preserves retained workloads and their cleanup ownership",
        async () => {
          await deleteSource(sourceId, workspaceId);
          const [connection] = await db
            .select()
            .from(sources)
            .where(eq(sources.id, sourceId));
          assert.equal(connection?.status, "archived");
          const [retained] = await db
            .select()
            .from(apps)
            .where(eq(apps.id, resourceId));
          assert.equal(retained?.manifestState, "retired");
          assert.equal(retained?.archivedAt, null);
          assert.equal(
            (await db.select().from(apps).where(eq(apps.id, resourceId)))
              .length,
            1,
          );
          const expected = await getCleanupExpected(serverId);
          assert.deepEqual(expected.deployableIds, [resourceId]);
          assert.deepEqual(
            expected.ownedDeployableIds.sort(),
            [appId, resourceId].sort(),
          );
          assert.equal(await canRemove(), true);
        },
      );
      await t.test(
        "queued checks and preparations prevent removal",
        async () => {
          const [check] = await db
            .insert(serverChecks)
            .values({ serverId })
            .returning();
          await assert.rejects(
            removeServer(removal),
            /active server operations/,
          );
          await db
            .update(serverChecks)
            .set({ status: "succeeded" })
            .where(eq(serverChecks.id, check!.id));
          const [preparation] = await db
            .insert(serverPreparations)
            .values({ serverId, configDigest: "test", steps: [] })
            .returning();
          await assert.rejects(
            removeServer(removal),
            /active server operations/,
          );
          await db
            .update(serverPreparations)
            .set({ status: "succeeded" })
            .where(eq(serverPreparations.id, preparation!.id));
        },
      );
      await db.insert(sshHostKeys).values({
        serverId,
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:test",
        publicKey: "test",
        trustedBy: userId,
      });
      await t.test(
        "host identity replacement revokes prior trust",
        async () => {
          await trustServerHostKey({
            algorithm: "ssh-ed25519",
            fingerprint: "SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA",
            publicKey:
              "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f",
            replaceExisting: true,
            serverId,
            trustedBy: userId,
            workspaceId,
          });
          const keys = await db
            .select()
            .from(sshHostKeys)
            .where(eq(sshHostKeys.serverId, serverId));
          assert.equal(keys.filter((key) => !key.revokedAt).length, 1);
          assert.equal(
            keys.find((key) => !key.revokedAt)?.fingerprint,
            "SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA",
          );
          assert(
            keys.find((key) => key.fingerprint === "SHA256:test")?.revokedAt,
          );
        },
      );
      await mutateSecret(
        {
          type: "server",
          id: serverId,
          workspaceId,
          environment: "production",
          stage: "credentials",
        },
        {
          expectedRevision: null,
          set: { privateKey: "test-private-key" },
          delete: [],
        },
        userId,
      );
      await t.test(
        "removal forgets credentials and trust, preserves history, and rejects late work",
        async () => {
          await removeServer(removal);
          assert(
            (
              await db.select().from(servers).where(eq(servers.id, serverId))
            )[0]!.archivedAt,
          );
          assert.equal(
            (
              await db
                .select()
                .from(managedSecrets)
                .where(eq(managedSecrets.serverId, serverId))
            ).length,
            0,
          );
          assert(
            (
              await db
                .select()
                .from(sshHostKeys)
                .where(eq(sshHostKeys.serverId, serverId))
            )[0]!.revokedAt,
          );
          assert(
            (
              await db
                .select()
                .from(serverChecks)
                .where(eq(serverChecks.serverId, serverId))
            ).length > 0,
          );
          assert(
            (
              await db
                .select()
                .from(serverDeployableOwnership)
                .where(eq(serverDeployableOwnership.serverId, serverId))
            ).length > 0,
          );
          await assert.rejects(db.insert(serverChecks).values({ serverId }));
          await assert.rejects(
            db
              .insert(serverPreparations)
              .values({ serverId, configDigest: "test", steps: [] }),
          );
          const revived = await createServer({
            config,
            workspaceId,
          });
          assert.equal(revived.id, serverId);
          assert.equal(revived.setupStatus, "pending");
        },
      );
      await t.test(
        "monitoring uninstall must complete before SSH credentials are forgotten",
        async () => {
          const { finishMonitoringOperation } =
            await import("../monitoring/lifecycle.js");
          await mutateSecret(
            {
              type: "server",
              id: serverId,
              workspaceId,
              environment: "production",
              stage: "credentials",
            },
            {
              expectedRevision: null,
              set: { privateKey: "test-private-key" },
              delete: [],
            },
            userId,
          );
          await db.insert(monitoringAgents).values({
            serverId,
            status: "online",
            desiredState: "enabled",
            tokenHash: "a".repeat(64),
          });
          assert.deepEqual(await removeServer(removal), { pending: true });
          let [agent] = await db
            .select()
            .from(monitoringAgents)
            .where(eq(monitoringAgents.serverId, serverId));
          assert.equal(agent?.tokenHash, null);
          assert.equal(agent?.removalRequestedBy, userId);
          assert.equal(
            (
              await db
                .select()
                .from(managedSecrets)
                .where(eq(managedSecrets.serverId, serverId))
            ).length,
            1,
          );
          await assert.rejects(removeServer(removal), /monitoring operation/);
          await finishMonitoringOperation(serverId, agent!.generation, false);
          assert.equal(
            (
              await db
                .select()
                .from(managedSecrets)
                .where(eq(managedSecrets.serverId, serverId))
            ).length,
            1,
          );
          assert.deepEqual(await removeServer(removal), { pending: true });
          [agent] = await db
            .select()
            .from(monitoringAgents)
            .where(eq(monitoringAgents.serverId, serverId));
          await finishMonitoringOperation(serverId, agent!.generation, true);
          assert(
            (await db.select().from(servers).where(eq(servers.id, serverId)))[0]
              ?.archivedAt,
          );
          assert.equal(
            (
              await db
                .select()
                .from(managedSecrets)
                .where(eq(managedSecrets.serverId, serverId))
            ).length,
            0,
          );
        },
      );
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, userId));
      await closeDatabase();
    }
  },
);
