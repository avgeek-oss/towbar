import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeConnection, Worker } from "@temporalio/worker";

import { instrumentTemporalActivities } from "@workspace/observability-node/temporal";
import { towbarTaskQueue } from "@workspace/towbar-core/temporal";

import * as activities from "./activities/index.js";
import { getEnv } from "./env.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const instrumentedActivities = instrumentTemporalActivities(activities);

async function main() {
  const env = getEnv();
  let ready = false;
  const healthServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(ready ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          service: "towbar-worker",
          status: ready ? "ok" : "starting",
          version: env.SOURCE_COMMIT,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  healthServer.listen(env.WORKER_HEALTH_PORT, "0.0.0.0");

  const connection = await NativeConnection.connect({
    address: env.TEMPORAL_ADDRESS,
    ...(env.TEMPORAL_API_KEY
      ? { apiKey: env.TEMPORAL_API_KEY, tls: true }
      : {}),
  });
  const workflowBundle = await loadWorkflowBundle();
  const worker = await Worker.create({
    activities: instrumentedActivities,
    connection,
    identity: `towbar-worker-${process.pid}`,
    maxConcurrentActivityTaskExecutions:
      env.TOWBAR_WORKER_MAX_CONCURRENT_ACTIVITIES,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: towbarTaskQueue,
    workflowBundle,
  });
  ready = true;
  const shutdown = () => {
    if (worker.getState() === "RUNNING") worker.shutdown();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await worker.run();
  } finally {
    ready = false;
    shutdown();
    healthServer.close();
    await connection.close();
  }
}

async function loadWorkflowBundle() {
  if (import.meta.url.endsWith(".ts")) {
    const { bundleWorkflowCode } = await import("@temporalio/worker");
    return await bundleWorkflowCode({
      workflowsPath: path.resolve(sourceDirectory, "workflows/index.ts"),
    });
  }
  return { codePath: path.resolve(sourceDirectory, "workflow-bundle.js") };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
