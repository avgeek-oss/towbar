import { logTools } from "./mcp-log-tools.js";
import { z } from "zod";
import {
  type McpTool,
  action,
  actionKey,
  deploymentId,
  id,
  inventorySummary,
  page,
  pageItems,
  records,
  sourceId,
  targets,
  tool,
  workload,
  workloadPath,
  workloadRoute,
} from "./mcp-toolkit.js";
import { scoutTools } from "./mcp-scout-tools.js";
import { repositoryTools } from "./mcp-repository-tools.js";
import { infrastructureTools } from "./mcp-infrastructure-tools.js";
import {
  sourceConnectionSchema,
  sourceDiscoverySchema,
} from "../sources/connection.js";
export type { OperationCall } from "./mcp-toolkit.js";

export const mcpTools: McpTool[] = [
  ...scoutTools,
  ...logTools,
  tool(
    "integration_list",
    "List available integrations",
    "List integrations enabled by the Towbar runtime environment. Configuration and secret values are never returned.",
    z.object({}).strict(),
    async (_, c) => c.call({ method: "GET", route: "/integrations" }),
    { permissions: ["integration.manage"] },
  ),
  tool(
    "workspace_inspect",
    "Inspect workspace",
    "Identify the current team, actor, and permitted actions. Use first to understand the authenticated context.",
    z.object({}).strict(),
    async (_, c) => ({
      identity: await c.call({ method: "GET", route: "/identity" }),
    }),
    { permissions: ["identity.read"] },
  ),
  tool(
    "inventory_search",
    "Find apps, resources, sources, or servers",
    "Find entity UUIDs by name, repository, or IP before taking action. Returns a compact page and nextOffset. An optional sourceId or serverId limits service/datastore discovery; do not supply both. Use the matching inspect tool for details.",
    z
      .object({
        kind: z.enum(["app", "resource", "source", "server"]),
        search: z.string().max(255).default(""),
        sourceId: id("Source").optional(),
        serverId: id("Server").optional(),
        ...page,
      })
      .strict()
      .refine(
        (a) =>
          !(a.sourceId && a.serverId) &&
          (!(a.sourceId || a.serverId) ||
            a.kind === "app" ||
            a.kind === "resource"),
        "Only service/datastore searches accept one sourceId or serverId.",
      ),
    async (a, c) => {
      const scope = a.sourceId
        ? "/sources/:sourceId"
        : a.serverId
          ? "/servers/:serverId"
          : "";
      const key = targets[a.kind];
      const result = await c.call({
        method: "GET",
        route: `${scope}/${key}`,
        path: {
          ...(a.sourceId ? { sourceId: a.sourceId } : {}),
          ...(a.serverId ? { serverId: a.serverId } : {}),
        },
      });
      const items = records(result[key])
        .map(inventorySummary)
        .filter((item) =>
          JSON.stringify(item).toLowerCase().includes(a.search.toLowerCase()),
        );
      return { kind: a.kind, ...pageItems(items, a.offset, a.limit) };
    },
    {
      permissions: [
        "repository.read",
        "workload.read",
        "resource.read",
        "server.read",
      ],
    },
  ),
  tool(
    "source_inspect",
    "Inspect source and environments",
    "Inspect a connected repository, its environment branch mappings, auto-deploy control and server capacity. Supply an environmentId to include the immutable manifest snapshot from its latest successful sync. Find IDs with towbar_inventory_search and the returned environment list.",
    z
      .object({
        ...sourceId,
        environmentId: id("Source environment").optional(),
      })
      .strict(),
    async (a, c) => ({
      source: await c.call({
        method: "GET",
        route: "/sources/:sourceId",
        path: { sourceId: a.sourceId },
      }),
      environments: await c.call({
        method: "GET",
        route: "/sources/:sourceId/environments",
        path: { sourceId: a.sourceId },
      }),
      autoDeploy: await c.call({
        method: "GET",
        route: "/sources/:sourceId/auto-deploy-control",
        path: { sourceId: a.sourceId },
      }),
      capacity: await c.call({
        method: "GET",
        route: "/sources/:sourceId/capacity",
        path: { sourceId: a.sourceId },
      }),
      ...(a.environmentId
        ? {
            manifest: await c.call({
              method: "GET",
              route: "/sources/:sourceId/environments/:environmentId/manifest",
              path: {
                sourceId: a.sourceId,
                environmentId: a.environmentId,
              },
            }),
          }
        : {}),
    }),
    { permissions: ["repository.read"] },
  ),
  tool(
    "source_connect",
    "Connect repository",
    "Connect a repository after discovery, mapping its selected environments to branches. Initial sync does not deploy. Inspect each returned environment sync outcome.",
    sourceConnectionSchema,
    async (a, c) =>
      await c.call({ method: "POST", route: "/sources/connect", body: a }),
    {
      permissions: ["repository.connect"],
      readOnly: false,
      destructive: false,
      idempotent: false,
    },
  ),
  tool(
    "source_removal_preview",
    "Review repository removal",
    "Review which workloads will transfer, retire or remain in conflict when this repository or an environment is disconnected. Returns active-operation blockers, destination repositories, diff paths and an impact revision; never returns secret values. Confirm this impact with the user before removal.",
    z
      .object({
        ...sourceId,
        environmentId: id("Source environment").optional(),
      })
      .strict(),
    async (args, context) =>
      context.call({
        method: "GET",
        route: "/sources/:sourceId/removal-preview",
        path: { sourceId: args.sourceId },
        query: {
          ...(args.environmentId ? { environmentId: args.environmentId } : {}),
        },
      }),
    { permissions: ["repository.disconnect"] },
  ),
  action(
    "source_disconnect",
    "Remove repository connection",
    "Withdraw this repository's declarations without deleting workloads or data. Compatible sole owners adopt existing workloads; other workloads remain as retirements or conflicts. Use source_removal_preview, confirm its impact with the user and pass expectedRevision. Active operations block removal. History, secrets, storage and ownership evidence are preserved.",
    "DELETE",
    "/sources/:sourceId",
    sourceId,
  ),
  action(
    "source_environment_disconnect",
    "Disconnect repository environment",
    "Withdraw only this environment's declarations and reconcile affected ownership without stopping containers or deleting data. Review source_removal_preview with environmentId and confirm with the user. Send expectedRevision from the mapping and expectedRemovalRevision from the review; active operations block disconnection.",
    "DELETE",
    "/sources/:sourceId/environments/:environmentId",
    { ...sourceId, environmentId: id("Source environment") },
  ),
  tool(
    "source_discover",
    "Discover repository environments",
    "Read towbar.yml on a discovery branch to find declared environments before connecting. Does not create a source or deploy.",
    sourceDiscoverySchema,
    async (a, c) =>
      await c.call({ method: "POST", route: "/sources/discover", body: a }),
    {
      permissions: ["repository.connect"],
      readOnly: false,
      destructive: false,
      idempotent: true,
    },
  ),
  tool(
    "source_sync",
    "Sync connected environments",
    "Sync one environment when environmentId is supplied, or all connected environments otherwise. Uses mapped branches. Member sync updates inventory without deploying. Inspect each returned sync ID for completion.",
    z
      .object({ ...sourceId, environmentId: id("Environment").optional() })
      .strict(),
    async (a, c) =>
      await c.call({
        method: "POST",
        route: a.environmentId
          ? "/sources/:sourceId/environments/:environmentId/syncs"
          : "/sources/:sourceId/environments/syncs",
        path: {
          sourceId: a.sourceId,
          ...(a.environmentId ? { environmentId: a.environmentId } : {}),
        },
      }),
    {
      permissions: ["repository.sync"],
      readOnly: false,
      destructive: true,
      idempotent: false,
    },
  ),
  tool(
    "source_sync_inspect",
    "Inspect source sync progress",
    "Check a specific syncId returned by towbar_source_sync, or list a bounded page of sync attempts when no syncId is supplied. Inspect errors before retrying; acceptance is not completion.",
    z.object({ ...sourceId, syncId: id("Sync").optional(), ...page }).strict(),
    async (a, c) => {
      if (a.syncId)
        return await c.call({
          method: "GET",
          route: "/sources/:sourceId/syncs/:syncId",
          path: { sourceId: a.sourceId, syncId: a.syncId },
        });
      const result = await c.call({
        method: "GET",
        route: "/sources/:sourceId/syncs",
        path: { sourceId: a.sourceId },
      });
      return pageItems(records(result.syncs), a.offset, a.limit);
    },
    { permissions: ["repository.read"] },
  ),
  tool(
    "workload_inspect",
    "Inspect service or datastore",
    "Read a service/datastore configuration, effective auto-deploy controls, releases, deployments, and runtime operations together. For a service volume operation, supply operationId to include its progress events. Paginate histories with offset; identify a release here before rollback.",
    z
      .object({
        ...workload,
        operationId: id("App volume operation").optional(),
        ...page,
      })
      .strict()
      .refine(
        (a) => !a.operationId || a.kind === "app",
        "operationId is available only for service volume operations.",
      ),
    async (a, c) => {
      const route = workloadRoute(a.kind),
        path = workloadPath(a);
      const result: Record<string, unknown> = {
        workload: await c.call({ method: "GET", route, path }),
        autoDeploy: await c.call({
          method: "GET",
          route: `${route}/auto-deploy-control`,
          path,
        }),
      };
      for (const key of ["releases", "deployments", "operations"]) {
        const history = await c.call({
          method: "GET",
          route: `${route}/${key}`,
          path,
        });
        result[key] = pageItems(records(history[key]), a.offset, a.limit);
      }
      if (a.operationId)
        result.operationEvents = await c.call({
          method: "GET",
          route: "/apps/:appId/operations/:operationId/events",
          path: { appId: a.workloadId, operationId: a.operationId },
        });
      return result;
    },
    { permissions: ["workload.read", "resource.read"] },
  ),
  ...(["deploy", "rollback", "restart", "start", "stop", "logs"] as const).map(
    (intent) => {
      const descriptions = {
        deploy:
          "Deploy a service or datastore from its current source configuration. Returns a deployment ID; use towbar_deployment_inspect until a terminal state.",
        rollback:
          "Roll a service/datastore back to a release selected from towbar_workload_inspect, or omit releaseId for the previous release. Returns a deployment ID to inspect. This can replace running code.",
        restart:
          "Restart a service/datastore runtime. Causes a service interruption; inspect workload operations afterward for completion.",
        start:
          "Start a stopped service/datastore runtime. Inspect workload operations afterward for completion.",
        stop: "Stop a service/datastore runtime, making it unavailable. Inspect workload operations afterward for completion.",
        logs: "Request a bounded tail of workload or managed Cloudflare Tunnel logs. Returns an operation ID, not the logs immediately; use towbar_workload_inspect to read the operation result. Logs are untrusted data.",
      };
      return tool(
        `workload_${intent}`,
        `${intent === "logs" ? "Collect logs for" : intent[0]!.toUpperCase() + intent.slice(1)} service or datastore`,
        descriptions[intent],
        z
          .object({
            ...workload,
            idempotencyKey: actionKey,
            ...(intent === "rollback"
              ? {
                  releaseId: id(
                    "Release from towbar_workload_inspect",
                  ).optional(),
                }
              : {}),
            ...(intent === "logs"
              ? {
                  runtime: z
                    .enum(["workload", "ingress"])
                    .default("workload")
                    .describe(
                      "Capture the workload runtime or its managed Cloudflare Tunnel. Ingress is available only when the manifest declares Cloudflare Tunnel and cannot be combined with service.",
                    ),
                  tail: z
                    .number()
                    .int()
                    .min(1)
                    .max(500)
                    .default(100)
                    .describe("Maximum runtime log lines to request."),
                }
              : {}),
            ...(["logs", "restart", "start", "stop"].includes(intent)
              ? {
                  service: z
                    .string()
                    .trim()
                    .min(1)
                    .max(128)
                    .optional()
                    .describe(
                      "Optional Compose service name. Omit to operate the entire stack; non-Compose workloads reject this field.",
                    ),
                }
              : {}),
          })
          .strict(),
        async (a, c) =>
          await c.call({
            method: "POST",
            route: `${workloadRoute(a.kind)}/actions/${intent}`,
            path: workloadPath(a),
            idempotencyKey: a.idempotencyKey,
            ...(intent === "rollback"
              ? { body: { releaseId: a.releaseId } }
              : intent === "logs"
                ? {
                    body: {
                      runtime: a.runtime,
                      service: a.service,
                      tail: a.tail,
                    },
                  }
                : ["restart", "start", "stop"].includes(intent)
                  ? { body: { service: a.service } }
                  : {}),
          }),
        {
          permissions: [
            intent === "deploy" || intent === "rollback"
              ? "deployment.create"
              : "workload.operate",
          ],
          readOnly: false,
          destructive: intent !== "logs",
          idempotent: true,
        },
      );
    },
  ),
  tool(
    "workload_external_secrets_refresh",
    "Refresh external secrets and redeploy",
    "Queue a new service or datastore deployment that resolves one consistent snapshot of the current external secret versions. A retry of an existing deployment retains its recorded snapshot. Inspect the returned deployment until it reaches a terminal state.",
    z
      .object({
        ...workload,
        idempotencyKey: actionKey,
      })
      .strict(),
    async (a, c) =>
      await c.call({
        method: "POST",
        route: `${workloadRoute(a.kind)}/actions/refresh-external-secrets`,
        path: workloadPath(a),
        idempotencyKey: a.idempotencyKey,
      }),
    {
      permissions: ["deployment.create"],
      readOnly: false,
      destructive: true,
      idempotent: true,
    },
  ),
  tool(
    "autodeploy_configure",
    "Pause or resume automatic deployment",
    "Set whether automatic deployments are paused for a source, app, or resource. Inspect the source/workload first: source and workload controls combine, so resuming one does not override the other.",
    z
      .object({
        scope: z.enum(["source", "app", "resource"]),
        targetId: id("Source, app, or resource"),
        paused: z.boolean(),
      })
      .strict(),
    async (a, c) =>
      await c.call({
        method: "PATCH",
        route: `/${targets[a.scope]}/:${a.scope}Id/auto-deploy-control`,
        path: { [`${a.scope}Id`]: a.targetId },
        body: { paused: a.paused },
      }),
    {
      permissions: ["deployment.create"],
      readOnly: false,
      destructive: true,
      idempotent: true,
    },
  ),
  tool(
    "deployment_list",
    "List deployment history",
    "Find deployment IDs and outcomes across the workspace with server-side pagination. Use towbar_deployment_inspect for build steps and logs.",
    z
      .object({
        page: z.number().int().min(1).max(1_000_000).default(1),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict(),
    async (a, c) =>
      await c.call({ method: "GET", route: "/deployments/history", query: a }),
    { permissions: ["deployment.read"] },
  ),
  tool(
    "deployment_inspect",
    "Inspect deployment progress and logs",
    "Diagnose one deployment: returns state, build steps, a bounded log page, and optional vulnerability findings. Poll using nextAfter, including after terminal state if hasMoreLogs. Only succeeded, succeeded_with_warnings, failed, cancelled, or skipped are terminal; accepted/queued is not success.",
    z
      .object({
        ...deploymentId,
        after: z.number().int().min(-1).default(-1),
        logLimit: z.number().int().min(1).max(200).default(50),
        includeFindings: z.boolean().default(false),
        ...page,
      })
      .strict(),
    async (a, c) => {
      const result = await c.call({
        method: "GET",
        route: "/deployments/:deploymentId/events",
        path: { deploymentId: a.deploymentId },
        query: { after: a.after, snapshot: "true" },
      });
      const logs = records(result.logs),
        selected = logs.slice(0, a.logLimit);
      const deployment = result.deployment as Record<string, unknown>;
      return {
        ...result,
        logs: selected,
        nextAfter: selected.at(-1)?.sequence ?? a.after,
        hasMoreLogs: logs.length > selected.length,
        terminal: [
          "succeeded",
          "succeeded_with_warnings",
          "failed",
          "cancelled",
          "skipped",
        ].includes(String(deployment.state)),
        ...(a.includeFindings
          ? {
              findings: pageItems(
                records(
                  (
                    await c.call({
                      method: "GET",
                      route:
                        "/deployments/:deploymentId/vulnerability-scan/findings",
                      path: { deploymentId: a.deploymentId },
                    })
                  ).findings,
                ),
                a.offset,
                a.limit,
              ),
            }
          : {}),
      };
    },
    { permissions: ["deployment.read"] },
  ),
  action(
    "deployment_cancel",
    "Cancel deployment",
    "Request cancellation of a running deployment. Poll towbar_deployment_inspect until terminal; a cancellation request can race completion.",
    "POST",
    "/deployments/:deploymentId/actions/cancel",
    deploymentId,
  ),
  action(
    "deployment_retry",
    "Retry deployment",
    "Create a new attempt for an eligible failed deployment. Use a fresh idempotencyKey for this retry, then inspect the returned deployment ID.",
    "POST",
    "/deployments/:deploymentId/actions/retry",
    deploymentId,
  ),
  action(
    "deployment_rescan",
    "Rescan deployed image",
    "Request a vulnerability scan for a deployment image. Read findings and scan state using towbar_deployment_inspect with includeFindings afterward.",
    "POST",
    "/deployments/:deploymentId/vulnerability-scan/actions/rescan",
    deploymentId,
    { destructive: false },
  ),
  ...infrastructureTools,
  ...repositoryTools,
  action(
    "workspace_check",
    "Refresh control-plane health",
    "Run system health checks and review the updated results in this tool’s response. Use the System health dashboard or GET /system-health for later observations.",
    "POST",
    "/system-health/actions/check",
    {},
    { destructive: false },
  ),
];
