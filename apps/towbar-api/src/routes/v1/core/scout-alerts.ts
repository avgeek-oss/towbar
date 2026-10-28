import { actorAllows } from "@workspace/towbar-access";
import { Hono } from "hono";
import {
  deploymentComparisonQuerySchema,
  scoutAlertRuleSchema,
  scoutIncidentQuerySchema,
} from "@workspace/towbar-core";
import {
  deleteScoutAlertRule,
  listScoutAlertRules,
  listScoutIncidents,
  saveScoutAlertRule,
} from "../../../areas/monitoring/alert-rules.js";
import {
  getDeploymentComparison,
  listComparisonDeployments,
} from "../../../areas/monitoring/deployment-comparison.js";
import {
  incidentNotificationsQuery,
  listIncidentNotifications,
} from "../../../areas/monitoring/incident-notifications.js";
import { getScoutIncident } from "../../../areas/monitoring/incident-history.js";
import { operation } from "../../../http/operation.js";
import { readJson } from "../../../http/requests.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const scoutAlertRoutes = new Hono<TowbarHonoEnvironment>();
scoutAlertRoutes.get(
  "/",
  operation({
    permissions: ["viewer"],
    responseSchema: 'scout-alerts.ts:get:"/"',
    summary: "Inspect Scout alert rules",
    query: scoutIncidentQuerySchema.pick({ deployableId: true }),
    response: "Rules, evaluation status, and available destinations.",
    status: 200,
  }),
  async (context) => {
    return context.json({
      canManage: actorAllows(context.get("actor"), ["member"]),
      ...(await listScoutAlertRules({
        ...scoutIncidentQuerySchema
          .pick({ deployableId: true })
          .parse(context.req.query()),
        serverId: context.req.param("serverId")!,
        workspaceId: context.get("user").workspaceId,
      })),
    });
  },
);
scoutAlertRoutes.post(
  "/rules",
  operation({
    permissions: ["member"],
    responseSchema: 'scout-alerts.ts:post:"/rules"',
    summary: "Create Scout alert rule",
    body: scoutAlertRuleSchema,
    response:
      "The saved rule; notifications start only after the condition is satisfied.",
    status: 201,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json(
      {
        rule: await saveScoutAlertRule({
          serverId: context.req.param("serverId")!,
          workspaceId: user.workspaceId,
          requestedBy: user.id,
          rule: await readJson(context, scoutAlertRuleSchema),
        }),
      },
      201,
    );
  },
);
scoutAlertRoutes.put(
  "/rules/:ruleId",
  operation({
    permissions: ["member"],
    responseSchema: 'scout-alerts.ts:put:"/rules/:ruleId"',
    summary: "Update Scout alert rule",
    body: scoutAlertRuleSchema,
    response:
      "Updated rule. Changing its condition closes the prior incident without claiming recovery.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json({
      rule: await saveScoutAlertRule({
        serverId: context.req.param("serverId")!,
        ruleId: context.req.param("ruleId"),
        workspaceId: user.workspaceId,
        requestedBy: user.id,
        rule: await readJson(context, scoutAlertRuleSchema),
      }),
    });
  },
);
scoutAlertRoutes.delete(
  "/rules/:ruleId",
  operation({
    permissions: ["member"],
    responseSchema: 'scout-alerts.ts:delete:"/rules/:ruleId"',
    summary: "Delete Scout alert rule",
    response: "Stops evaluation and preserves incident history.",
    status: 204,
  }),
  async (context) => {
    const user = context.get("user");
    await deleteScoutAlertRule({
      serverId: context.req.param("serverId")!,
      ruleId: context.req.param("ruleId"),
      workspaceId: user.workspaceId,
      requestedBy: user.id,
    });
    return context.body(null, 204);
  },
);
scoutAlertRoutes.get(
  "/incidents",
  operation({
    permissions: ["viewer"],
    responseSchema: 'scout-alerts.ts:get:"/incidents"',
    summary: "List Scout incidents",
    query: scoutIncidentQuerySchema,
    response:
      "Paginated active and resolved incidents with observed values and resolution reasons.",
    status: 200,
  }),
  async (context) => {
    return context.json(
      await listScoutIncidents({
        serverId: context.req.param("serverId")!,
        workspaceId: context.get("user").workspaceId,
        ...scoutIncidentQuerySchema.parse(context.req.query()),
      }),
    );
  },
);

scoutAlertRoutes.get(
  "/incidents/:incidentId",
  operation({
    permissions: ["viewer"],
    responseSchema: 'scout-alerts.ts:get:"/incidents/:incidentId"',
    summary: "Inspect Scout incident",
    response:
      "Incident details and up to 361 metric points from the incident start through now, within retention. Includes chart limitations and the original alert condition.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await getScoutIncident({
        serverId: context.req.param("serverId")!,
        incidentId: context.req.param("incidentId"),
        workspaceId: context.get("user").workspaceId,
      }),
    ),
);

scoutAlertRoutes.get(
  "/incidents/:incidentId/notifications",
  operation({
    permissions: ["viewer"],
    responseSchema:
      'scout-alerts.ts:get:"/incidents/:incidentId/notifications"',
    summary: "List incident notification deliveries",
    browserOnly: true,
    query: incidentNotificationsQuery,
    response:
      "Paginated delivery status for this incident, including destination, queued and delivered times, and attempt counts.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await listIncidentNotifications({
        serverId: context.req.param("serverId")!,
        incidentId: context.req.param("incidentId"),
        workspaceId: context.get("user").workspaceId,
        ...incidentNotificationsQuery.parse(context.req.query()),
      }),
    ),
);

export const scoutComparisonRoutes = new Hono<TowbarHonoEnvironment>();
scoutComparisonRoutes.get(
  "/workloads/:deployableId/comparison-deployments",
  operation({
    permissions: ["viewer"],
    responseSchema:
      'scout-alerts.ts:get:"/workloads/:deployableId/comparison-deployments"',
    summary: "List deployments available for comparison",
    response:
      "The latest 100 successful deployments for this workload, including environment and commit.",
    status: 200,
  }),
  async (context) => {
    return context.json({
      deployments: await listComparisonDeployments({
        deployableId: context.req.param("deployableId"),
        workspaceId: context.get("user").workspaceId,
      }),
    });
  },
);
scoutComparisonRoutes.get(
  "/workloads/:deployableId/deployment-comparison",
  operation({
    permissions: ["viewer"],
    responseSchema:
      'scout-alerts.ts:get:"/workloads/:deployableId/deployment-comparison"',
    summary: "Compare deployment performance",
    query: deploymentComparisonQuerySchema,
    response:
      "Equal relative observation windows, aligned metrics, sample coverage, changes and comparison limitations.",
    status: 200,
  }),
  async (context) => {
    return context.json(
      await getDeploymentComparison({
        deployableId: context.req.param("deployableId"),
        workspaceId: context.get("user").workspaceId,
        ...deploymentComparisonQuerySchema.parse(context.req.query()),
      }),
    );
  },
);
