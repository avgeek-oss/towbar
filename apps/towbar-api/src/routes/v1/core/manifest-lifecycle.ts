import { Hono } from "hono";
import { z } from "zod";
import { operation } from "../../../http/operation.js";
import { readJson } from "../../../http/requests.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";
import { listManifestLifecycle } from "../../../areas/manifest-lifecycle/queries.js";
import { removeRetiredWorkload } from "../../../areas/manifest-lifecycle/removal.js";

export const manifestLifecycleRoutes = new Hono<TowbarHonoEnvironment>();
const querySchema = z
  .object({
    tab: z.enum(["conflicts", "retirements"]).optional(),
    search: z.string().max(255).optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
manifestLifecycleRoutes.get(
  "/manifest-lifecycle",
  operation({
    permissions: ["viewer"],
    summary: "List manifest conflicts and retirements",
    query: querySchema,
    responseSchema: 'manifest-lifecycle.ts:get:"/manifest-lifecycle"',
    response:
      "Workspace and environment scoped manifest conflicts, declarations, configuration diff paths and preserved workloads. Conflicts are informational: correct Git and sync. Configuration and secret values are never returned.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await listManifestLifecycle(
        context.get("user").workspaceId,
        querySchema.parse(context.req.query()),
      ),
    ),
);
manifestLifecycleRoutes.post(
  "/retirements/:workloadId/actions/remove",
  operation({
    permissions: ["admin"],
    summary: "Permanently remove a retired workload",
    idempotencyKey: true,
    body: z
      .object({
        expectedRevision: z.iso.datetime(),
        confirmManifestId: z.string().min(1).max(63),
        reason: z.string().trim().min(1).max(500),
      })
      .strict(),
    responseSchema:
      'manifest-lifecycle.ts:post:"/retirements/:workloadId/actions/remove"',
    response:
      "Queued cleanup operations for this workload only. Removes its runtime, routes and persistent storage on every associated server. Backups and history remain. A verified declaration blocks a new removal request; an in-progress removal reserves the ID. Inspect every returned operation until terminal success.",
    status: 202,
  }),
  async (context) =>
    context.json(
      await removeRetiredWorkload({
        workspaceId: context.get("user").workspaceId,
        workloadId: context.req.param("workloadId"),
        requestedBy: context.get("user").id,
        idempotencyKey: context.req.header("idempotency-key") ?? "",
        ...(await readJson(
          context,
          z
            .object({
              expectedRevision: z.iso.datetime(),
              confirmManifestId: z.string().min(1).max(63),
              reason: z.string().trim().min(1).max(500),
            })
            .strict(),
        )),
      }),
      202,
    ),
);
