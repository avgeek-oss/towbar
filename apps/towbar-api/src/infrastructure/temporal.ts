import { createHash, randomUUID } from "node:crypto";

import { Client, Connection } from "@temporalio/client";

import {
  deploymentWorkflowId,
  maintenanceWorkflowId,
  notificationDeliveryWorkflowId,
  resourceOperationWorkflowId,
  serverCoordinatorWorkflowId,
  sourceCoordinatorWorkflowId,
  towbarTaskQueue,
  vulnerabilityScanWorkflowId,
} from "@workspace/towbar-core/temporal";

import type {
  PreviewPullRequestEvent,
  ServerWorkItem,
} from "@workspace/towbar-core/temporal";

import { getEnv } from "../env.js";

let clientPromise: Promise<Client> | undefined;

export function previewLifecycleWorkflowId(
  sourceId: string,
  pullRequestNumber: number,
) {
  return `towbar-preview/v2/${sourceId}/pull/${pullRequestNumber}`;
}

export async function enqueueSourceSync(input: {
  sourceId: string;
  syncId: string;
}) {
  const client = await getTemporalClient();
  const workflowId = sourceCoordinatorWorkflowId(input.sourceId);
  await client.workflow.signalWithStart("runSourceCoordinatorWorkflow", {
    args: [],
    signal: "enqueueSourceSync",
    signalArgs: [input.syncId],
    taskQueue: towbarTaskQueue,
    workflowId,
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
  });
  return { workflowId };
}

export async function enqueueDeployment(input: {
  appId: string;
  buildConcurrency: number;
  deploymentId: string;
  previewBuildConcurrency?: number;
  priority?: "preview" | "production";
  serverIp: string;
}) {
  const client = await getTemporalClient();
  const serverHash = createHash("sha256")
    .update(input.serverIp)
    .digest("hex")
    .slice(0, 32);
  const workflowId = serverCoordinatorWorkflowId(serverHash);
  await client.workflow.signalWithStart(
    "runConcurrentServerCoordinatorWorkflow",
    {
      args: [],
      signal: "enqueueServerWork",
      signalArgs: [
        {
          appId: input.appId,
          buildConcurrency: input.buildConcurrency,
          id: input.deploymentId,
          kind: "deployment",
          previewBuildConcurrency: input.previewBuildConcurrency ?? 1,
          priority: input.priority ?? "production",
        },
      ],
      taskQueue: towbarTaskQueue,
      workflowId,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    },
  );
  return { workflowId };
}

export async function enqueuePreviewPullRequestEvent(
  event: PreviewPullRequestEvent,
) {
  const client = await getTemporalClient();
  const workflowId = previewLifecycleWorkflowId(
    event.sourceId,
    event.pullRequestNumber,
  );
  await client.workflow.signalWithStart("runPreviewLifecycleWorkflow", {
    args: [],
    signal: "previewPullRequestEvent",
    signalArgs: [event],
    taskQueue: towbarTaskQueue,
    workflowId,
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
  });
  return { workflowId };
}

export async function enqueuePreviewCleanup(input: {
  appId: string;
  buildConcurrency: number;
  previewBuildConcurrency: number;
  previewEnvironmentId: string;
  serverIp: string;
}) {
  const client = await getTemporalClient();
  const serverHash = createHash("sha256")
    .update(input.serverIp)
    .digest("hex")
    .slice(0, 32);
  const workflowId = serverCoordinatorWorkflowId(serverHash);
  await client.workflow.signalWithStart(
    "runConcurrentServerCoordinatorWorkflow",
    {
      args: [],
      signal: "enqueueServerWork",
      signalArgs: [
        createPreviewCleanupWorkItem({
          appId: input.appId,
          buildConcurrency: input.buildConcurrency,
          previewBuildConcurrency: input.previewBuildConcurrency,
          previewEnvironmentId: input.previewEnvironmentId,
        }),
      ],
      taskQueue: towbarTaskQueue,
      workflowId,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    },
  );
  return { workflowId };
}

export function createPreviewCleanupWorkItem(
  input: Omit<
    Extract<ServerWorkItem, { kind: "preview-cleanup" }>,
    "id" | "kind"
  >,
  attemptId = randomUUID(),
): Extract<ServerWorkItem, { kind: "preview-cleanup" }> {
  return {
    ...input,
    id: attemptId,
    kind: "preview-cleanup",
  };
}

