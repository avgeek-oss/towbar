import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  type NormalizedDeployable,
  isNormalizedResource,
  logQuerySchema,
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  integrationInstallations,
  logCollectorRequests,
  logCollectors,
  logSources,
  previewEnvironments,
  servers,
  sessions,
  sources,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { withActor } from "../auth/actor-context.js";
import {
  testDeploymentEnvironment,
  testInstanceLinks,
} from "../sources/instance-test-helper.js";
import {
  admitLogCollection,
  finishLogCollectorOperation,
  getLogCollection,
  getLogCollectorExecutionContext,
} from "./lifecycle.js";
import {
  authenticateLogCollector,
  hashLogCredential,
  ingestLogExport,
  logExportSchema,
  registerLogSources,
  sourceReportSchema,
} from "./ingest.js";
import { queryLogs } from "./queries.js";
import { refreshLogStreamActor } from "./stream-access.js";
import { LogStorage } from "./storage.js";

const databaseUrl = process.env.TOWBAR_TEST_DATABASE_URL;
const clickhouseUrl = process.env.TOWBAR_TEST_CLICKHOUSE_URL;
void test(
  "collector admission, managed source identity and current session access",
  { skip: !databaseUrl || !clickhouseUrl },
  async (t) => {
    assert(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));
    assert(
      clickhouseUrl &&
        ["127.0.0.1", "localhost"].includes(new URL(clickhouseUrl).hostname),
    );
    process.env.DATABASE_TOWBAR_URL = databaseUrl;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    process.env.TOWBAR_API_BASE_URL = "https://towbar-api.example.test";
    const configuration = {
      retentionDays: 7,
      clickhouse: {
        endpoint: clickhouseUrl,
        database: "towbar_logs_test",
        username: "logs_test",
        password: "logs_test",
      },
    };
    process.env.TOWBAR_LOGS_CONFIG_JSON = JSON.stringify(configuration);
    const { runTowbarMigrations } =
      await import("@workspace/towbar-database/migrate");
    await runTowbarMigrations({
      databaseUrl,
      logger: { info() {}, error() {} },
    });
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const db = getTowbarDatabase(),
      storage = new LogStorage(configuration);
    const workspaceId = randomUUID(),
      serverId = randomUUID(),
      secondServer = randomUUID(),
      userId = randomUUID(),
      sessionId = randomUUID(),
      sourceId = randomUUID(),
      previewId = randomUUID();
    const actor = {
      kind: "session" as const,
      workspaceId,
      userId,
      role: "admin" as const,
    };
    const serverConfig = normalizeServerConfiguration({
      ip: "192.0.2.218",
      ssh: { username: "deploy" },
      hostLogCollection: false,
    });
    const manifest = normalizeDeploymentManifest({
      version: 2,
      apps: [
        {
          id: "api",
          name: "API",
          server: serverConfig.ip,
          dockerfile: "Dockerfile",
          container: { port: 3000 },
          logs: { restrict: "admin" },
        },
      ],
      resources: [
        {
          id: "db",
          name: "PostgreSQL",
          type: "postgres",
          server: serverConfig.ip,
        },
      ],
      compose: [
        {
          id: "stack",
          name: "Stack",
          server: serverConfig.ip,
          file: "compose.yml",
          services: { api: {} },
        },
      ],
    });
    const workloadRows: { id: string; config: NormalizedDeployable }[] = [];
    try {
      await db.insert(workspaces).values({
        id: workspaceId,
        slug: workspaceId,
        name: "Log lifecycle test",
      });
      await db.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Log administrator",
        emailVerified: true,
      });
      await db
        .insert(workspaceMembers)
        .values({ workspaceId, userId, role: "admin" });
      await db.insert(sessions).values({
        id: sessionId,
        userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3600000),
      });
      await db.insert(servers).values([
        {
          id: serverId,
          workspaceId,
          canonicalIp: serverConfig.ip,
          config: serverConfig,
          configDigest: "test",
          preparedAt: new Date(),
        },
        {
          id: secondServer,
          workspaceId,
          canonicalIp: "192.0.2.219",
          config: { ...serverConfig, ip: "192.0.2.219" },
          configDigest: "test",
          preparedAt: new Date(),
        },
      ]);
      await t.test(
        "queue file allocation is not reported as pending log data",
        async () => {
          await db.insert(logCollectors).values({
            serverId,
            desiredState: "enabled",
            status: "collecting",
            queueBytes: 2 * 1024 * 1024,
            lastReportAt: new Date(),
          });
          const inspect = () =>
            withActor(actor, () => getLogCollection(serverId, workspaceId));
          assert.equal((await inspect()).status, "collecting");
          await db
            .update(logCollectors)
            .set({ queueBytes: 536870913 })
            .where(eq(logCollectors.serverId, serverId));
          assert.equal((await inspect()).status, "backlogged");
          await db
            .delete(logCollectors)
            .where(eq(logCollectors.serverId, serverId));
        },
      );
      await t.test("concurrent retries preserve one generation", async () => {
        const input = {
          serverId,
          workspaceId,
          enabled: true,
          idempotencyKey: randomUUID(),
        };
        const outcomes = await Promise.all([
          withActor(actor, () => admitLogCollection(input)),
          withActor(actor, () => admitLogCollection(input)),
        ]);
        assert.equal(outcomes[0]!.generation, outcomes[1]!.generation);
        const [server] = await db
          .select()
          .from(servers)
          .where(eq(servers.id, serverId));
        assert.equal(
          server!.config.hostLogCollection ?? false,
          false,
          "native collection does not grant custom Services host-log access",
        );
        await assert.rejects(
          getLogCollectorExecutionContext(serverId, outcomes[0]!.generation!),
          /Configure.*SSH private key/,
        );
        assert.equal(outcomes.filter((row) => row.replayed).length, 1);
        assert.equal(
          (
            await db
              .select()
              .from(logCollectorRequests)
              .where(eq(logCollectorRequests.workspaceId, workspaceId))
          ).length,
          1,
        );
        await assert.rejects(
          withActor(actor, () =>
            admitLogCollection({ ...input, enabled: false }),
          ),
          { code: "IDEMPOTENCY_KEY_REUSED" },
        );
        await assert.rejects(
          withActor(actor, () =>
            admitLogCollection({ ...input, serverId: secondServer }),
          ),
          { code: "IDEMPOTENCY_KEY_REUSED" },
        );
        await finishLogCollectorOperation(
          serverId,
          outcomes[0]!.generation!,
          true,
        );
        await finishLogCollectorOperation(
          serverId,
          outcomes[0]!.generation!,
          false,
        );
        assert.equal(
          (
            await db
              .select()
              .from(logCollectors)
              .where(eq(logCollectors.serverId, serverId))
          )[0]!.status,
          "waiting",
        );
        const disable = await withActor(actor, () =>
          admitLogCollection({
            ...input,
            enabled: false,
            idempotencyKey: randomUUID(),
          }),
        );
        await assert.rejects(
          withActor(actor, () => admitLogCollection(input)),
          { code: "LOGS_OPERATION_SUPERSEDED" },
        );
        assert.equal(disable.desiredState, "disabled");
        await finishLogCollectorOperation(serverId, disable.generation!, true);
        for (const role of ["viewer", "member"] as const)
          await assert.rejects(
            withActor({ ...actor, role }, () =>
              admitLogCollection({ ...input, idempotencyKey: randomUUID() }),
            ),
            { status: 403 },
          );
      });
      const [installation] = await db
        .insert(integrationInstallations)
        .values({
          workspaceId,
          provider: "github",
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
        repositoryName: "logs",
      });
      for (const config of [
        ...manifest.apps,
        ...(manifest.resources ?? []),
        ...(manifest.compose ?? []),
      ]) {
        const id = randomUUID(),
          kind = config.kind ?? "app";
        await db.insert(apps).values({
          ...(await testInstanceLinks(
            sourceId,
            config.id,
            isNormalizedResource(config) ? "resource" : "app",
          )),
          id,
          workspaceId,
          sourceId,
          serverId,
          kind,
          manifestId: config.id,
          name: config.name,
          config,
          configDigest: "test",
          sourceRevision: "abcdef0",
        });
        workloadRows.push({ id, config });
      }
      const api = workloadRows[0]!;
      await db.insert(previewEnvironments).values({
        id: previewId,
        workspaceId,
        sourceId,
        appId: api.id,
        serverId,
        pullRequestNumber: 1,
        branch: "logs-preview",
        gitRef: "refs/pull/1/head",
        hostname: "pr-1.example.test",
        runtimeId: randomUUID(),
        latestCommitSha: "abcdef0",
        expiresAt: new Date(Date.now() + 3600000),
      });
      const sourceClaims: {
        containerId: string;
        workloadId: string;
        deploymentId: string;
        previewId: string | null;
        service: string;
        startAt: "beginning";
      }[] = [];
      for (const [index, workload] of [...workloadRows, api].entries()) {
        const deploymentId = randomUUID(),
          preview = index === 3;
        await db.insert(deployments).values({
          targetEnvironment: await testDeploymentEnvironment(workload.id),
          requiredSecrets: {
            build: [],
            runtime: [],
            preDeploy: [],
            postDeploy: [],
          },
          id: deploymentId,
          workspaceId,
          sourceId,
          appId: workload.id,
          serverId,
          idempotencyKey: deploymentId,
          temporalWorkflowId: deploymentId,
          commitSha: "abcdef0",
          manifestDigest: "test",
          appSnapshot: workload.config,
          serverSnapshot: serverConfig,
          deployableKind: workload.config.kind ?? "app",
          ...(preview
            ? {
                environment: "preview" as const,
                previewEnvironmentId: previewId,
                gitRef: "refs/pull/1/head",
                hostname: "pr-1.example.test",
              }
            : {}),
        });
        sourceClaims.push({
          containerId: String(index + 1).repeat(64),
          workloadId: workload.id,
          deploymentId,
          previewId: null,
          service: index === 2 ? "api" : "",
          startAt: "beginning" as const,
        });
      }
      const token = `twlg_${randomBytes(32).toString("hex")}`;
      await db
        .update(logCollectors)
        .set({
          desiredState: "enabled",
          status: "waiting",
          tokenHash: hashLogCredential(token),
        })
        .where(eq(logCollectors.serverId, serverId));
      const principal = await authenticateLogCollector(serverId, token);
      await t.test(
        "native collector credentials are revoked by disabling collection",
        async () => {
          await db
            .update(logCollectors)
            .set({ desiredState: "disabled" })
            .where(eq(logCollectors.serverId, serverId));
          await assert.rejects(authenticateLogCollector(serverId, token), {
            status: 401,
          });
          await db
            .update(logCollectors)
            .set({ desiredState: "enabled" })
            .where(eq(logCollectors.serverId, serverId));
        },
      );
      await t.test(
        "server-managed deployment identities attribute production, datastore, Compose and previews",
        async () => {
          const report = sourceReportSchema.parse({
            sources: [
              ...sourceClaims,
              {
                ...sourceClaims[0]!,
                containerId: "f".repeat(64),
                workloadId: randomUUID(),
              },
              {
                ...sourceClaims[0]!,
                containerId: "e".repeat(64),
                previewId: randomUUID(),
              },
            ],
            unsupportedContainers: 1,
            queueBytes: 0,
            droppedRecords: 0,
            version: "0.162.0",
          });
          const result = await registerLogSources(principal, report);
          assert.deepEqual(
            result.allowedContainerIds,
            sourceClaims.map((claim) => claim.containerId),
          );
          const registry = await db
            .select()
            .from(logSources)
            .where(eq(logSources.serverId, serverId));
          assert.equal(registry.length, 4);
          assert.equal(
            registry.find(
              (row) => row.containerId === sourceClaims[3]!.containerId,
            )?.previewId,
            previewId,
          );
          for (const claim of sourceClaims) {
            const batch = logExportSchema.parse({
              resourceLogs: [
                {
                  resource: {
                    attributes: [
                      {
                        key: "container.id",
                        value: { stringValue: claim.containerId },
                      },
                    ],
                  },
                  scopeLogs: [
                    {
                      logRecords: [
                        {
                          timeUnixNano: String(BigInt(Date.now()) * 1000000n),
                          body: {
                            stringValue: `Source ${claim.service || claim.workloadId}`,
                          },
                          attributes: [
                            {
                              key: "log.file.record_offset",
                              value: { intValue: "0" },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            });
            await ingestLogExport(principal, batch, 512);
          }
          const query = logQuerySchema.parse({
            filters: {
              from: new Date(Date.now() - 3600000).toISOString(),
              to: new Date(Date.now() + 60000).toISOString(),
            },
          });
          const admin = await withActor(actor, () =>
            queryLogs(workspaceId, query),
          );
          assert.equal(admin.records.length, 4);
          assert.equal(
            admin.records.filter((r) => r.environment === "preview").length,
            1,
          );
          assert.equal(
            admin.records.find((r) => r.service === "api")?.workloadName,
            "Stack",
          );
          const viewer = await withActor({ ...actor, role: "viewer" }, () =>
            queryLogs(workspaceId, query),
          );
          assert.equal(
            viewer.records.length,
            2,
            "restricted parent and preview are both excluded",
          );
          await db
            .update(apps)
            .set({ archivedAt: new Date() })
            .where(eq(apps.id, api.id));
          assert.equal(
            (await withActor(actor, () => queryLogs(workspaceId, query)))
              .records.length,
            4,
          );
        },
      );
      await t.test(
        "live access observes role downgrade, required password change and revoked sessions",
        async () => {
          assert.equal(
            (await refreshLogStreamActor(actor, sessionId)).kind,
            "session",
          );
          await db
            .update(workspaceMembers)
            .set({ role: "viewer" })
            .where(eq(workspaceMembers.userId, userId));
          const downgraded = await refreshLogStreamActor(actor, sessionId);
          assert(downgraded.kind === "session" && downgraded.role === "viewer");
          await db
            .update(users)
            .set({ mustChangePassword: true })
            .where(eq(users.id, userId));
          await assert.rejects(refreshLogStreamActor(actor, sessionId), {
            status: 401,
          });
          await db
            .update(users)
            .set({ mustChangePassword: false })
            .where(eq(users.id, userId));
          await db.delete(sessions).where(eq(sessions.id, sessionId));
          await assert.rejects(refreshLogStreamActor(actor, sessionId), {
            status: 401,
          });
        },
      );
    } finally {
      await storage.execute(
        "ALTER TABLE log_records DELETE WHERE workspaceId = {workspaceId:UUID}",
        { workspaceId },
      );
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.delete(users).where(eq(users.id, userId));
      await closeDatabase();
    }
  },
);
