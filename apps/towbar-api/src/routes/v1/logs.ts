import { z } from "zod";
import { verifyLogDrain } from "../../areas/logs/drain.js";
import { Hono } from "hono";
import { buildLogCollectorConfiguration } from "@workspace/towbar-core";
import {
  authenticateLogCollector,
  ingestLogExport,
  logExportSchema,
  registerLogSources,
  sourceReportSchema,
} from "../../areas/logs/ingest.js";
import {
  readJson,
  readText,
  readUuidPathParameter,
} from "../../http/requests.js";
import { badRequest } from "../../http/errors.js";
import { getEnv } from "../../env.js";

export const logIngestRoutes = new Hono();
logIngestRoutes.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  await next();
});
logIngestRoutes.post("/sources", async (context) => {
  const token = (context.req.header("authorization") ?? "").replace(
    /^Bearer /u,
    "",
  );
  const serverId = readUuidPathParameter(
    context.req.header("x-towbar-server") ?? "",
    "X-Towbar-Server",
  );
  const principal = await authenticateLogCollector(serverId, token);
  const report = await readJson(context, sourceReportSchema);
  const accepted = await registerLogSources(principal, report);
  const allowed = new Set(accepted.allowedContainerIds);
  const configuration = buildLogCollectorConfiguration({
    endpoint: new URL(
      "/v1/logs/ingest",
      getEnv().TOWBAR_API_BASE_URL,
    ).toString(),
    serverId,
    token,
    sources: report.sources
      .filter((source) => allowed.has(source.containerId))
      .map((source) => ({
        containerId: source.containerId,
        startAt: source.startAt,
      })),
  });
  return context.json({ ...accepted, configuration });
});
logIngestRoutes.post("/ingest", async (context) => {
  if ((context.req.header("content-encoding") ?? "identity") !== "identity")
    throw badRequest(
      "Use uncompressed OTLP JSON for the log collector endpoint.",
    );
  const token = (context.req.header("authorization") ?? "").replace(
    /^Bearer /u,
    "",
  );
  const serverId = readUuidPathParameter(
    context.req.header("x-towbar-server") ?? "",
    "X-Towbar-Server",
  );
  const principal = await authenticateLogCollector(serverId, token);
  const text = await readText(context, 4 * 1024 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest("Invalid OTLP JSON");
  }
  return context.json(
    await ingestLogExport(
      principal,
      logExportSchema.parse(value),
      Buffer.byteLength(text),
    ),
  );
});

logIngestRoutes.post("/drain", async (context) => {
  const serverId = readUuidPathParameter(
    context.req.header("x-towbar-server") ?? "",
    "X-Towbar-Server",
  );
  const token = (context.req.header("authorization") ?? "").replace(
    /^Bearer /u,
    "",
  );
  const principal = await authenticateLogCollector(serverId, token);
  const input = await readJson(
    context,
    z
      .object({
        eventIds: z
          .array(z.string().regex(/^[a-f0-9]{64}$/u))
          .min(1)
          .max(128),
      })
      .strict(),
    16384,
  );
  return context.json(await verifyLogDrain(principal, input.eventIds));
});