export async function enqueueServerCheck(input: {
  buildConcurrency: number;
  checkId: string;
  serverIp: string;
}) {
  const client = await getTemporalClient();
  const serverHash = createHash("sha256")
    .update(input.serverIp)
    .digest("hex")
    .slice(0, 32);
  const workflowId = serverCoordinatorWorkflowId(serverHash);
  await client.workflow.signalWithStart(
    "runConcurrentServerCoordinatorWorkflow",
    {
      args: [],
      signal: "enqueueServerWork",
      signalArgs: [
        {
          buildConcurrency: input.buildConcurrency,
          id: input.checkId,
          kind: "server-check",
        },
      ],
      taskQueue: towbarTaskQueue,
      workflowId,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    },
  );
  return { workflowId };
}

export async function enqueueServerPreparation(input: {
  buildConcurrency: number;
  preparationId: string;
  serverIp: string;
}) {
  const client = await getTemporalClient();
  const serverHash = createHash("sha256")
    .update(input.serverIp)
    .digest("hex")
    .slice(0, 32);
  const workflowId = serverCoordinatorWorkflowId(serverHash);
  await client.workflow.signalWithStart(
    "runConcurrentServerCoordinatorWorkflow",
    {
      args: [],
      signal: "enqueueServerWork",
      signalArgs: [
        {
          buildConcurrency: input.buildConcurrency,
          id: input.preparationId,
          kind: "server-preparation",
        },
      ],
      taskQueue: towbarTaskQueue,
      workflowId,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    },
  );
  return { workflowId };
}

export async function enqueueResourceOperation(input: {
  appId: string | null;
  buildConcurrency: number;
  exclusive: boolean;
  operationId: string;
  serverIp: string;
}) {
  const client = await getTemporalClient();
  const serverHash = createHash("sha256")
    .update(input.serverIp)
    .digest("hex")
    .slice(0, 32);
  const workflowId = serverCoordinatorWorkflowId(serverHash);
  await client.workflow.signalWithStart(
    "runConcurrentServerCoordinatorWorkflow",
    {
      args: [],
      signal: "enqueueServerWork",
      signalArgs: [
        {
          appId: input.appId,
          buildConcurrency: input.buildConcurrency,
          exclusive: input.exclusive,
          id: input.operationId,
          kind: "resource-operation",
        },
      ],
      taskQueue: towbarTaskQueue,
      workflowId,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    },
  );
  return { workflowId: resourceOperationWorkflowId(input.operationId) };
}

export async function enqueueVulnerabilityScan(input: {
  appId: string;
  buildConcurrency: number;
  cycle: number;
  scanId: string;
  serverIp: string;
}) {
  const client = await getTemporalClient();
  const serverHash = createHash("sha256")
    .update(input.serverIp)
    .digest("hex")
    .slice(0, 32);
  const workflowId = serverCoordinatorWorkflowId(serverHash);
  await client.workflow.signalWithStart(
    "runConcurrentServerCoordinatorWorkflow",
    {
      args: [],
      signal: "enqueueServerWork",
      signalArgs: [
        {
          appId: input.appId,
          buildConcurrency: input.buildConcurrency,
          cycle: input.cycle,
          id: input.scanId,
          kind: "vulnerability-scan",
        },
      ],
      taskQueue: towbarTaskQueue,
      workflowId,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    },
  );
  return {
    workflowId: vulnerabilityScanWorkflowId(input.scanId, input.cycle),
  };
}

export async function wakeMaintenanceWorkflow() {
  const client = await getTemporalClient();
  const workflowId = maintenanceWorkflowId();
  await client.workflow.signalWithStart("runMaintenanceWorkflow", {
    args: [],
    signal: "wakeMaintenance",
    signalArgs: [],
    taskQueue: towbarTaskQueue,
    workflowId,
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
  });
  return { workflowId };
}

export async function ensureDatabaseStorageWorkflow() {
  const client = await getTemporalClient();
  try {
    await client.workflow.start("runDatabaseStorageWorkflow", {
      args: [],
      taskQueue: towbarTaskQueue,
      workflowId: "towbar-database-storage/v1",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    });
  } catch (error) {
    if (!isWorkflowAlreadyStarted(error)) throw error;
  }
}

export async function wakeScoutAlertsWorkflow() {
  const client = await getTemporalClient();
  const workflowId = "towbar-scout-alerts";
  await client.workflow.signalWithStart("runScoutAlertsWorkflow", {
    args: [],
    signal: "wakeScoutAlerts",
    signalArgs: [],
    taskQueue: towbarTaskQueue,
    workflowId,
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
  });
  return { workflowId };
}

