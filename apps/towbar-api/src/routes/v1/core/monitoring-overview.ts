import { Hono } from "hono";
import { getWorkspaceMonitoringSummary } from "../../../areas/monitoring/workspace-summary.js";
import {
  listWorkspaceIncidents,
  monitoringOverviewQuery,
} from "../../../areas/monitoring/workspace.js";
import {
  listWorkspaceVulnerabilityFindings,
  vulnerabilityFindingsQuery,
} from "../../../areas/vulnerability-scans/workspace.js";
import { operation } from "../../../http/operation.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const monitoringOverviewRoutes = new Hono<TowbarHonoEnvironment>();
monitoringOverviewRoutes.get(
  "/incidents",
  operation({
    permissions: ["viewer"],
    responseSchema: 'monitoring-overview.ts:get:"/incidents"',
    summary: "List workspace Scout incidents",
    query: monitoringOverviewQuery,
    response:
      "Paginated active and resolved incidents across the current workspace. Inspect details through the server incident route.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await listWorkspaceIncidents(
        context.get("user").workspaceId,
        monitoringOverviewQuery.parse(context.req.query()),
      ),
    ),
);

monitoringOverviewRoutes.get(
  "/vulnerabilities",
  operation({
    permissions: ["viewer"],
    responseSchema: 'monitoring-overview.ts:get:"/vulnerabilities"',
    summary: "List workspace vulnerability findings",
    query: vulnerabilityFindingsQuery,
    response:
      "Paginated advisories from the latest scanned image of each App, ranked by severity with app, source, and server identity, plus workspace severity totals. Resources are not image-scanned.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await listWorkspaceVulnerabilityFindings(
        context.get("user").workspaceId,
        vulnerabilityFindingsQuery.parse(context.req.query()),
      ),
    ),
);

monitoringOverviewRoutes.get(
  "/summary",
  operation({
    permissions: ["viewer"],
    responseSchema: 'monitoring-overview.ts:get:"/summary"',
    summary: "Read workspace monitoring counts",
    browserOnly: true,
    response:
      "Active incidents and critical or high findings from the latest scan of each App.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await getWorkspaceMonitoringSummary(context.get("user").workspaceId),
    ),
);
