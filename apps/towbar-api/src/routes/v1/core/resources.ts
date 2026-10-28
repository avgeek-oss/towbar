import { actorAllows } from "@workspace/towbar-access";
import {
  filterWorkloads,
  workloadFilters,
} from "@workspace/towbar-core/inventory";
import { operation } from "../../../http/operation.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  getResource,
  listResourceDeployments,
  listResourceReleases,
  listResources,
  requestAppDeployment,
  requestAppRollback,
} from "../../../areas/apps/service.js";
import {
  cancelResourceRestore,
  getResourceBackupAssurance,
  listDeployableOperations,
  listOperationEvents,
  listResourceBackupAssurances,
  requestDeployableOperation,
  requestResourceRestore,
  requestRestoreCleanup,
} from "../../../areas/resource-operations/service.js";
import { hasAwsCredentials } from "../../../areas/aws/service.js";
import { hasGcpCredentials } from "../../../areas/gcp/service.js";
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
const restoreSchema = z
  .object({
    backupId: z.string().uuid(),
    confirmation: z.string().trim().min(1).max(255),
    reason: z.string().trim().min(10).max(1_000),
  })
  .strict();
const restoreCleanupSchema = z
  .object({ restoreId: z.string().uuid() })
  .strict();

export const resourceRoutes = new Hono<TowbarHonoEnvironment>();

resourceRoutes.get(
  "/",
  operation({
    permissions: ["viewer"],
    responseSchema: 'resources.ts:get:"/"',
    query: workloadFilters,
    summary: "List resources",
    response: "JSON object containing resources.",
    status: 200,
  }),
  async (context) => {
    const result = filterWorkloads(
      await listResources(context.get("user").workspaceId),
      workloadFilters.parse(context.req.query()),
    );
    return context.json({
      resources: result.items,
      counts: result.counts,
      environments: result.environments,
    });
  },
);

resourceRoutes.get(
  "/:resourceId",
  operation({
    permissions: ["viewer"],
    responseSchema: 'resources.ts:get:"/:resourceId"',
    summary: "Get resource",
    response: "JSON object containing resource.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json({
      resource: await getResource(
        context.req.param("resourceId"),
        user.workspaceId,
      ),
    });
  },
);

resourceRoutes.get(
  "/:resourceId/auto-deploy-control",
  operation({
    permissions: ["viewer"],
    responseSchema: 'resources.ts:get:"/:resourceId/auto-deploy-control"',
    summary: "Get resource auto-deploy settings",
    response: "JSON object containing autoDeploy, canManageAutoDeploy.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json({
      autoDeploy: await getDeployableAutoDeployControl({
        deployableId: context.req.param("resourceId"),
        expectedType: "resource",
        workspaceId: user.workspaceId,
      }),
      canManageAutoDeploy: actorAllows(context.get("actor"), ["admin"]),
    });
  },
);

resourceRoutes.patch(
  "/:resourceId/auto-deploy-control",
  operation({
    permissions: ["admin"],
    responseSchema: 'resources.ts:patch:"/:resourceId/auto-deploy-control"',
    summary: "Update resource auto-deploy settings",
    body: autoDeployControlPatchSchema,
    response: "JSON object containing autoDeploy, canManageAutoDeploy.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const result = await updateDeployableAutoDeployControl({
      deployableId: context.req.param("resourceId"),
      expectedType: "resource",
      ...(await readJson(context, autoDeployControlPatchSchema)),
      workspaceId: user.workspaceId,
    });
    const { shouldReevaluate, ...autoDeploy } = result;
    if (shouldReevaluate) {
      void wakeMaintenanceWorkflow().catch(() => undefined);
    }
    return context.json({
      autoDeploy,
      canManageAutoDeploy: actorAllows(context.get("actor"), ["admin"]),
    });
  },
);

resourceRoutes.get(
  "/:resourceId/deployments",
  operation({
    permissions: ["viewer"],
    responseSchema: 'resources.ts:get:"/:resourceId/deployments"',
    summary: "List resource deployments",
    response: "JSON object containing deployments.",
    status: 200,
  }),
  async (context) =>
    context.json({
      deployments: await listResourceDeployments(
        context.req.param("resourceId"),
        context.get("user").workspaceId,
      ),
    }),
);

resourceRoutes.get(
  "/:resourceId/releases",
  operation({
    permissions: ["viewer"],
    responseSchema: 'resources.ts:get:"/:resourceId/releases"',
    summary: "List resource releases",
    response: "JSON object containing releases.",
    status: 200,
  }),
  async (context) =>
    context.json({
      releases: await listResourceReleases(
        context.req.param("resourceId"),
        context.get("user").workspaceId,
      ),
    }),
);

resourceRoutes.get(
  "/:resourceId/operations",
  operation({
    permissions: ["viewer"],
    responseSchema: 'resources.ts:get:"/:resourceId/operations"',
    summary: "List resource operations",
    response: "JSON object containing operations.",
    status: 200,
  }),
  async (context) =>
    context.json({
      operations: await listDeployableOperations(
        context.req.param("resourceId"),
        context.get("user").workspaceId,
      ),
    }),
);

