import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  type LogRecord,
  logQueryResultSchema,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  logCollectors,
  logPolicies,
  logSources,
  servers,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { connectTestMcpClient } from "../external-api/scout-access-test-helper.js";
import { issueTestMcpToken } from "../mcp-oauth/token-test-helper.js";
import { hashLogCredential } from "./ingest.js";
import { LogStorage } from "./storage.js";

const databaseUrl = process.env.TOWBAR_TEST_DATABASE_URL;
const clickhouseUrl = process.env.TOWBAR_TEST_CLICKHOUSE_URL;

void test(
  "centralized logs preserve authorization across REST, OAuth MCP, drain and follow",
  { skip: !databaseUrl || !clickhouseUrl, timeout: 30000 },
  async (t) => {
    assert(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));
    assert(
      clickhouseUrl &&
        ["localhost", "127.0.0.1"].includes(new URL(clickhouseUrl).hostname),
    );
    process.env.DATABASE_TOWBAR_URL = databaseUrl;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
    process.env.TOWBAR_APP_BASE_URL = "https://app.towbar.test";
    process.env.TOWBAR_API_BASE_URL = "https://api.towbar.test";
    process.env.TOWBAR_API_RATE_LIMIT_MAX = "1000";
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
    const { createApp } = await import("../../app.js");
    const { createApiKey, revokeApiKey } =
      await import("../api-keys/service.js");
    const db = getTowbarDatabase(),
      app = createApp(),
      storage = new LogStorage(configuration);
    const workspaceId = randomUUID(),
      userId = randomUUID(),
      serverId = randomUUID(),
      sessionId = randomUUID();
    const workloads = [randomUUID(), randomUUID()];
    const collectorToken = `twlg_${randomBytes(32).toString("hex")}`;
    const user = {
      id: userId,
      email: `${userId}@example.test`,
      name: "Log administrator",
      workspaceId,
      workspaceRole: "admin" as const,
    };
    const filters = {
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date(Date.now() + 3600000).toISOString(),
    };
    const rest = (
      path: string,
      token: string,
      body?: unknown,
      method = "POST",
    ) =>
      app.request(`/v1/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const ingest = (
      container: string,
      body: string,
      offset: number,
      at = Date.now() - 1000,
    ) =>
      app.request("/v1/logs/ingest", {
        method: "POST",
        headers: {
          authorization: `Bearer ${collectorToken}`,
          "x-towbar-server": serverId,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: {
                attributes: [
                  { key: "container.id", value: { stringValue: container } },
                ],
              },
              scopeLogs: [
                {
                  logRecords: [
                    {
                      timeUnixNano: String(BigInt(at) * 1000000n),
                      body: { stringValue: body },
                      attributes: [
                        {
                          key: "log.file.record_offset",
                          value: { intValue: String(offset) },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
    const page = async (token: string) => {
      const response = await rest("/logs/query", token, { filters });
      assert.equal(response.status, 200, await response.clone().text());
      return logQueryResultSchema.parse(await response.json());
    };
    try {
      await db.insert(workspaces).values({
        id: workspaceId,
        slug: workspaceId,
        name: "Log surface test",
      });
      await db.insert(users).values({
        id: userId,
        email: user.email,
        displayName: user.name,
        emailVerified: true,
      });
      await db
        .insert(workspaceMembers)
        .values({ userId, workspaceId, role: "admin" });
      await db.insert(sessions).values({
        id: sessionId,
        userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3600000),
        authenticatedAt: new Date(),
      });
      await db.insert(servers).values({
        id: serverId,
        workspaceId,
        canonicalIp: "192.0.2.224",
        configDigest: "test",
        config: normalizeServerConfiguration({
          ip: "192.0.2.224",
          ssh: { username: "deploy" },
          hostLogCollection: true,
        }),
      });
      await db.insert(logCollectors).values({
        serverId,
        desiredState: "enabled",
        status: "waiting",
        tokenHash: hashLogCredential(collectorToken),
      });
      await db.insert(logSources).values(
        workloads.map((workloadId, i) => ({
          serverId,
          workspaceId,
          workloadId,
          workloadName: `Service ${i}`,
          containerId: String(i).repeat(64),
        })),
      );
      await db
        .insert(logPolicies)
        .values({ workspaceId, workloadId: workloads[1]!, restricted: true });
      const keys = await Promise.all([
        createApiKey(user, { name: "Read", access: "read" }),
        createApiKey(user, { name: "Write", access: "edit" }),
        createApiKey(user, {
          name: "Admin",
          access: "edit",
          includeAdmin: true,
        }),
      ]);
      const tokens = keys.map((key) => {
        assert(key.token);
        return key.token;
      });
      for (const [i, text] of ["public event", "restricted event"].entries()) {
        const response = await ingest(String(i).repeat(64), text, 0);
        assert.equal(response.status, 200, await response.clone().text());
      }
      const adminPage = await page(tokens[2]!);
      assert.equal(adminPage.records.length, 2);
      const restricted = adminPage.records.find(
        (record) => record.body === "restricted event",
      )!;
      const contextInput = (record: LogRecord) => ({
        eventId: record.eventId,
        timestamp: record.timestamp,
        workloadId: record.workloadId,
      });
      await t.test(
        "REST read and write keys exclude restricted rows, counts, facets and context",
        async () => {
          for (const [index, token] of tokens.entries()) {
            const found = await page(token);
            assert.equal(found.records.length, index === 2 ? 2 : 1);
            const summary = await rest("/logs/summary", token, filters);
            assert.equal(summary.status, 200);
            const result = (await summary.json()) as {
              buckets: { count: number }[];
              facets: unknown;
            };
            assert.equal(
              result.buckets.reduce((count, bucket) => count + bucket.count, 0),
              index === 2 ? 2 : 1,
            );
            if (index !== 2)
              assert(!JSON.stringify(result.facets).includes(workloads[1]!));
            assert.equal(
              (await rest("/logs/context", token, contextInput(restricted)))
                .status,
              index === 2 ? 200 : 404,
            );
            if (index !== 2)
              assert.equal(
                (
                  await rest(
                    `/servers/${serverId}/log-collection`,
                    token,
                    { enabled: true },
                    "PUT",
                  )
                ).status,
                403,
              );
          }
          assert.equal(
            (await rest("/observability/logs/actions/verify", tokens[0]!))
              .status,
            403,
          );
          assert.equal(
            (await rest("/logs/query", collectorToken, { filters })).status,
            401,
          );
        },
      );
      await t.test(
        "OAuth MCP uses the selected level and returns the same stored event identities",
        async () => {
          for (const level of ["read", "write", "admin"] as const) {
            const oauth = await issueTestMcpToken(
              user,
              level === "read" ? "read" : "edit",
              level,
              sessionId,
            );
            const client = await connectTestMcpClient(oauth.token, (request) =>
              app.fetch(request),
            );
            try {
              const tools = (await client.listTools()).tools.map(
                (tool) => tool.name,
              );
              assert(tools.includes("towbar_logs_query"));
              assert.equal(
                tools.includes("towbar_logs_collection_configure"),
                level === "admin",
              );
              const queried = await client.callTool({
                name: "towbar_logs_query",
                arguments: { filters },
              });
              assert.equal(queried.isError, false);
              const result = logQueryResultSchema.parse(
                (queried.structuredContent as { result: unknown }).result,
              );
              assert.equal(result.records.length, level === "admin" ? 2 : 1);
              assert(
                result.records.every((record) =>
                  adminPage.records.some(
                    (stored) => stored.eventId === record.eventId,
                  ),
                ),
              );
              const context = await client.callTool({
                name: "towbar_logs_context",
                arguments: contextInput(restricted),
              });
              assert.equal(context.isError, level !== "admin");
              const followed = await client.callTool({
                name: "towbar_logs_follow",
                arguments: { filters, cursor: result.followCursor },
              });
              assert.equal(followed.isError, false);
            } finally {
              await client.close();
            }
          }
        },
      );
      await t.test(
        "follow includes newly accepted events and collector acknowledgements remain server scoped",
        async () => {
          const initial = await page(tokens[0]!);
          assert.equal(
            (await ingest("0".repeat(64), "followed event", 200)).status,
            200,
          );
          const follow = await rest("/logs/follow", tokens[0]!, {
            filters,
            cursor: initial.followCursor,
          });
          assert.equal(follow.status, 200);
          const result = (await follow.json()) as { records: LogRecord[] };
          assert.deepEqual(
            result.records.map((record) => record.body),
            ["followed event"],
          );
          const expected = result.records[0]!.eventId;
          const drain = (token: string, id = serverId) =>
            app.request("/v1/logs/drain", {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "x-towbar-server": id,
                "content-type": "application/json",
              },
              body: JSON.stringify({ eventIds: [expected, "f".repeat(64)] }),
            });
          assert.deepEqual(await (await drain(collectorToken)).json(), {
            acceptedEventIds: [expected],
          });
          assert.equal((await drain(tokens[2]!)).status, 401);
          assert.equal((await drain(collectorToken, randomUUID())).status, 401);
        },
      );
      await t.test(
        "multiline and oversized Unicode messages remain bounded and skewed timestamps are rejected",
        async () => {
          const text = "line one\nline two\t\u0000" + "🙂".repeat(100000);
          assert.equal((await ingest("0".repeat(64), text, 400)).status, 200);
          const found = (await page(tokens[2]!)).records.find((record) =>
            record.body.startsWith("line one"),
          );
          assert(found?.truncated);
          assert(Buffer.byteLength(found.body) <= 262144);
          assert(!found.body.includes("\ufffd"));
          assert(found.body.startsWith("line one\nline two\t\u0000"));
          const future = await ingest(
            "0".repeat(64),
            "invalid future event",
            500,
            Date.now() + 300000,
          );
          assert.equal(future.status, 200);
          assert.deepEqual(
            (
              (await future.json()) as {
                partialSuccess: { rejectedLogRecords: string };
              }
            ).partialSuccess.rejectedLogRecords,
            "1",
          );
          assert(
            !(await page(tokens[2]!)).records.some(
              (record) => record.body === "invalid future event",
            ),
          );
        },
      );
      await t.test(
        "revoking a REST key stops an existing follow stream",
        async () => {
          const response = await rest("/logs/tail", tokens[0]!, { filters });
          assert.equal(response.status, 200);
          const reader = response.body!.getReader();
          try {
            const first = await reader.read();
            assert(
              new TextDecoder().decode(first.value).includes("event: records"),
            );
            await revokeApiKey(user, keys[0]!.key.id);
            let received = "";
            await Promise.race([
              (async () => {
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  received += new TextDecoder().decode(chunk.value);
                }
              })(),
              new Promise<never>((_, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("Revoked stream did not close")),
                  6000,
                );
                timer.unref();
              }),
            ]);
            assert(received.includes("event: error"), received);
            assert(!received.includes("restricted event"));
            assert.equal(
              (await rest("/logs/query", tokens[0]!, { filters })).status,
              401,
            );
          } finally {
            await reader.cancel();
          }
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