export async function enqueueNotificationDelivery(input: {
  cycle: number;
  deliveryId: string;
}) {
  const client = await getTemporalClient();
  const workflowId = notificationDeliveryWorkflowId(
    input.deliveryId,
    input.cycle,
  );
  try {
    await client.workflow.start("runNotificationDeliveryWorkflow", {
      args: [input],
      taskQueue: towbarTaskQueue,
      workflowId,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    });
  } catch (error) {
    if (!isWorkflowAlreadyStarted(error)) throw error;
  }
  return { workflowId };
}

export async function cancelDeploymentWorkflow(deploymentId: string) {
  const client = await getTemporalClient();
  await client.workflow.getHandle(deploymentWorkflowId(deploymentId)).cancel();
}

export async function cancelResourceOperationWorkflow(operationId: string) {
  const client = await getTemporalClient();
  await client.workflow
    .getHandle(resourceOperationWorkflowId(operationId))
    .cancel();
}

export async function closeTemporalClient() {
  const pending = clientPromise;
  clientPromise = undefined;
  if (pending) await (await pending).connection.close();
}

async function getTemporalClient() {
  clientPromise ??= createTemporalClient().catch((error: unknown) => {
    clientPromise = undefined;
    throw error;
  });
  return await clientPromise;
}

async function createTemporalClient() {
  const env = getEnv();
  const connection = await Connection.connect({
    address: env.TEMPORAL_ADDRESS,
    connectTimeout: env.TEMPORAL_CONNECT_TIMEOUT_MS,
    ...(env.TEMPORAL_API_KEY
      ? { apiKey: env.TEMPORAL_API_KEY, tls: true }
      : {}),
  });
  return new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
}

function isWorkflowAlreadyStarted(error: unknown) {
  return (
    error instanceof Error &&
    [
      "WorkflowExecutionAlreadyStartedError",
      "WorkflowExecutionAlreadyStarted",
    ].includes(error.name)
  );
}

export async function enqueueMonitoringAgent(input: {
  serverId: string;
  generation: string;
}) {
  const client = await getTemporalClient();
  const workflowId = `towbar-monitoring/${input.serverId}/${input.generation}`;
  try {
    await client.workflow.start("runMonitoringAgentWorkflow", {
      args: [input],
      taskQueue: towbarTaskQueue,
      workflowId,
      workflowExecutionTimeout: "15 minutes",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
  } catch (error) {
    if (!isWorkflowAlreadyStarted(error)) throw error;
    const execution = await client.workflow.getHandle(workflowId).describe();
    return { workflowId, closed: execution.status.name !== "RUNNING" };
  }
  return { workflowId };
}

export async function enqueueTransactionalEmail(
  outboxId: string,
  attempt: number,
) {
  const client = await getTemporalClient();
  try {
    await client.workflow.start("runTransactionalEmailWorkflow", {
      args: [{ outboxId }],
      taskQueue: towbarTaskQueue,
      workflowId: `towbar-team-email/${outboxId}/${attempt}`,
      workflowExecutionTimeout: "30 minutes",
      workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
    });
  } catch (error) {
    if (!isWorkflowAlreadyStarted(error)) throw error;
  }
}

export async function wakeAppJobsWorkflow() {
  const client = await getTemporalClient();
  await client.workflow.signalWithStart("runAppJobsWorkflow", {
    args: [],
    signal: "wakeAppJobs",
    signalArgs: [],
    taskQueue: towbarTaskQueue,
    workflowId: "towbar-app-jobs",
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
  });
}

export async function ensureAnalyticsWorkflow() {
  const client = await getTemporalClient();
  try {
    await client.workflow.start("runAnalyticsWorkflow", {
      args: [],
      taskQueue: towbarTaskQueue,
      workflowId: "towbar-analytics/v1",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    });
  } catch (error) {
    if (!isWorkflowAlreadyStarted(error)) throw error;
  }
}

export async function enqueueLogCollector(input: {
  serverId: string;
  generation: string;
}) {
  const client = await getTemporalClient();
  const workflowId = `towbar-logs/${input.serverId}/${input.generation}`;
  try {
    await client.workflow.start("runLogCollectorWorkflow", {
      args: [input],
      taskQueue: towbarTaskQueue,
      workflowId,
      workflowExecutionTimeout: "15 minutes",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
  } catch (error) {
    if (!isWorkflowAlreadyStarted(error)) throw error;
    const execution = await client.workflow.getHandle(workflowId).describe();
    return { workflowId, closed: execution.status.name !== "RUNNING" };
  }
  return { workflowId, closed: false };
}
