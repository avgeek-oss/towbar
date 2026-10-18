import {
  changeGitHubConnectionSchema,
  changeSourceGitHubConnection,
} from "../../../areas/sources/github-connection.js";
import { actorAllows } from "@workspace/towbar-access";
import { sourceConnectionRoutes } from "./source-connection.js";
import { sourceEnvironmentRoutes } from "./source-environments.js";
import { filterSources, sourceFilters } from "@workspace/towbar-core/inventory";
import { operation } from "../../../http/operation.js";
import { Hono } from "hono";

import {
  deleteSource,
  getSource,
  getSourceSync,
  listSourceSyncs,
  listSources,
} from "../../../areas/sources/service.js";
import { listApps, listResources } from "../../../areas/apps/service.js";
import { listDeployments } from "../../../areas/deployments/service.js";
import { listSourceCapacity } from "../../../areas/servers/capacity.js";
import { listSourceBackups } from "../../../areas/resource-operations/service.js";
import { listPreviewEnvironments } from "../../../areas/previews/service.js";
import {
  listRepositoryBranches,
  sourceProviderClient,
} from "../../../areas/sources/repository-provider.js";

import { readJson } from "../../../http/requests.js";
import { autoDeployControlPatchSchema } from "./auto-deploy-control-requests.js";
import {
  getSourceAutoDeployControl,
  updateSourceAutoDeployControl,
} from "../../../areas/auto-deploy-controls/service.js";
import { wakeMaintenanceWorkflow } from "../../../infrastructure/temporal.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const sourceRoutes = new Hono<TowbarHonoEnvironment>();
sourceRoutes.route("/", sourceConnectionRoutes);
sourceRoutes.route("/:sourceId/environments", sourceEnvironmentRoutes);

sourceRoutes.get(
  "/",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/"',
    query: sourceFilters,
    summary: "List sources",
    response: "JSON object containing sources.",
    status: 200,
  }),
  async (context) => {
    const result = filterSources(
      await listSources(context.get("user").workspaceId),
      sourceFilters.parse(context.req.query()),
    );
    return context.json({ sources: result.items, counts: result.counts });
  },
);

sourceRoutes.get(
  "/:sourceId",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId"',
    summary: "Get source",
    response: "JSON object containing canManageSource, source.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json({
      canManageSource: actorAllows(context.get("actor"), ["repository.update"]),
      source: await getSource(context.req.param("sourceId"), user.workspaceId),
    });
  },
);

sourceRoutes.get(
  "/:sourceId/branches",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/branches"',
    summary: "List repository branches",
    response: "Branch names visible through the repository connection.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const sourceId = context.req.param("sourceId");
    await getSource(sourceId, user.workspaceId);
    return context.json({
      branches: await listRepositoryBranches(
        await sourceProviderClient(sourceId),
      ),
    });
  },
);

sourceRoutes.get(
  "/:sourceId/auto-deploy-control",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/auto-deploy-control"',
    summary: "Get source auto deploy control",
    response: "JSON object containing autoDeploy, canManageAutoDeploy.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json({
      autoDeploy: await getSourceAutoDeployControl(
        context.req.param("sourceId"),
        user.workspaceId,
      ),
      canManageAutoDeploy: actorAllows(context.get("actor"), [
        "deployment.create",
      ]),
    });
  },
);

