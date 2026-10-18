import { updateEnvironmentAutomation } from "../../../areas/auto-deploy-controls/service.js";
import { scheduleLatestAutomaticDeploymentsForSource } from "../../../areas/apps/automatic-deployments.js";
import { Hono } from "hono";
import { z } from "zod";
import { sourceEnvironmentMappingSchema } from "@workspace/towbar-core";
import {
  connectSourceEnvironment,
  disconnectSourceEnvironment,
  getEnvironmentManifest,
  listSourceEnvironments,
  requestEnvironmentSync,
  updateEnvironmentBranch,
} from "../../../areas/sources/environments.js";

import { operation } from "../../../http/operation.js";
import { readJson, readUuidPathParameter } from "../../../http/requests.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";

const revisionSchema = z
  .object({ expectedRevision: z.string().uuid() })
  .strict();
const disconnectSchema = revisionSchema.extend({
  expectedRemovalRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
const branchSchema = revisionSchema.extend({
  branch: sourceEnvironmentMappingSchema.shape.branch,
});
export const sourceEnvironmentRoutes = new Hono<TowbarHonoEnvironment>();
sourceEnvironmentRoutes.get(
  "/",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'source-environments.ts:get:"/"',
    summary: "List source environments",
    response: "Connected source environments and branch mappings.",
    status: 200,
  }),
  async (context) =>
    context.json({
      environments: await listSourceEnvironments(
        readUuidPathParameter(context.req.param("sourceId")!, "sourceId"),
        context.get("user").workspaceId,
      ),
    }),
);

sourceEnvironmentRoutes.post(
  "/",
  operation({
    permissions: ["repository.connect"],
    responseSchema: 'source-environments.ts:post:"/"',
    summary: "Connect source environment",
    body: sourceEnvironmentMappingSchema,
    response: "Connected environment and initial sync.",
    status: 201,
  }),
  async (context) => {
    const user = context.get("user");
    const sourceId = readUuidPathParameter(
      context.req.param("sourceId")!,
      "sourceId",
    );
    const mapping = await readJson(context, sourceEnvironmentMappingSchema);
    const environment = await connectSourceEnvironment({
      ...mapping,
      sourceId,
      workspaceId: user.workspaceId,
      actorUserId: user.id,
    });
    const sync = await requestEnvironmentSync({
      sourceId,
      environmentId: environment.id,
      workspaceId: user.workspaceId,
      requestedBy: user.id,
      deployAfterSync: false,
    });
    return context.json({ environment, sync }, 201);
  },
);

sourceEnvironmentRoutes.patch(
  "/:environmentId",
  operation({
    permissions: ["repository.update"],
    responseSchema: 'source-environments.ts:patch:"/:environmentId"',
    summary: "Change environment branch",
    body: branchSchema,
    response: "Updated mapping and queued sync.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const sourceId = readUuidPathParameter(
      context.req.param("sourceId")!,
      "sourceId",
    );
    const environmentId = readUuidPathParameter(
      context.req.param("environmentId"),
      "environmentId",
    );
    const input = await readJson(context, branchSchema);
    const environment = await updateEnvironmentBranch({
      ...input,
      sourceId,
      environmentId,
      workspaceId: user.workspaceId,
      actorUserId: user.id,
    });
    const sync = await requestEnvironmentSync({
      sourceId,
      environmentId,
      workspaceId: user.workspaceId,
      requestedBy: user.id,
      deployAfterSync: false,
    });
    return context.json({ environment, sync });
  },
);

sourceEnvironmentRoutes.post(
  "/:environmentId/syncs",
  operation({
    permissions: ["repository.sync"],
    responseSchema: 'source-environments.ts:post:"/:environmentId/syncs"',
    summary: "Sync environment",
    response: "Queued environment sync.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const sync = await requestEnvironmentSync({
      sourceId: readUuidPathParameter(
        context.req.param("sourceId")!,
        "sourceId",
      ),
      environmentId: readUuidPathParameter(
        context.req.param("environmentId"),
        "environmentId",
      ),
      workspaceId: user.workspaceId,
      requestedBy: user.id,
      deployAfterSync: false,
    });
    return context.json({ sync }, 202);
  },
);