resourceRoutes.get(
  "/:resourceId/backup-assurance",
  operation({
    permissions: ["viewer"],
    responseSchema: 'resources.ts:get:"/:resourceId/backup-assurance"',
    summary: "Get resource backup assurance",
    response:
      "JSON object containing assurance, assurances, awsConfigured, canRestore.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const [awsConfigured, gcpConfigured] = await Promise.all([
      hasAwsCredentials(user.workspaceId),
      hasGcpCredentials(user.workspaceId),
    ]);
    return context.json({
      assurance: await getResourceBackupAssurance(
        context.req.param("resourceId"),
        user.workspaceId,
      ),
      assurances: await listResourceBackupAssurances(
        context.req.param("resourceId"),
        user.workspaceId,
      ),
      awsConfigured,
      canRestore: actorAllows(context.get("actor"), ["admin"]),
      gcpConfigured,
    });
  },
);

resourceRoutes.get(
  "/:resourceId/operations/:operationId/events",
  operation({
    permissions: ["viewer"],
    responseSchema:
      'resources.ts:get:"/:resourceId/operations/:operationId/events"',
    summary: "List operation events",
    response: "JSON object containing events.",
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

resourceRoutes.post(
  "/:resourceId/actions/deploy",
  operation({
    permissions: ["admin"],
    responseSchema: 'resources.ts:post:"/:resourceId/actions/deploy"',
    summary: "Request resource deployment",
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
      appId: context.req.param("resourceId"),
      expectedType: "resource",
      idempotencyKey,
      requestedBy: user.id,
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

resourceRoutes.post(
  "/:resourceId/actions/refresh-external-secrets",
  operation({
    permissions: ["admin"],
    responseSchema:
      'resources.ts:post:"/:resourceId/actions/refresh-external-secrets"',
    summary: "Redeploy a resource with current external secrets",
    idempotencyKey: true,
    response:
      "A new deployment that resolves one consistent snapshot of current external secret versions.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const result = await requestAppDeployment({
      appId: context.req.param("resourceId"),
      expectedType: "resource",
      idempotencyKey: requireIdempotencyKey(
        context.req.header("idempotency-key"),
      ),
      requestedBy: user.id,
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

resourceRoutes.post(
  "/:resourceId/actions/rollback",
  operation({
    permissions: ["admin"],
    responseSchema: 'resources.ts:post:"/:resourceId/actions/rollback"',
    summary: "Request resource rollback",
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
      appId: context.req.param("resourceId"),
      expectedType: "resource",
      idempotencyKey,
      releaseId: input.releaseId,
      requestedBy: user.id,
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

for (const action of ["backup", "restart", "start", "stop"] as const) {
  resourceRoutes.post(
    `/:resourceId/actions/${action}`,
    operation({
      permissions: ["admin"],
      responseSchema: "resources.ts:post:`/:resourceId/actions/${action}`",
      summary: `${action.charAt(0).toUpperCase() + action.slice(1)} resource`,
      ...(action === "backup" ? {} : { body: runtimeActionSchema }),
      idempotencyKey: true,
      response: "The runtime operation and whether the request was replayed.",
      status: 202,
    }),
    async (context) => {
      const user = context.get("user");
      const input =
        action === "backup" ? {} : await readJson(context, runtimeActionSchema);
      const result = await requestDeployableOperation({
        deployableId: context.req.param("resourceId"),
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

resourceRoutes.post(
  "/:resourceId/actions/restore",
  operation({
    permissions: ["admin"],
    responseSchema: 'resources.ts:post:"/:resourceId/actions/restore"',
    summary: "Request resource restore",
    body: restoreSchema,
    idempotencyKey: true,
    response: "The restore operation and whether the request was replayed.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const input = await readJson(context, restoreSchema);
    const result = await requestResourceRestore({
      ...input,
      idempotencyKey: requireIdempotencyKey(
        context.req.header("idempotency-key"),
      ),
      requestedBy: user.id,
      resourceId: context.req.param("resourceId"),
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

resourceRoutes.post(
  "/:resourceId/actions/restore-cleanup",
  operation({
    permissions: ["admin"],
    responseSchema: 'resources.ts:post:"/:resourceId/actions/restore-cleanup"',
    summary: "Request restore cleanup",
    body: restoreCleanupSchema,
    idempotencyKey: true,
    response:
      "The restore cleanup operation and whether the request was replayed.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const input = await readJson(context, restoreCleanupSchema);
    const result = await requestRestoreCleanup({
      ...input,
      idempotencyKey: requireIdempotencyKey(
        context.req.header("idempotency-key"),
      ),
      requestedBy: user.id,
      resourceId: context.req.param("resourceId"),
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);

resourceRoutes.post(
  "/:resourceId/operations/:operationId/actions/cancel",
  operation({
    permissions: ["admin"],
    responseSchema:
      'resources.ts:post:"/:resourceId/operations/:operationId/actions/cancel"',
    summary: "Cancel resource restore",
    response: "JSON object containing operation.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json({
      operation: await cancelResourceRestore({
        operationId: context.req.param("operationId"),
        resourceId: context.req.param("resourceId"),
        workspaceId: user.workspaceId,
      }),
    });
  },
);

resourceRoutes.post(
  "/:resourceId/actions/logs",
  operation({
    permissions: ["admin"],
    responseSchema: 'resources.ts:post:"/:resourceId/actions/logs"',
    summary: "Request resource operation",
    body: logsSchema,
    idempotencyKey: true,
    response: "The runtime operation and whether the request was replayed.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const input = await readJson(context, logsSchema);
    const result = await requestDeployableOperation({
      deployableId: context.req.param("resourceId"),
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