sourceRoutes.patch(
  "/:sourceId/auto-deploy-control",
  operation({
    permissions: ["deployment.create"],
    responseSchema: 'sources.ts:patch:"/:sourceId/auto-deploy-control"',
    summary: "Update source auto deploy control",
    body: autoDeployControlPatchSchema,
    response: "JSON object containing autoDeploy, canManageAutoDeploy.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const sourceId = context.req.param("sourceId");
    const result = await updateSourceAutoDeployControl({
      ...(await readJson(context, autoDeployControlPatchSchema)),
      sourceId,
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

sourceRoutes.get(
  "/:sourceId/apps",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/apps"',
    summary: "List source apps",
    response: "JSON object containing apps.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    await getSource(context.req.param("sourceId"), user.workspaceId);
    return context.json({
      apps: await listApps(user.workspaceId, context.req.param("sourceId")),
    });
  },
);

sourceRoutes.get(
  "/:sourceId/resources",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/resources"',
    summary: "List source resources",
    response: "JSON object containing resources.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    await getSource(context.req.param("sourceId"), user.workspaceId);
    return context.json({
      resources: await listResources(
        user.workspaceId,
        context.req.param("sourceId"),
      ),
    });
  },
);

sourceRoutes.get(
  "/:sourceId/capacity",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/capacity"',
    summary: "List source capacity",
    response: "JSON object containing capacities.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const sourceId = context.req.param("sourceId");
    await getSource(sourceId, user.workspaceId);
    return context.json({
      capacities: await listSourceCapacity(user.workspaceId, sourceId),
    });
  },
);

sourceRoutes.get(
  "/:sourceId/deployments",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/deployments"',
    summary: "List source deployments",
    response: "JSON object containing deployments.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    await getSource(context.req.param("sourceId"), user.workspaceId);
    return context.json({
      deployments: await listDeployments(
        user.workspaceId,
        context.req.param("sourceId"),
      ),
    });
  },
);

sourceRoutes.get(
  "/:sourceId/backups",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/backups"',
    summary: "List source backups",
    response: "JSON object containing backups.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    await getSource(context.req.param("sourceId"), user.workspaceId);
    return context.json({
      backups: await listSourceBackups(
        context.req.param("sourceId"),
        user.workspaceId,
      ),
    });
  },
);

sourceRoutes.get(
  "/:sourceId/previews",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/previews"',
    summary: "List source previews",
    response: "JSON object containing previews.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    await getSource(context.req.param("sourceId"), user.workspaceId);
    return context.json({
      previews: await listPreviewEnvironments({
        sourceId: context.req.param("sourceId"),
        workspaceId: user.workspaceId,
      }),
    });
  },
);

sourceRoutes.delete(
  "/:sourceId",
  operation({
    permissions: ["repository.disconnect"],
    responseSchema: 'sources.ts:delete:"/:sourceId"',
    summary: "Remove disconnected repository",
    response:
      "No response body. Removes a disconnected repository with no retained workloads or active operations from the active list. History and ownership records are preserved; reconnecting reuses the repository.",
    status: 204,
  }),
  async (context) => {
    const user = context.get("user");
    await deleteSource(context.req.param("sourceId"), user.workspaceId);
    return context.body(null, 204);
  },
);

sourceRoutes.get(
  "/:sourceId/syncs",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/syncs"',
    summary: "List source syncs",
    response: "JSON object containing syncs.",
    status: 200,
  }),
  async (context) =>
    context.json({
      syncs: await listSourceSyncs(
        context.req.param("sourceId"),
        context.get("user").workspaceId,
      ),
    }),
);

sourceRoutes.get(
  "/:sourceId/syncs/:syncId",
  operation({
    permissions: ["repository.read"],
    responseSchema: 'sources.ts:get:"/:sourceId/syncs/:syncId"',
    summary: "Get source sync",
    response: "JSON object containing sync.",
    status: 200,
  }),
  async (context) =>
    context.json({
      sync: await getSourceSync(
        context.req.param("sourceId"),
        context.req.param("syncId"),
        context.get("user").workspaceId,
      ),
    }),
);

sourceRoutes.post(
  "/:sourceId/actions/change-github-connection",
  operation({
    permissions: ["repository.update"],
    summary: "Change GitHub repository connection",
    responseSchema:
      'sources.ts:post:"/:sourceId/actions/change-github-connection"',
    body: changeGitHubConnectionSchema,
    response:
      "The existing source with its verified GitHub repository connection updated.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await changeSourceGitHubConnection({
        ...(await readJson(context, changeGitHubConnectionSchema)),
        sourceId: context.req.param("sourceId"),
        workspaceId: context.get("user").workspaceId,
        actorUserId: context.get("user").id,
      }),
    ),
);
