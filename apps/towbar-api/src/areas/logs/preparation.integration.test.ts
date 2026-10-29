import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  createServerPreparationSteps,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  logCollectors,
  serverPreparations,
  servers,
  sshHostKeys,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { captureQueuedActor, withActor } from "../auth/actor-context.js";
import {
  admitLogCollection,
  finishLogCollectorOperation,
  getPreparationLogCollectorContext,
  recoverLogCollectorOperations,
} from "./lifecycle.js";

// A dedicated database: recoverLogCollectorOperations() below reads every
// queued collector, including those of suites running alongside this one.
const databaseUrl = process.env.TOWBAR_LOG_PREPARATION_TEST_DATABASE_URL;
const clickhouseUrl = process.env.TOWBAR_TEST_CLICKHOUSE_URL;
void test(
  "server setup installs a scoped collector before preparation completes",
  { skip: !databaseUrl || !clickhouseUrl },
  async (t) => {
    assert(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));
    assert(
      clickhouseUrl &&
        ["localhost", "127.0.0.1"].includes(new URL(clickhouseUrl).hostname),
    );
    process.env.DATABASE_TOWBAR_URL = databaseUrl;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    process.env.TOWBAR_API_BASE_URL = "https://towbar-api.example.test";
    const configuration = JSON.stringify({
      retentionDays: 7,
      clickhouse: {
        endpoint: clickhouseUrl,
        database: "towbar_logs_test",
        username: "logs_test",
        password: "logs_test",
      },
    });
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const { createWorkspacePrivateKey, getWorkspacePrivateKeyValue } =
      await import("../private-keys/service.js");
    const { promoteVerifiedServerPrivateKey } =
      await import("../secrets/store.js");
    const db = getTowbarDatabase();
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      serverId = randomUUID(),
      preparationId = randomUUID();
    const actor = {
      kind: "session" as const,
      workspaceId,
      userId,
      role: "admin" as const,
    };
    const config = normalizeServerConfiguration({
      ip: "192.0.2.220",
      ssh: { username: "deploy" },
    });
    try {
      await db.insert(workspaces).values({
        id: workspaceId,
        slug: workspaceId,
        name: "Automatic collector test",
      });
      await db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Administrator",
      });
      await db
        .insert(workspaceMembers)
        .values({ workspaceId, userId, role: "admin" });
      const key = await createWorkspacePrivateKey({
        algorithm: "ed25519",
        name: "Setup key",
        workspaceId,
      });
      await db.insert(servers).values({
        id: serverId,
        workspaceId,
        canonicalIp: config.ip,
        config,
        configDigest: "setup",
        privateKeyId: key.id,
      });
      const privateKey = await getWorkspacePrivateKeyValue(key.id, workspaceId);
      await db.transaction((tx) =>
        promoteVerifiedServerPrivateKey(
          {
            expectedRevision: null,
            privateKey,
            privateKeyId: key.id,
            serverId,
            workspaceId,
          },
          tx,
        ),
      );
      await db.insert(sshHostKeys).values({
        serverId,
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:setup-test",
        publicKey: key.publicKey!,
        trustedBy: userId,
      });
      const attribution = withActor(actor, () =>
        captureQueuedActor(workspaceId, ["admin"]),
      );
      await db.insert(serverPreparations).values({
        id: preparationId,
        serverId,
        configDigest: "setup",
        status: "running",
        steps: createServerPreparationSteps().map((step) => ({
          ...step,
          status:
            step.id === "installing_caddy"
              ? ("succeeded" as const)
              : ("waiting" as const),
        })),
        requestedByActor: attribution.requestedByActor,
      });
      await t.test(
        "unconfigured storage skips without creating a collector",
        async () => {
          delete process.env.TOWBAR_LOGS_CONFIG_JSON;
          const result = await getPreparationLogCollectorContext(preparationId);
          assert.equal(result.context, null);
          assert.match(result.message, /Skipped: connect ClickHouse/);
          assert.equal(
            (
              await db
                .select()
                .from(logCollectors)
                .where(eq(logCollectors.serverId, serverId))
            ).length,
            0,
          );
        },
      );
      process.env.TOWBAR_LOGS_CONFIG_JSON = configuration;
      await t.test(
        "Member authority cannot grant collector access",
        async () => {
          await db
            .update(serverPreparations)
            .set({
              requestedByActor: {
                ...attribution.requestedByActor,
                grants: ["member"],
              },
            })
            .where(eq(serverPreparations.id, preparationId));
          await assert.rejects(
            getPreparationLogCollectorContext(preparationId),
            /Access changed/,
          );
          await db
            .update(serverPreparations)
            .set({ requestedByActor: attribution.requestedByActor })
            .where(eq(serverPreparations.id, preparationId));
        },
      );
      await t.test(
        "manual admission still requires a prepared server",
        async () => {
          await assert.rejects(
            withActor(actor, () =>
              admitLogCollection({
                serverId,
                workspaceId,
                enabled: true,
                idempotencyKey: randomUUID(),
              }),
            ),
            /Prepare this server/,
          );
        },
      );
      await t.test(
        "automatic installation is repeatable and keeps credentials private",
        async () => {
          const result = await getPreparationLogCollectorContext(preparationId);
          assert(result.context?.token);
          assert.equal(result.context.desiredState, "enabled");
          assert.equal(result.context.login.privateKey, privateKey);
          assert.equal(result.context.trustedHostKeys.length, 1);
          assert.equal(
            (
              await db.select().from(servers).where(eq(servers.id, serverId))
            )[0]!.preparedAt,
            null,
          );
          const retry = await getPreparationLogCollectorContext(preparationId);
          assert.equal(retry.context?.generation, result.context.generation);
          assert.equal(retry.context?.token, result.context.token);
          const [persisted] = await db
            .select()
            .from(logCollectors)
            .where(eq(logCollectors.serverId, serverId));
          assert.equal(persisted!.status, "installing");
          assert.equal(
            await recoverLogCollectorOperations(),
            0,
            "recovery must not race the active setup installation",
          );
          assert.notEqual(persisted!.tokenHash, result.context.token);
          assert(!JSON.stringify(persisted).includes(result.context.token));
          await finishLogCollectorOperation(
            serverId,
            result.context.generation,
            true,
          );
          const completed =
            await getPreparationLogCollectorContext(preparationId);
          assert.equal(completed.context, null);
          assert.match(completed.message, /already installed and enabled/);
        },
      );
      await t.test("setup preserves an explicit disable", async () => {
        const disabled = await withActor(actor, () =>
          admitLogCollection({
            serverId,
            workspaceId,
            enabled: false,
            idempotencyKey: randomUUID(),
          }),
        );
        await finishLogCollectorOperation(serverId, disabled.generation!, true);
        const result = await getPreparationLogCollectorContext(preparationId);
        assert.equal(result.context, null);
        assert.match(result.message, /explicitly disabled/);
        assert.equal(
          (
            await db
              .select()
              .from(logCollectors)
              .where(eq(logCollectors.serverId, serverId))
          )[0]!.desiredState,
          "disabled",
        );
      });
      await t.test(
        "changed server configuration prevents installation",
        async () => {
          await db
            .update(servers)
            .set({ configDigest: "changed" })
            .where(eq(servers.id, serverId));
          await assert.rejects(
            getPreparationLogCollectorContext(preparationId),
            /configuration changed/,
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
