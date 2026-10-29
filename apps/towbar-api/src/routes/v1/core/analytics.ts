import { Hono } from "hono";
import {
  analyticsFilterOptionsQuerySchema,
  analyticsQuerySchema,
} from "@workspace/towbar-core";
import {
  getAnalyticsFilterOptions,
  getAnalyticsReport,
} from "../../../areas/analytics/service.js";
import { operation } from "../../../http/operation.js";
import { readUuidPathParameter } from "../../../http/requests.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const analyticsRoutes = new Hono<TowbarHonoEnvironment>();
analyticsRoutes.get(
  "/apps/:appId/analytics/filter-options",
  operation({
    permissions: ["viewer"],
    responseSchema: 'analytics.ts:get:"/apps/:appId/analytics/filter-options"',
    query: analyticsFilterOptionsQuerySchema,
    summary: "Find analytics filter values",
    response:
      "Matching response codes, methods, response time ranges, referring websites, countries, cities, browsers, devices, or outbound websites within retention.",
    status: 200,
  }),
  async (context) =>
    context.json({
      options: await getAnalyticsFilterOptions({
        ...analyticsFilterOptionsQuerySchema.parse(context.req.query()),
        appId: readUuidPathParameter(context.req.param("appId"), "appId"),
        workspaceId: context.get("user").workspaceId,
      }),
    }),
);
analyticsRoutes.get(
  "/apps/:appId/analytics",
  operation({
    permissions: ["viewer"],
    responseSchema: 'analytics.ts:get:"/apps/:appId/analytics"',
    query: analyticsQuerySchema,
    summary: "Read service analytics",
    response:
      "Request or pageview trends, dimensions, latency histogram, and optional browser identity estimates within retention.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await getAnalyticsReport({
        ...analyticsQuerySchema.parse(context.req.query()),
        appId: readUuidPathParameter(context.req.param("appId"), "appId"),
        workspaceId: context.get("user").workspaceId,
      }),
    ),
);
