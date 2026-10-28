import { internalLogCollectorRoutes } from "./log-collectors.js";
import { internalTransactionalEmailRoutes } from "./transactional-emails.js";
import { internalMonitoringRoutes } from "./monitoring.js";
import { Hono } from "hono";

import { requireSignedInternalRequest } from "../../../http/internal-authentication.js";
import { internalDeploymentRoutes } from "./deployments.js";
import { internalMaintenanceRoutes } from "./maintenance.js";
import { internalNotificationRoutes } from "./notifications.js";
import { internalPreviewRoutes } from "./previews.js";
import { internalResourceOperationRoutes } from "./resource-operations.js";
import { internalVulnerabilityScanRoutes } from "./vulnerability-scans.js";
import { internalServerCheckRoutes } from "./server-checks.js";
import { internalServerPreparationRoutes } from "./server-preparations.js";
import { internalSourceSyncRoutes } from "./source-syncs.js";

export const internalRoutes = new Hono();

internalRoutes.use("*", requireSignedInternalRequest);
internalRoutes.get("/health", (context) => context.json({ status: "ok" }));
internalRoutes.route("/source-syncs", internalSourceSyncRoutes);
internalRoutes.route("/deployments", internalDeploymentRoutes);
internalRoutes.route("/server-checks", internalServerCheckRoutes);
internalRoutes.route("/server-preparations", internalServerPreparationRoutes);
internalRoutes.route("/resource-operations", internalResourceOperationRoutes);
internalRoutes.route("/vulnerability-scans", internalVulnerabilityScanRoutes);
internalRoutes.route("/maintenance", internalMaintenanceRoutes);
internalRoutes.route("/notifications", internalNotificationRoutes);
internalRoutes.route("/previews", internalPreviewRoutes);

internalRoutes.route("/monitoring", internalMonitoringRoutes);

internalRoutes.route("/transactional-emails", internalTransactionalEmailRoutes);

internalRoutes.route("/log-collectors", internalLogCollectorRoutes);
