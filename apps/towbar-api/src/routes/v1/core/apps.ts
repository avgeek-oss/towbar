import { listAppJobs, requestAppJob } from "../../../areas/apps/jobs.js";
import { getAppIcon } from "../../../areas/favicons/service.js";
import { getAppStorage } from "../../../areas/apps/storage.js";
import { actorAllows } from "@workspace/towbar-access";
import {
  filterWorkloads,
  workloadFilters,
} from "@workspace/towbar-core/inventory";
import { operation } from "../../../http/operation.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  getApp,
  listAppDeployments,
  listAppReleases,
  listApps,
  requestAppDeployment,
  requestAppRollback,
} from "../../../areas/apps/service.js";
import {
  listDeployableOperations,
  listOperationEvents,
  requestDeployableOperation,
} from "../../../areas/resource-operations/service.js";
import { listPreviewEnvironments } from "../../../areas/previews/service.js";
import { badRequest } from "../../../http/errors.js";
import { readJson } from "../../../http/requests.js";
import { autoDeployControlPatchSchema } from "./auto-deploy-control-requests.js";
import {
  getDeployableAutoDeployControl,
  updateDeployableAutoDeployControl,
} from "../../../areas/auto-deploy-controls/service.js";
import { wakeMaintenanceWorkflow } from "../../../infrastructure/temporal.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

const rollbackSchema = z
  .object({ releaseId: z.string().uuid().optional() })
  .strict();
const logsSchema = z
  .object({
    runtime: z.enum(["workload", "ingress"]).default("workload"),
    service: z.string().trim().min(1).max(128).optional(),
    tail: z.number().int().min(1).max(5_000),
  })
  .strict();
const runtimeActionSchema = z
  .object({ service: z.string().trim().min(1).max(128).optional() })
  .strict();
export const appRoutes = new Hono<TowbarHonoEnvironment>();

appRoutes.get(
  "/",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/"',
    query: workloadFilters,
    summary: "List apps",
    response: "JSON object containing apps.",
    status: 200,
  }),
  async (context) => {
    const result = filterWorkloads(
      await listApps(context.get("user").workspaceId),
      workloadFilters.parse(context.req.query()),
    );
    return context.json({
      apps: result.items,
      counts: result.counts,
      environments: result.environments,
    });
  },
);

appRoutes.get(
  "/:appId",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/:appId"',
    summary: "Get app",
    response: "JSON object containing app.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json({
      app: await getApp(context.req.param("appId"), user.workspaceId),
    });
  },
);

appRoutes.get(
  "/:appId/favicon",
  operation({
    permissions: ["workload.read"],
    browserOnly: true,
    responseSchema: 'apps.ts:get:"/:appId/favicon"',
    summary: "Get a workload icon",
    response: "A bounded workload icon image and its cache expiry.",
    status: 200,
  }),
  async (context) => {
    context.header("Cache-Control", "private, no-store");
    return context.json(
      await getAppIcon(
        context.req.param("appId"),
        context.get("user").workspaceId,
      ),
    );
  },
);

appRoutes.get(
  "/:appId/jobs",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/:appId/jobs"',
    summary: "List scheduled app jobs",
    response: "Manifest jobs and their latest 100 executions.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await listAppJobs(
        context.req.param("appId"),
        context.get("user").workspaceId,
      ),
    ),
);
const runJobSchema = z
  .object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u) })
  .strict();
appRoutes.post(
  "/:appId/actions/run-job",
  operation({
    permissions: ["workload.operate"],
    responseSchema: 'apps.ts:post:"/:appId/actions/run-job"',
    summary: "Run a manifest-defined app job",
    body: runJobSchema,
    idempotencyKey: true,
    response: "The queued job execution and replay status.",
    status: 202,
  }),
  async (context) => {
    const input = await readJson(context, runJobSchema);
    const user = context.get("user");
    const result = await requestAppJob({
      appId: context.req.param("appId"),
      workspaceId: user.workspaceId,
      requestedBy: user.id,
      jobName: input.name,
      idempotencyKey: requireIdempotencyKey(
        context.req.header("idempotency-key"),
      ),
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

appRoutes.get(
  "/:appId/storage",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/:appId/storage"',
    summary: "Get app persistent storage",
    response: "Declared and observed volumes for this app environment.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await getAppStorage(
        context.req.param("appId"),
        context.get("user").workspaceId,
      ),
    ),
);

appRoutes.get(
  "/:appId/auto-deploy-control",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/:appId/auto-deploy-control"',
    summary: "Get app auto-deploy settings",
    response: "JSON object containing autoDeploy, canManageAutoDeploy.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json({
      autoDeploy: await getDeployableAutoDeployControl({
        deployableId: context.req.param("appId"),
        expectedType: "app",
        workspaceId: user.workspaceId,
      }),
      canManageAutoDeploy: actorAllows(context.get("actor"), [
        "deployment.create",
      ]),
    });
  },
);

appRoutes.patch(
  "/:appId/auto-deploy-control",
  operation({
    permissions: ["deployment.create"],
    responseSchema: 'apps.ts:patch:"/:appId/auto-deploy-control"',
    summary: "Update app auto-deploy settings",
    body: autoDeployControlPatchSchema,
    response: "JSON object containing autoDeploy, canManageAutoDeploy.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const result = await updateDeployableAutoDeployControl({
      deployableId: context.req.param("appId"),
      expectedType: "app",
      ...(await readJson(context, autoDeployControlPatchSchema)),
      workspaceId: user.workspaceId,
    });
    const { shouldReevaluate, ...autoDeploy } = result;
    if (shouldReevaluate) {
      void wakeMaintenanceWorkflow().catch(() => undefined);
    }
    return context.json({
      autoDeploy,
      canManageAutoDeploy: actorAllows(context.get("actor"), [
        "deployment.create",
      ]),
    });
  },
);

