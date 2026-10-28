import { operation } from "../../../http/operation.js";
import { Hono } from "hono";

import {
  getSystemHealth,
  runSystemHealthChecks,
} from "../../../areas/system-health/service.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const systemHealthRoutes = new Hono<TowbarHonoEnvironment>();

systemHealthRoutes.get(
  "/",
  operation({
    permissions: ["system.read"],
    responseSchema: 'system-health.ts:get:"/"',
    summary: "Get system health",
    response: "Control-plane health checks.",
    status: 200,
  }),
  async (context) =>
    context.json(await getSystemHealth(context.get("user").workspaceId)),
);

systemHealthRoutes.post(
  "/actions/check",
  operation({
    permissions: ["system.manage"],
    responseSchema: 'system-health.ts:post:"/actions/check"',
    summary: "Run system health checks",
    response: "Updated control-plane health checks.",
    status: 200,
  }),
  async (context) =>
    context.json(await runSystemHealthChecks(context.get("user").workspaceId)),
);
