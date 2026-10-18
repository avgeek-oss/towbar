import { z } from "zod";
import {
  monitoringQuerySchema,
  monitoringSettingsSchema,
  secretEnvironmentSchema,
  secretKeySchema,
  secretMutationSchema,
  secretStageSchema,
} from "@workspace/towbar-core";
import {
  type McpTool,
  action,
  id,
  page,
  pageItems,
  records,
  resourceId,
  serverId,
  targets,
  tool,
} from "./mcp-toolkit.js";

const secretTarget = z
  .object({
    scope: z.enum(["workspace", "repository", "app", "resource"]),
    targetId: id("Secret owner; omit for workspace scope").optional(),
  })
  .refine(
    (args) =>
      args.scope === "workspace"
        ? args.targetId === undefined
        : args.targetId !== undefined,
    "targetId is required for repository/app/resource and must be omitted for workspace scope.",
  );
function secretRoute(scope: "workspace" | "repository" | "app" | "resource") {
  return scope === "workspace"
    ? "/settings/secrets"
    : `/${scope === "repository" ? "sources" : targets[scope]}/:ownerId/secrets`;
}

export const infrastructureTools: McpTool[] = [
  tool(
    "performance_inspect",
    "Inspect performance over time",
    "Read persistent server, app, or resource performance with averages, peaks, reporting freshness, and recent deployment/restart events. Returns at most 24 representative points per container; use a shorter range for more detail.",
    z
      .object({
        kind: z.enum(["server", "app", "resource"]),
        targetId: id("Server, app, or resource"),
        ...monitoringQuerySchema.shape,
      })
      .strict(),
    async (a, c) => {
      const result = await c.call({
        method: "GET",
        route: `/${targets[a.kind]}/:${a.kind}Id/metrics`,
        path: { [`${a.kind}Id`]: a.targetId },
        query: {
          range: a.range,
          ...(a.startAt ? { startAt: a.startAt } : {}),
          ...(a.endAt ? { endAt: a.endAt } : {}),
        },
      });
      const series = records(result.series).map((instance) => {
        const points = records(instance.points);
        const metrics: Record<
          string,
          { sum: number; count: number; min: number; max: number }
        > = {};
        for (const point of points)
          for (const [name, value] of Object.entries(
            (point.metrics ?? {}) as Record<
              string,
              { sum: number; count: number; min: number; max: number }
            >,
          )) {
            const old = metrics[name];
            metrics[name] = old
              ? {
                  sum: old.sum + value.sum,
                  count: old.count + value.count,
                  min: Math.min(old.min, value.min),
                  max: Math.max(old.max, value.max),
                }
              : value;
          }
        const stride = Math.max(1, Math.ceil(points.length / 24));
        return {
          ...instance,
          metrics: Object.fromEntries(
            Object.entries(metrics).map(([name, value]) => [
              name,
              {
                average: value.sum / value.count,
                minimum: value.min,
                peak: value.max,
                sampleCount: value.count,
              },
            ]),
          ),
          points: points.filter((_, index) => index % stride === 0),
          pointsSampled: stride > 1,
        };
      });
      return { ...result, series, events: records(result.events).slice(0, 20) };
    },
    { permissions: ["scout.read"] },
  ),
  tool(
    "monitoring_configure",
    "Configure enhanced monitoring",
    "Install/update Scout Agent, Towbar’s opt-in monitoring agent, change retention, or uninstall it. Installation requires explicit user acknowledgement. Uninstall revokes reporting immediately and removes services asynchronously. Shorter retention expires older data. Poll server_inspect for completion; queued does not mean online.",
    z
      .object({
        ...serverId,
        action: z.enum(["install", "uninstall", "retention"]),
        retentionDays: monitoringSettingsSchema.shape.retentionDays.optional(),
        acknowledge: z.literal(true).optional(),
      })
      .strict()
      .refine(
        (a) =>
          a.action !== "install" ||
          (a.acknowledge === true && a.retentionDays !== undefined),
        "Installation requires acknowledge=true and retentionDays",
      )
      .refine(
        (a) => a.action !== "retention" || a.retentionDays !== undefined,
        "Retention is required",
      ),
    async (a, c) =>
      c.call({
        method: a.action === "retention" ? "PATCH" : "POST",
        route: `/servers/:serverId/monitoring${a.action === "retention" ? "" : `/actions/${a.action}`}`,
        path: { serverId: a.serverId },
        ...(a.action === "uninstall"
          ? {}
          : {
              body: {
                retentionDays: a.retentionDays,
                ...(a.action === "install" ? { acknowledge: true } : {}),
              },
            }),
      }),
    {
      permissions: ["scout.configure"],
      readOnly: false,
      destructive: true,
      idempotent: false,
    },
  ),

  tool(
    "server_inspect",
    "Inspect server readiness and capacity",
    "Read server settings, capacity, recent checks, preparation attempts, monitoring, and orphan inventory together. Use before preparation or cleanup. No private credential values are returned.",
    z.object({ ...serverId, ...page }).strict(),
    async (a, c) => {
      const path = { serverId: a.serverId };
      const result: Record<string, unknown> = {
        server: await c.call({
          method: "GET",
          route: "/servers/:serverId",
          path,
        }),
      };
      for (const section of [
        "capacity",
        "monitoring",
        "checks",
        "preparations",
        "orphans",
      ]) {
        try {
          const data = await c.call({
            method: "GET",
            route: `/servers/:serverId/${section}`,
            path,
            ...(section === "checks"
              ? {
                  query: {
                    page: Math.floor(a.offset / a.limit) + 1,
                    limit: a.limit,
                  },
                }
              : {}),
          });
          result[section] = Object.fromEntries(
            Object.entries(data).map(([key, value]) => [
              key,
              Array.isArray(value) && section !== "checks"
                ? pageItems(value, a.offset, a.limit)
                : value,
            ]),
          );
        } catch {
          result[section] = { unavailable: true };
        }
      }
      return result;
    },
    { permissions: ["server.read", "scout.read"] },
  ),
  action(
    "server_register",
    "Register server",
    "Register a workspace server by IP and SSH configuration. Then configure credentials, independently verify/trust its SSH host key, and prepare it. Registration alone does not make the server ready.",
    "POST",
    "/servers",
    {},
    { destructive: false },
  ),
  action(
    "server_remove",
    "Remove server from Towbar",
    "Stop managing a server and forget stored credentials and host trust. Uninstalls monitoring before forgetting SSH access; this may return pending. Does not terminate the machine or delete running services, Docker objects, or data. Assigned workloads and active operations block removal. Inspect and clean selected orphans first if desired.",
    "DELETE",
    "/servers/:serverId",
    serverId,
  ),
  action(
    "server_configure",
    "Configure server",
    "Update server SSH settings, build concurrency, and custom-Service hostLogCollection permission. Inspect current settings and preserve supported fields; the server IP is immutable. Connectivity changes can disrupt deployments. Requires server.update. Native OTEL collection is managed separately with towbar_logs_collection_configure.",
    "PATCH",
    "/servers/:serverId",
    serverId,
  ),
  action(
    "server_credentials_update",
    "Update server credentials",
    "Set or remove a server SSH private key with the revision from towbar_server_inspect. To select an existing stored key, use the private-key verification action. Cloudflare credentials belong to the control-plane runtime configuration, not this server endpoint.",
    "PATCH",
    "/servers/:serverId/credentials",
    serverId,
  ),
  action(
    "server_trust_host",
    "Trust SSH host key",
    "Trust a server host key only after the user independently verifies its fingerprint. Never auto-trust a fingerprint simply because the server reported it.",
    "POST",
    "/servers/:serverId/host-keys/actions/trust",
    serverId,
  ),
  action(
    "server_revoke_host",
    "Revoke trusted SSH key",
    "Remove a previously trusted server host key. This can prevent subsequent SSH connections; identify hostKeyId in towbar_server_inspect first.",
    "DELETE",
    "/servers/:serverId/host-keys/:hostKeyId",
    { ...serverId, hostKeyId: id("Trusted host key") },
  ),
  action(
    "server_prepare",
    "Prepare server for workloads",
    "Install or validate server prerequisites after credentials and host trust are configured. Follow preparation attempts in towbar_server_inspect until ready or failed.",
    "POST",
    "/servers/:serverId/actions/prepare",
    serverId,
  ),
  action(
    "server_check",
    "Refresh server health",
    "Request a new health/capacity check. Inspect server checks afterward to distinguish a queued request from a completed check.",
    "POST",
    "/servers/:serverId/actions/check",
    serverId,
    { destructive: false },
  ),
  action(
    "server_cleanup",
    "Request server cleanup",
    "Request server-level cleanup of unused Towbar objects. Revalidates ownership and usage, and protects active workloads, manifest conflicts, pending retirements and shared resources. Permanent workload removal is a separate retirement action. Confirm server cleanup with the user before requesting it.",
    "POST",
    "/servers/:serverId/actions/cleanup-orphans",
    serverId,
  ),
  tool(
    "secrets_inspect",
    "Inspect secret names and revisions",
    "Read secret bindings, available workspace and repository references, and revision metadata for a workspace, repository, app, or resource. Never returns plaintext values. Read before towbar_secrets_update; use the correct environment and slot revision.",
    secretTarget
      .safeExtend({ environment: secretEnvironmentSchema.optional() })
      .strict(),
    async (a, c) =>
      await c.call({
        method: "GET",
        route: secretRoute(a.scope),
        path: a.targetId ? { ownerId: a.targetId } : {},
        query: { environment: a.environment },
      }),
    { permissions: ["secret.list", "sharedSecret.list"] },
  ),
  tool(
    "secrets_update",
    "Update environment secrets",
    "Set or clear named secret values in one environment and lifecycle stage. Clearing a YAML-declared secret keeps its declaration and marks its value as missing. Use expectedRevision from towbar_secrets_inspect (null only for an empty slot). A conflict requires rereading and reconciling changes. Never returns plaintext values.",
    secretTarget
      .safeExtend({
        environment: secretEnvironmentSchema,
        stage: secretStageSchema,
        ...secretMutationSchema.shape,
        set: z.record(secretKeySchema, z.string().max(65536)).default({}),
      })
      .strict(),
    async (a, c) =>
      await c.call({
        method: "PATCH",
        route: `${secretRoute(a.scope)}/:environment/:stage`,
        path: {
          ...(a.targetId ? { ownerId: a.targetId } : {}),
          environment: a.environment,
          stage: a.stage,
        },
        body: {
          expectedRevision: a.expectedRevision,
          set: a.set,
          delete: a.delete,
        },
      }),
    {
      permissions: ["secret.update", "sharedSecret.update"],
      readOnly: false,
      destructive: true,
      idempotent: false,
    },
  ),
  tool(
    "backup_inspect",
    "Inspect backups and restore progress",
    "For a source, page through available backups. For a resource, inspect backup assurance and operations; supply operationId to include its restore events. Use before restore and to check backup/restore completion.",
    z
      .object({
        scope: z.enum(["source", "resource"]),
        targetId: id("Source or resource"),
        operationId: id("Resource operation").optional(),
        ...page,
      })
      .strict()
      .refine(
        (a) => !a.operationId || a.scope === "resource",
        "operationId requires resource scope.",
      ),
    async (a, c) => {
      if (a.scope === "source")
        return pageItems(
          records(
            (
              await c.call({
                method: "GET",
                route: "/sources/:sourceId/backups",
                path: { sourceId: a.targetId },
              })
            ).backups,
          ),
          a.offset,
          a.limit,
        );
      const path = { resourceId: a.targetId };
      return {
        assurance: await c.call({
          method: "GET",
          route: "/resources/:resourceId/backup-assurance",
          path,
        }),
        operations: pageItems(
          records(
            (
              await c.call({
                method: "GET",
                route: "/resources/:resourceId/operations",
                path,
              })
            ).operations,
          ),
          a.offset,
          a.limit,
        ),
        ...(a.operationId
          ? {
              events: await c.call({
                method: "GET",
                route: "/resources/:resourceId/operations/:operationId/events",
                path: { ...path, operationId: a.operationId },
              }),
            }
          : {}),
      };
    },
    { permissions: ["repository.read", "resource.read"] },
  ),
  action(
    "backup_create",
    "Back up resource",
    "Request a database/resource backup. Follow the operation in towbar_backup_inspect; acceptance does not mean a recoverable backup exists.",
    "POST",
    "/resources/:resourceId/actions/backup",
    resourceId,
    { destructive: false },
  ),
  action(
    "backup_restore",
    "Restore resource backup",
    "Restore a selected backup to a resource. This can overwrite database contents. Inspect backup assurance and the target first; obtain the exact confirmation and a reason from the user. Follow progress with towbar_backup_inspect.",
    "POST",
    "/resources/:resourceId/actions/restore",
    resourceId,
  ),
  action(
    "restore_cleanup",
    "Clean up completed restore",
    "Request cleanup for a specific restore after reviewing its outcome. This removes retained restore artifacts; use towbar_backup_inspect to verify completion.",
    "POST",
    "/resources/:resourceId/actions/restore-cleanup",
    resourceId,
  ),
  action(
    "restore_cancel",
    "Cancel restore",
    "Request cancellation of an eligible resource restore. Inspect the operation with towbar_backup_inspect afterward; acceptance is not proof that the restore stopped.",
    "POST",
    "/resources/:resourceId/operations/:operationId/actions/cancel",
    { ...resourceId, operationId: id("Restore operation") },
  ),
  tool(
    "preview_list",
    "Find pull request previews",
    "List preview environments for an app or source, including IDs, URLs, and lifecycle state. Use IDs from this list for deploy/cleanup, and poll it afterward to verify the outcome.",
    z
      .object({
        scope: z.enum(["app", "source"]),
        targetId: id("App or source"),
        ...page,
      })
      .strict(),
    async (a, c) =>
      pageItems(
        records(
          (
            await c.call({
              method: "GET",
              route: `/${targets[a.scope]}/:${a.scope}Id/previews`,
              path: { [`${a.scope}Id`]: a.targetId },
            })
          ).previews,
        ),
        a.offset,
        a.limit,
      ),
    { permissions: ["workload.read", "repository.read"] },
  ),
  action(
    "preview_deploy",
    "Deploy pull request preview",
    "Request a deployment for a preview environment found by towbar_preview_list. Inspect the returned deployment ID and preview lifecycle afterward.",
    "POST",
    "/previews/:previewEnvironmentId/actions/deploy",
    { previewEnvironmentId: id("Preview environment") },
  ),
  action(
    "preview_cleanup",
    "Remove pull request preview",
    "Request removal of a preview environment and its runtime. Confirm the selected preview; poll towbar_preview_list afterward until cleanup completes or fails.",
    "POST",
    "/previews/:previewEnvironmentId/actions/delete",
    { previewEnvironmentId: id("Preview environment") },
  ),
];