appRoutes.get(
  "/:appId/deployments",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/:appId/deployments"',
    summary: "List app deployments",
    response: "JSON object containing deployments.",
    status: 200,
  }),
  async (context) =>
    context.json({
      deployments: await listAppDeployments(
        context.req.param("appId"),
        context.get("user").workspaceId,
      ),
    }),
);

appRoutes.get(
  "/:appId/releases",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/:appId/releases"',
    summary: "List app releases",
    response: "JSON object containing releases.",
    status: 200,
  }),
  async (context) =>
    context.json({
      releases: await listAppReleases(
        context.req.param("appId"),
        context.get("user").workspaceId,
      ),
    }),
);

appRoutes.get(
  "/:appId/previews",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/:appId/previews"',
    summary: "List preview environments",
    response: "JSON object containing previews.",
    status: 200,
  }),
  async (context) =>
    context.json({
      previews: await listPreviewEnvironments({
        appId: context.req.param("appId"),
        workspaceId: context.get("user").workspaceId,
      }),
    }),
);

appRoutes.get(
  "/:appId/operations",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/:appId/operations"',
    summary: "List app operations",
    response: "JSON object containing operations.",
    status: 200,
  }),
  async (context) =>
    context.json({
      operations: await listDeployableOperations(
        context.req.param("appId"),
        context.get("user").workspaceId,
      ),
    }),
);

appRoutes.get(
  "/:appId/operations/:operationId/events",
  operation({
    permissions: ["workload.read"],
    responseSchema: 'apps.ts:get:"/:appId/operations/:operationId/events"',
    summary: "List app operation progress",
    response: "JSON object containing operation events.",
    status: 200,
  }),
  async (context) =>
    context.json({
      events: await listOperationEvents(
        context.req.param("operationId"),
        context.get("user").workspaceId,
      ),
    }),
);

appRoutes.post(
  "/:appId/actions/deploy",
  operation({
    permissions: ["deployment.create"],
    responseSchema: 'apps.ts:post:"/:appId/actions/deploy"',
    summary: "Request app deployment",
    idempotencyKey: true,
    response: "The deployment and whether the request was replayed.",
    status: 202,
  }),
  async (context) => {
    const idempotencyKey = requireIdempotencyKey(
      context.req.header("idempotency-key"),
    );
    const user = context.get("user");
    const result = await requestAppDeployment({
      appId: context.req.param("appId"),
      idempotencyKey,
      requestedBy: user.id,
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

appRoutes.post(
  "/:appId/actions/refresh-external-secrets",
  operation({
    permissions: ["deployment.create"],
    responseSchema: 'apps.ts:post:"/:appId/actions/refresh-external-secrets"',
    summary: "Redeploy an app with current external secrets",
    idempotencyKey: true,
    response:
      "A new deployment that resolves one consistent snapshot of current external secret versions.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const result = await requestAppDeployment({
      appId: context.req.param("appId"),
      idempotencyKey: requireIdempotencyKey(
        context.req.header("idempotency-key"),
      ),
      requestedBy: user.id,
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

appRoutes.post(
  "/:appId/actions/rollback",
  operation({
    permissions: ["deployment.create"],
    responseSchema: 'apps.ts:post:"/:appId/actions/rollback"',
    summary: "Request app rollback",
    body: rollbackSchema,
    idempotencyKey: true,
    response: "The rollback deployment and whether the request was replayed.",
    status: 202,
  }),
  async (context) => {
    const idempotencyKey = requireIdempotencyKey(
      context.req.header("idempotency-key"),
    );
    const input = await readJson(context, rollbackSchema);
    const user = context.get("user");
    const result = await requestAppRollback({
      appId: context.req.param("appId"),
      idempotencyKey,
      releaseId: input.releaseId,
      requestedBy: user.id,
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

for (const action of ["restart", "start", "stop"] as const) {
  appRoutes.post(
    `/:appId/actions/${action}`,
    operation({
      permissions: ["workload.operate"],
      responseSchema: "apps.ts:post:`/:appId/actions/${action}`",
      summary: `${action.charAt(0).toUpperCase() + action.slice(1)} app`,
      body: runtimeActionSchema,
      idempotencyKey: true,
      response: "The runtime operation and whether the request was replayed.",
      status: 202,
    }),
    async (context) => {
      const user = context.get("user");
      const input = await readJson(context, runtimeActionSchema);
      const result = await requestDeployableOperation({
        deployableId: context.req.param("appId"),
        idempotencyKey: requireIdempotencyKey(
          context.req.header("idempotency-key"),
        ),
        requestedBy: user.id,
        request: { ...input, type: action },
        workspaceId: user.workspaceId,
      });
      return context.json(result, result.replayed ? 200 : 202);
    },
  );
}

appRoutes.post(
  "/:appId/actions/logs",
  operation({
    permissions: ["workload.operate"],
    responseSchema: 'apps.ts:post:"/:appId/actions/logs"',
    summary: "Request app operation",
    body: logsSchema,
    idempotencyKey: true,
    response: "The runtime operation and whether the request was replayed.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const input = await readJson(context, logsSchema);
    const result = await requestDeployableOperation({
      deployableId: context.req.param("appId"),
      idempotencyKey: requireIdempotencyKey(
        context.req.header("idempotency-key"),
      ),
      requestedBy: user.id,
      request: { ...input, type: "capture_logs" },
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

function requireIdempotencyKey(value: string | undefined) {
  const key = value?.trim();
  if (!key || key.length > 255) {
    throw badRequest(
      "A valid Idempotency-Key header is required",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  return key;
}
