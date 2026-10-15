import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cwd } from "node:process";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import {
  buildLogCollectorConfiguration,
  logCollectorImage,
  logFilterSchema,
  logQuerySchema,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  logCollectors,
  logSources,
  servers,
  workspaces,
} from "@workspace/towbar-database/schema";
import { logIngestRoutes } from "../../routes/v1/logs.js";
import { hashLogCredential } from "./ingest.js";
import { LogStorage } from "./storage.js";
import { queryLogs } from "./queries.js";
import { withActor } from "../auth/actor-context.js";
import { HttpError } from "../../http/errors.js";

const execFile = promisify(execFileCallback);
const databaseUrl = process.env.TOWBAR_TEST_DATABASE_URL;
const clickhouseUrl = process.env.TOWBAR_TEST_CLICKHOUSE_URL;
const docker = async (...args: string[]) =>
  (
    await execFile("docker", args, {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
async function until(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(500);
  }
  throw new Error(`Timed out: ${description}`);
}

void test(
  "pinned Docker collector redacts, persists its queue, resumes checkpoints and handles rotation",
  {
    skip:
      process.env.TOWBAR_TEST_LOG_COLLECTOR !== "true" ||
      !databaseUrl ||
      !clickhouseUrl,
    timeout: 180000,
  },
  async () => {
    assert(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));
    assert(
      clickhouseUrl &&
        ["localhost", "127.0.0.1"].includes(new URL(clickhouseUrl).hostname),
    );
    process.env.DATABASE_TOWBAR_URL = databaseUrl;
    process.env.TOWBAR_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    process.env.TOWBAR_INTERNAL_HMAC_SECRET = randomBytes(32).toString("hex");
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
      workloadId = randomUUID();
    const suffix = randomBytes(6).toString("hex");
    const sourceName = `towbar-logs-source-${suffix}`,
      collectorName = `towbar-logs-collector-${suffix}`,
      volume = `towbar-logs-state-${suffix}`,
      sourceVolume = `towbar-logs-source-files-${suffix}`,
      configurationVolume = `towbar-logs-configuration-${suffix}`;
    const token = `twlg_${randomBytes(32).toString("hex")}`;
    const reports = path.resolve(cwd(), "../../tmp/verification/logs");
    await mkdir(reports, { recursive: true });
    const directory = await mkdtemp(path.join(reports, "collector-"));
    const configPath = path.join(directory, "config.json");
    let outage = true,
      requests = 0;
    const payloads: string[] = [];
    const app = new Hono();
    app.use("*", async (c, next) => {
      if (c.req.path === "/probe") return c.text("ready");
      requests++;
      if (outage) return c.json({ error: "Test outage" }, 503);
      const body = await c.req.raw.clone().text();
      payloads.push(body);
      await next();
    });
    app.onError((error, c) =>
      c.json(
        { error: error instanceof HttpError ? error.code : error.message },
        error instanceof HttpError ? error.status : 500,
      ),
    );
    app.route("/v1/logs", logIngestRoutes);
    const http = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 0 });
    if (!http.listening)
      await new Promise<void>((resolve) => http.once("listening", resolve));
    const address = http.address();
    assert(address && typeof address !== "string");
    const actor = {
      kind: "session" as const,
      workspaceId,
      userId: randomUUID(),
      role: "admin" as const,
    };
    const filters = logFilterSchema.parse({
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date(Date.now() + 3600000).toISOString(),
    });
    const read = () =>
      withActor(actor, () =>
        queryLogs(workspaceId, logQuerySchema.parse({ filters, limit: 500 })),
      );
    try {
      await db.insert(workspaces).values({
        id: workspaceId,
        slug: workspaceId,
        name: "Collector protocol test",
      });
      await db.insert(servers).values({
        id: serverId,
        workspaceId,
        canonicalIp: "192.0.2.211",
        configDigest: "test",
        config: normalizeServerConfiguration({
          ip: "192.0.2.211",
          ssh: { username: "deploy" },
          hostLogCollection: true,
        }),
      });
      await db.insert(logCollectors).values({
        serverId,
        desiredState: "enabled",
        status: "waiting",
        tokenHash: hashLogCredential(token),
      });
      const id = await docker(
        "run",
        "--detach",
        "--name",
        sourceName,
        "--log-driver",
        "json-file",
        "--log-opt",
        "max-size=64k",
        "--log-opt",
        "max-file=3",
        "--entrypoint",
        "sh",
        "postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24",
        "-c",
        "sleep 180",
      );
      const logPath = await docker("inspect", "--format", "{{.LogPath}}", id);
      assert(logPath.endsWith(`/${id}-json.log`));
      await docker(
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=none",
        "--opt",
        `device=${path.posix.dirname(logPath)}`,
        "--opt",
        "o=bind,ro,private",
        sourceVolume,
      );
      assert.equal(
        await docker(
          "run",
          "--rm",
          "--add-host",
          "host.docker.internal:host-gateway",
          "--entrypoint",
          "wget",
          "postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24",
          "-qO-",
          "-T",
          "3",
          `http://host.docker.internal:${address.port}/probe`,
        ),
        "ready",
        "collector containers must reach the test API",
      );
      await db.insert(logSources).values({
        workspaceId,
        serverId,
        workloadId,
        workloadName: "Test API",
        containerId: id,
      });
      const config = buildLogCollectorConfiguration({
        endpoint: `http://host.docker.internal:${address.port}/v1/logs/ingest`,
        token,
        serverId,
        sources: [{ containerId: id, startAt: "beginning" }],
      });
      const queue = config.exporters["otlphttp/towbar"].sending_queue;
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await docker(
        "run",
        "--rm",
        "--mount",
        `type=bind,src=${configPath},dst=/source.json,readonly`,
        "--mount",
        `type=volume,src=${configurationVolume},dst=/configuration`,
        "--entrypoint",
        "sh",
        "postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24",
        "-c",
        "umask 077; cat /source.json > /configuration/collector.json",
      );
      const emit = (body: string) =>
        docker(
          "exec",
          sourceName,
          "sh",
          "-c",
          'printf "%s\\n" "$1" > /proc/1/fd/1',
          "sh",
          body,
        );
      await emit(
        '{"level":30,"msg":"queued before restart","password":"must-never-leave-server"}',
      );
      await emit("Authorization: Bearer secret-bearer-value");
      await docker(
        "exec",
        sourceName,
        "sh",
        "-c",
        'exec 1>/proc/1/fd/1; i=0; while test "$i" -lt 200; do printf "buffered-%s %s\\n" "$i" "$1"; i=$((i+1)); done',
        "sh",
        "x".repeat(128),
      );
      const start = () =>
        docker(
          "run",
          "--detach",
          "--name",
          collectorName,
          "--add-host",
          "host.docker.internal:host-gateway",
          "--user",
          "0:0",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--read-only",
          "--memory",
          "256m",
          "--cpus",
          "0.25",
          "--mount",
          `type=volume,src=${sourceVolume},dst=/var/lib/docker/containers/${id},readonly,volume-nocopy`,
          "--mount",
          `type=volume,src=${configurationVolume},dst=/etc/towbar-logs,readonly,volume-nocopy`,
          "--mount",
          `type=volume,src=${volume},dst=/var/lib/towbar-logs`,
          logCollectorImage,
          "--config=/etc/towbar-logs/collector.json",
        );
      await start();
      await until(
        () => Promise.resolve(requests > 0),
        "collector attempts export during an outage",
      );
      await docker("stop", "--time", "5", collectorName);
      await docker("rm", collectorName);
      outage = false;
      await start();
      await until(
        async () => (await read()).records.length >= 202,
        "persistent queue flushes after restart",
      );
      let records = (await read()).records;
      assert.equal(records.length, 202);
      assert.equal(
        records.filter((record) => record.body.startsWith("buffered-")).length,
        200,
      );
      assert(
        records.some(
          (r) => r.body === "queued before restart" && r.severity === "info",
        ),
      );
      assert(records.some((r) => r.body.includes("[REDACTED]")));
      assert(!payloads.join("\n").includes("must-never-leave-server"));
      assert(!payloads.join("\n").includes("secret-bearer-value"));
      await emit("same message");
      await emit("same message");
      await until(
        async () =>
          (await read()).records.filter(
            (r) => r.body.trimEnd() === "same message",
          ).length === 2,
        "identical messages retain separate Docker positions",
      );
      await docker("stop", "--time", "5", collectorName);
      await docker("rm", collectorName);
      await start();
      await emit("after checkpoint restart");
      await until(
        async () =>
          (await read()).records.some(
            (r) => r.body.trimEnd() === "after checkpoint restart",
          ),
        "checkpoint resumes appended logs",
      );
      records = (await read()).records;
      assert.equal(
        records.length,
        205,
        "checkpoint restart must not duplicate prior records",
      );
      for (let i = 0; i < 24; i++) {
        await emit(`rotation-${i} ${"x".repeat(4000)}`);
        await delay(100);
      }
      await emit("after rotation");
      await until(
        async () =>
          (await read()).records.some(
            (r) => r.body.trimEnd() === "after rotation",
          ),
        "collector follows the newly created Docker log after rotation",
      );
      const beforeLoad = Date.now();
      const samples: string[] = [];
      const writer = docker(
        "exec",
        sourceName,
        "sh",
        "-c",
        'exec 1>/proc/1/fd/1; second=0; count=0; while test "$second" -lt 10; do batch=0; while test "$batch" -lt 100; do printf "load-%s %s\\n" "$count" "$1"; count=$((count+1)); batch=$((batch+1)); done; second=$((second+1)); sleep 1; done',
        "sh",
        "x".repeat(256),
      );
      for (let sample = 0; sample < 4; sample++)
        samples.push(
          await docker(
            "stats",
            "--no-stream",
            "--format",
            "{{json .}}",
            collectorName,
          ),
        );
      await writer;
      await until(async () => {
        const [row] = await storage.execute<{ count: number }>(
          "SELECT count() AS count FROM log_records FINAL WHERE workspaceId = {workspaceId:UUID} AND startsWith(body, 'load-') FORMAT JSONEachRow",
          { workspaceId },
        );
        return Number(row?.count) === 1000;
      }, "sustained sample is accepted without loss");
      const queryStart = performance.now();
      const [measurements] = await storage.execute(
        "SELECT count() AS records, sum(length(body)) AS payloadBytes, quantileExact(0.95)(dateDiff('millisecond', timestamp, ingestedAt)) AS p95IngestMilliseconds FROM log_records FINAL WHERE workspaceId = {workspaceId:UUID} AND startsWith(body, 'load-') FORMAT JSONEachRow",
        { workspaceId },
      );
      const benchmark = {
        sourceContainers: 1,
        offeredRecordsPerSecond: 100,
        durationSeconds: 10,
        collectorCpus: 0.25,
        collectorMemoryMiB: 256,
        testQueueBytes: queue.queue_size,
        elapsedMilliseconds: Date.now() - beforeLoad,
        queryMilliseconds: Math.round(performance.now() - queryStart),
        measurements,
        samples: samples.map((sample) => {
          const row = JSON.parse(sample) as Record<string, string>;
          return { cpu: row.CPUPerc, memory: row.MemUsage, pids: row.PIDs };
        }),
      };
      assert.equal(
        await docker(
          "inspect",
          "--format",
          "{{.State.OOMKilled}}",
          collectorName,
        ),
        "false",
      );
      await writeFile(
        path.join(reports, "collector-benchmark.json"),
        JSON.stringify(benchmark, null, 2),
      );
      assert(payloads.length > 0);
    } catch (error) {
      const diagnostics = await docker(
        "logs",
        "--tail",
        "30",
        collectorName,
      ).catch(() => "Collector was not started");
      const state = await docker(
        "inspect",
        "--format",
        "{{json .State}}",
        collectorName,
      ).catch(() => "Collector state unavailable");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${state}\n${diagnostics}`,
        { cause: error },
      );
    } finally {
      await docker("rm", "--force", collectorName).catch(() => undefined);
      await docker("volume", "rm", sourceVolume).catch(() => undefined);
      await docker("volume", "rm", configurationVolume).catch(() => undefined);
      await docker("rm", "--force", sourceName).catch(() => undefined);
      await docker("volume", "rm", volume).catch(() => undefined);
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await storage.execute(
        "ALTER TABLE log_records DELETE WHERE workspaceId = {workspaceId:UUID}",
        { workspaceId },
      );
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