sourceEnvironmentRoutes.delete(
  "/:environmentId",
  operation({
    permissions: ["repository.disconnect"],
    responseSchema: 'source-environments.ts:delete:"/:environmentId"',
    summary: "Disconnect environment",
    body: disconnectSchema,
    response:
      "Withdraw declarations and reconcile ownership; runtime and history are preserved.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const input = await readJson(context, disconnectSchema);
    return context.json({
      environment: await disconnectSourceEnvironment({
        ...input,
        sourceId: readUuidPathParameter(
          context.req.param("sourceId")!,
          "sourceId",
        ),
        environmentId: readUuidPathParameter(
          context.req.param("environmentId"),
          "environmentId",
        ),
        workspaceId: user.workspaceId,
        actorUserId: user.id,
      }),
    });
  },
);

sourceEnvironmentRoutes.post(
  "/syncs",
  operation({
    permissions: ["repository.sync"],
    responseSchema: 'source-environments.ts:post:"/syncs"',
    summary: "Sync all connected environments",
    response: "Independent queue outcomes for each connected environment.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const sourceId = readUuidPathParameter(
      context.req.param("sourceId")!,
      "sourceId",
    );
    const environments = await listSourceEnvironments(
      sourceId,
      user.workspaceId,
    );
    const outcomes = [];
    for (const environment of environments.filter(
      (item) => !item.disconnectedAt,
    )) {
      try {
        const sync = await requestEnvironmentSync({
          sourceId,
          environmentId: environment.id,
          workspaceId: user.workspaceId,
          requestedBy: user.id,
          deployAfterSync: false,
        });
        outcomes.push({
          environmentId: environment.id,
          syncId: sync.id,
          error: null,
        });
      } catch (error) {
        outcomes.push({
          environmentId: environment.id,
          syncId: null,
          error:
            error instanceof Error ? error.message : "Sync could not be queued",
        });
      }
    }
    return context.json({ outcomes }, 202);
  },
);

sourceEnvironmentRoutes.get(
  "/:environmentId/manifest",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'source-environments.ts:get:"/:environmentId/manifest"',
    summary: "Read an environment manifest snapshot",
    response: "Files from the last successful environment sync.",
    status: 200,
  }),
  async (context) =>
    context.json({
      manifest: await getEnvironmentManifest({
        sourceId: readUuidPathParameter(
          context.req.param("sourceId")!,
          "sourceId",
        ),
        environmentId: readUuidPathParameter(
          context.req.param("environmentId"),
          "environmentId",
        ),
        workspaceId: context.get("user").workspaceId,
      }),
    }),
);

const automationSchema = revisionSchema.extend({ paused: z.boolean() });
sourceEnvironmentRoutes.patch(
  "/:environmentId/auto-deploy-control",
  operation({
    permissions: ["deployment.create"],
    body: automationSchema,
    responseSchema:
      'source-environments.ts:patch:"/:environmentId/auto-deploy-control"',
    summary: "Update environment runtime automation",
    response: "No response body.",
    status: 204,
  }),
  async (context) => {
    const sourceId = readUuidPathParameter(
      context.req.param("sourceId")!,
      "sourceId",
    );
    const environmentId = readUuidPathParameter(
      context.req.param("environmentId"),
      "environmentId",
    );
    const workspaceId = context.get("user").workspaceId;
    const body = await readJson(context, automationSchema);
    await updateEnvironmentAutomation({
      ...body,
      sourceId,
      environmentId,
      workspaceId,
    });
    if (!body.paused)
      await scheduleLatestAutomaticDeploymentsForSource({
        sourceId,
        sourceEnvironmentId: environmentId,
        workspaceId,
      });
    return context.body(null, 204);
  },
);
