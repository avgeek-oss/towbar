import { logIngestRoutes } from "./logs.js";
import { monitoringIngestRoutes } from "./monitoring.js";
import { externalApiRoutes } from "./external.js";
import { mcpRoutes } from "./mcp.js";
import { Hono } from "hono";

import { coreRoutes } from "./core/index.js";
import { internalRoutes } from "./internal/index.js";
import { publicRoutes } from "./public/index.js";

import type { TowbarHonoEnvironment } from "../../http/types.js";

export const publicV1 = new Hono<TowbarHonoEnvironment>();
export const internalV1 = new Hono<TowbarHonoEnvironment>();

publicV1.route("/public", publicRoutes);
publicV1.route("/core", coreRoutes);
internalV1.route("/internal", internalRoutes);

publicV1.route("/api", externalApiRoutes);
publicV1.route("/mcp", mcpRoutes);

publicV1.route("/monitoring", monitoringIngestRoutes);

publicV1.route("/logs", logIngestRoutes);
