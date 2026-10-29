import { Hono } from "hono";

import { getPublicIntegrationCapabilities } from "../../../infrastructure/runtime-integrations.js";
import { operation } from "../../../http/operation.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const integrationRoutes = new Hono<TowbarHonoEnvironment>();

integrationRoutes.get(
  "/",
  operation({
    permissions: ["admin"],
    summary: "List environment-configured integrations",
    responseSchema: 'integrations.ts:get:"/"',
    response:
      "Configured integration capabilities and selected non-secret details. Credentials are never returned.",
    status: 200,
  }),
  (context) =>
    context.json({
      integrations: getPublicIntegrationCapabilities(),
    }),
);
