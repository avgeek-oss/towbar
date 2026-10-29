import { operation } from "../../../http/operation.js";
import { requestPreviewDeployment } from "../../../areas/previews/manual-deployment.js";

import { Hono } from "hono";

import { requestPreviewEnvironmentCleanup } from "../../../areas/previews/cleanup.js";
import { readUuidPathParameter } from "../../../http/requests.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const previewRoutes = new Hono<TowbarHonoEnvironment>();

previewRoutes.post(
  "/:previewEnvironmentId/actions/delete",
  operation({
    permissions: ["admin"],
    responseSchema: 'previews.ts:post:"/:previewEnvironmentId/actions/delete"',
    summary: "Request preview environment cleanup",
    response: "The preview cleanup operation and its status.",
    status: 202,
    additionalStatuses: [200],
  }),
  async (context) => {
    const result = await requestPreviewEnvironmentCleanup({
      previewEnvironmentId: readUuidPathParameter(
        context.req.param("previewEnvironmentId"),
        "previewEnvironmentId",
      ),
      workspaceId: context.get("user").workspaceId,
    });
    return context.json(result, result.accepted ? 202 : 200);
  },
);

previewRoutes.post(
  "/:previewEnvironmentId/actions/deploy",
  operation({
    permissions: ["admin"],
    responseSchema: 'previews.ts:post:"/:previewEnvironmentId/actions/deploy"',
    summary: "Request preview deployment",
    response: "The preview deployment and whether the request was replayed.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json(
      await requestPreviewDeployment({
        previewEnvironmentId: readUuidPathParameter(
          context.req.param("previewEnvironmentId"),
          "previewEnvironmentId",
        ),
        workspaceId: user.workspaceId,
        requestedBy: user.id,
      }),
      202,
    );
  },
);
