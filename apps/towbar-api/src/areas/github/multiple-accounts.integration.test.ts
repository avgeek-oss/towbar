import assert from "node:assert/strict";
import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  integrationInstallations,
  integrationWebhookDeliveries,
  sourceEnvironments,
  sourceSyncs,
  sources,
  workspaces,
} from "@workspace/towbar-database/schema";
import {
  disconnectGitHub,
  getGitHubConnection,
  getGitHubConnectionStatuses,
  getGitHubConnections,
  getGitHubInstallationForSource,
  getWorkspaceGitHubRepositories,
  saveGitHubInstallation,
} from "./service.js";
import { HttpError } from "../../http/errors.js";
import { changeSourceGitHubConnection } from "../sources/github-connection.js";
import {
  processGitHubPush,
  processGitHubWebhook,
  resolveWebhookInstallation,
} from "./webhooks.js";
import { createInstallationToken } from "./client.js";
import { withActor } from "../auth/actor-context.js";

const url = process.env.TOWBAR_TEST_DATABASE_URL;
void test(
  "multiple GitHub accounts preserve source identity and isolate access, moves, and webhooks",
  { skip: !url },
  async () => {
    assert(url && new URL(url).pathname.endsWith("_test"));
    const admin = postgres(url, { max: 1, onnotice() {} });
    const databaseName = `github_accounts_${randomUUID().replaceAll("-", "")}_test`;
    const databaseUrl = new URL(url);
    databaseUrl.pathname = `/${databaseName}`;
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      process.env.DATABASE_TOWBAR_URL = databaseUrl.href;
      process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
      process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
      const { runTowbarMigrations } =
        await import("@workspace/towbar-database/migrate");
      await runTowbarMigrations({
        databaseUrl: databaseUrl.href,
        logger: { info() {}, error() {} },
      });
      const database = getTowbarDatabase();
      const workspaceId = randomUUID(),
        otherWorkspaceId = randomUUID(),
        sourceId = randomUUID();
      const firstId = randomInt(1, 1_000_000_000),
        secondId = firstId + 1,
        reinstalledId = firstId + 2;
      const accountId = firstId + 3;
      const installation = (
        id: number,
        principalId: number,
        login: string,
      ) => ({
        id,
        account: { id: principalId, login, type: "Organization" },
        permissions: {
          contents: "read",
          deployments: "write",
          pull_requests: "write",
        },
        suspended_at: null,
      });
      await database.insert(workspaces).values({
        id: workspaceId,
        slug: workspaceId,
        name: "GitHub accounts test",
      });
      const autoId = firstId + 10;
      const autoInput = {
        installationId: String(autoId),
        eventName: "installation",
        payload: { action: "created", installation: { id: autoId } },
        signed: true,
      };
      const lookup = () =>
        Promise.resolve(installation(autoId, accountId + 20, "auto-account"));
      await assert.rejects(
        resolveWebhookInstallation({ ...autoInput, signed: false }, lookup),
        /webhook secret/,
      );
      const automatic = await resolveWebhookInstallation(autoInput, lookup);
      assert(automatic);
      assert.equal(
        (await resolveWebhookInstallation(autoInput, lookup))?.id,
        automatic.id,
      );
      process.env.TOWBAR_GITHUB_ENABLED = "true";
      process.env.TOWBAR_GITHUB_APP_ID = "1234";
      process.env.TOWBAR_GITHUB_APP_SLUG = "towbar";
      process.env.TOWBAR_GITHUB_PRIVATE_KEY_BASE64 = Buffer.from(
        generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
      ).toString("base64");
      process.env.TOWBAR_GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
      const deletedBody = JSON.stringify({
        action: "deleted",
        installation: { id: autoId },
      });
      const webhook = {
        body: deletedBody,
        deliveryId: randomUUID(),
        eventName: "installation",
        targetId: "1234",
        signature: `sha256=${createHmac("sha256", "test-webhook-secret").update(deletedBody).digest("hex")}`,
      };
      await assert.rejects(
        processGitHubWebhook({ ...webhook, signature: "invalid" }),
        /signature/,
      );
      await processGitHubWebhook(webhook);
      assert(
        (await getGitHubConnection(workspaceId, automatic.id))?.suspendedAt,
      );
      assert.equal((await processGitHubWebhook(webhook)).duplicate, true);
      await resolveWebhookInstallation(
        {
          ...autoInput,
          payload: { action: "unsuspend", installation: { id: autoId } },
        },
        lookup,
      );
      assert.equal(
        (await getGitHubConnection(workspaceId, automatic.id))?.suspendedAt,
        null,
      );
      await database.insert(workspaces).values({
        id: otherWorkspaceId,
        slug: otherWorkspaceId,
        name: "Other workspace",
      });
      assert.equal(
        await resolveWebhookInstallation(
          { ...autoInput, installationId: String(autoId + 1) },
          lookup,
        ),
        null,
      );
      await database
        .delete(integrationWebhookDeliveries)
        .where(eq(integrationWebhookDeliveries.installationId, automatic.id));
      await database
        .delete(integrationInstallations)
        .where(eq(integrationInstallations.id, automatic.id));
      // Legacy records have no GitHub account/repository IDs until access is verified.
      const [legacy] = await database
        .insert(integrationInstallations)
        .values({
          workspaceId,
          provider: "github",
          externalId: String(firstId),
          principalName: "avgeek-inc",
          principalType: "Organization",
        })
        .returning();
      assert(legacy);
      await database.insert(sources).values({
        id: sourceId,
        workspaceId,
        integrationInstallationId: legacy.id,
        repositoryOwner: "avgeek-inc",
        repositoryName: "towbar",
      });
      const renamed = await saveGitHubInstallation(
        workspaceId,
        installation(firstId, accountId, "avgeek-labs"),
      );
      assert.equal(renamed?.id, legacy.id);
      const second = await saveGitHubInstallation(
        workspaceId,
        installation(secondId, accountId + 1, "avgeek-oss"),
      );
      assert(second);
      assert.notEqual(second.id, legacy.id);
      assert.equal((await getGitHubConnections(workspaceId)).length, 2);
      await assert.rejects(
        getGitHubConnection(workspaceId),
        /Choose a GitHub account/,
      );
      await assert.rejects(
        getGitHubConnection(otherWorkspaceId, legacy.id),
        /GitHub connection/,
      );
      await assert.rejects(
        saveGitHubInstallation(
          otherWorkspaceId,
          installation(firstId, accountId, "avgeek-labs"),
        ),
        /another workspace/,
      );
      const statuses = await getGitHubConnectionStatuses(
        workspaceId,
        async (id) => {
          if (id === String(secondId))
            throw new Error("Temporarily unavailable");
          return await Promise.resolve(
            installation(firstId, accountId, "avgeek-labs"),
          );
        },
        () =>
          Promise.resolve({ id: "1234", name: "towbar", owner: "avgeek-labs" }),
      );
      assert.equal(
        statuses.find((item) => item.id === legacy.id)?.permissionReadiness
          .status,
        "available",
      );
      assert.equal(
        statuses.find((item) => item.id === second.id)?.permissionReadiness
          .status,
        "unavailable",
      );
      const listed = await getWorkspaceGitHubRepositories(
        workspaceId,
        undefined,
        {
          listRepositories: async (id) => {
            if (id === String(secondId))
              throw new Error("Temporarily unavailable");
            return await Promise.resolve([
              {
                id: "1234",
                owner: "avgeek-labs",
                name: "towbar",
                fullName: "avgeek-labs/towbar",
                defaultBranch: "main",
                private: false,
              },
            ]);
          },
          getRepository: () =>
            Promise.resolve({
              id: "1234",
              name: "towbar",
              owner: "avgeek-labs",
            }),
        },
      );
      assert.equal(listed.repositories[0]?.connectionId, legacy.id);
      assert.equal(listed.unavailableConnections[0]?.id, second.id);
      assert.equal(
        (
          await database.select().from(sources).where(eq(sources.id, sourceId))
        )[0]?.providerRepositoryId,
        "1234",
      );
      const [environment] = await database
        .insert(sourceEnvironments)
        .values({ sourceId, name: "production", branch: "main" })
        .returning();
      assert(environment);
      const [history] = await database
        .insert(sourceSyncs)
        .values({
          sourceId,
          sourceEnvironmentId: environment.id,
          mappingRevision: environment.mappingRevision,
          status: "succeeded",
          commitSha: "a".repeat(40),
        })
        .returning();
      assert(history);
      const actor = {
        kind: "system" as const,
        workspaceId,
        source: "worker" as const,
        grants: ["admin"] as const,
      };
      const input = {
        sourceId,
        workspaceId,
        actorUserId: null,
        githubInstallationId: second.id,
        repositoryOwner: "avgeek-oss",
        repositoryName: "towbar",
      };
      const movedRepository = {
        id: "1234",
        owner: "avgeek-oss",
        name: "towbar",
      };
      const move = (repo = movedRepository, branches = ["main"]) =>
        withActor(actor, () =>
          changeSourceGitHubConnection(input, {
            getRepository: () => Promise.resolve(repo),
            listBranches: async (request) => {
              assert.equal(request.installationId, String(secondId));
              return await Promise.resolve(branches);
            },
          }),
        );
      await assert.rejects(
        move({ ...movedRepository, id: "5678" }),
        /same GitHub repository/,
      );
      await assert.rejects(
        move(movedRepository, ["develop"]),
        /missing branches: main/,
      );
      const [active] = await database
        .insert(sourceSyncs)
        .values({
          sourceId,
          sourceEnvironmentId: environment.id,
          mappingRevision: environment.mappingRevision,
          status: "queued",
        })
        .returning();
      assert(active);
      await assert.rejects(move(), /active syncs and deployments/);
      await database.delete(sourceSyncs).where(eq(sourceSyncs.id, active.id));
      await assert.rejects(
        withActor(actor, () =>
          changeSourceGitHubConnection(
            { ...input, workspaceId: otherWorkspaceId },
            {
              getRepository: () => Promise.resolve(movedRepository),
              listBranches: () => Promise.resolve(["main"]),
            },
          ),
        ),
        /permitted|GitHub repository/,
      );
      await assert.rejects(
        withActor(actor, () =>
          changeSourceGitHubConnection(input, {
            getRepository: () => Promise.resolve(movedRepository),
            listBranches: async () => {
              await database
                .update(integrationInstallations)
                .set({ suspendedAt: new Date() })
                .where(eq(integrationInstallations.id, second.id));
              return ["main"];
            },
          }),
        ),
        /destination GitHub account changed/,
      );
      await database
        .update(integrationInstallations)
        .set({ suspendedAt: null })
        .where(eq(integrationInstallations.id, second.id));
      const duplicateId = randomUUID();
      await database.insert(sources).values({
        id: duplicateId,
        workspaceId,
        integrationInstallationId: second.id,
        providerRepositoryId: "1234",
        repositoryOwner: "avgeek-oss",
        repositoryName: "towbar",
      });
      try {
        await assert.rejects(move(), /already connected to another source/);
      } finally {
        await database.delete(sources).where(eq(sources.id, duplicateId));
      }
      const moved = await move();
      assert.equal(moved.source?.id, sourceId);
      assert.equal(moved.source?.repositoryOwner, "avgeek-oss");
      const [stored] = await database
        .select()
        .from(sources)
        .where(eq(sources.id, sourceId));
      assert.equal(stored?.integrationInstallationId, second.id);
      assert.equal(
        (
          await database
            .select()
            .from(sourceSyncs)
            .where(eq(sourceSyncs.id, history.id))
        ).length,
        1,
      );
      const [mapping] = await database
        .select()
        .from(sourceEnvironments)
        .where(eq(sourceEnvironments.id, environment.id));
      assert.equal(mapping?.branch, environment.branch);
      assert.notEqual(mapping?.mappingRevision, environment.mappingRevision);
      let queued = 0;
      const push = (id: number, owner: string, repositoryId = 1234) =>
        processGitHubPush(
          {
            installation: { id },
            deleted: false,
            after: "b".repeat(40),
            ref: "refs/heads/main",
            repository: {
              id: repositoryId,
              name: "towbar",
              owner: { login: owner },
            },
          },
          () => {
            queued += 1;
            return Promise.resolve();
          },
        );
      await push(firstId, "avgeek-labs");
      assert.equal(queued, 0);
      await push(secondId, "avgeek-oss", 5678);
      assert.equal(queued, 0);
      await push(secondId, "avgeek-oss");
      assert.equal(queued, 1);
      await disconnectGitHub(workspaceId, legacy.id, (id) => {
        assert.equal(id, String(firstId));
        return Promise.reject(
          new HttpError(404, "GITHUB_REQUEST_FAILED", "Already removed"),
        );
      });
      assert((await getGitHubConnection(workspaceId, legacy.id))?.suspendedAt);
      await assert.rejects(
        createInstallationToken(String(firstId)),
        /Reconnect/,
      );
      assert.equal(
        (await getGitHubConnection(workspaceId, second.id))?.suspendedAt,
        null,
      );
      await assert.rejects(
        getGitHubInstallationForSource({
          workspaceId,
          installationId: legacy.id,
        }),
        /Reconnect/,
      );
      await push(secondId, "avgeek-oss");
      assert.equal(queued, 2);
      const reconnected = await saveGitHubInstallation(
        workspaceId,
        installation(reinstalledId, accountId, "avgeek-labs"),
      );
      assert.equal(reconnected?.id, legacy.id);
      assert.equal((await getGitHubConnections(workspaceId)).length, 2);
      assert.equal(
        (await getGitHubConnection(workspaceId, legacy.id))?.installationId,
        String(reinstalledId),
      );
    } finally {
      await closeDatabase();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  },
);
