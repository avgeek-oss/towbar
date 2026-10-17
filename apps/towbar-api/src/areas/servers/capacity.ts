import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { apps, serverChecks, servers } from "@workspace/towbar-database/schema";
import type {
  RuntimeCapacity,
  SystemHealthStatus,
} from "@workspace/towbar-core";
import { cloudInstanceSchema } from "@workspace/towbar-core";

import { getTowbarDatabase } from "../../infrastructure/database.js";

const runtimeMetricSchema = z
  .object({
    cpuPercent: z.number().nonnegative().nullable(),
    deployableId: z.string().uuid(),
    healthStatus: z.enum([
      "healthy",
      "none",
      "starting",
      "unhealthy",
      "unknown",
    ]),
    memoryLimitBytes: z.number().int().nonnegative().nullable(),
    memoryUsageBytes: z.number().int().nonnegative().nullable(),
    observedState: z.enum(["missing", "running", "stopped", "unknown"]),
    restartCount: z.number().int().nonnegative().nullable(),
    startedAt: z.string().datetime().nullable(),
  })
  .passthrough();

const serverResultSchema = z
  .object({
    host: z
      .object({
        instance: cloudInstanceSchema.nullish().catch(null),
        cpuLogicalCount: z.number().int().positive(),
        cpuUsagePercent: z.number().min(0).max(100),
        diskAvailableKb: z.number().nonnegative(),
        diskTotalKb: z.number().positive(),
        loadAverage1m: z.number().nonnegative(),
        memoryAvailableKb: z.number().nonnegative(),
        memoryTotalKb: z.number().positive(),
        uptimeSeconds: z.number().int().nonnegative(),
      })
      .strict(),
    runtime: z.array(runtimeMetricSchema),
  })
  .passthrough();

export async function getServerCapacity(
  workspaceId: string,
  serverId: string,
): Promise<RuntimeCapacity | null> {
  const [capacity] = await listRuntimeCapacity({ serverId, workspaceId });
  return capacity ?? null;
}

export async function listSourceCapacity(
  workspaceId: string,
  sourceId: string,
): Promise<RuntimeCapacity[]> {
  return listRuntimeCapacity({ sourceId, workspaceId });
}

async function listRuntimeCapacity({
  serverId,
  sourceId,
  workspaceId,
}: {
  serverId?: string;
  sourceId?: string;
  workspaceId: string;
}): Promise<RuntimeCapacity[]> {
  const serverScope = [
    eq(servers.workspaceId, workspaceId),
    isNull(servers.archivedAt),
  ];
  if (serverId) serverScope.push(eq(servers.id, serverId));
  if (sourceId) {
    const sourceServerIds = await getTowbarDatabase()
      .selectDistinct({ serverId: apps.serverId })
      .from(apps)
      .where(and(eq(apps.sourceId, sourceId), isNull(apps.archivedAt)));
    if (sourceServerIds.length === 0) return [];
    serverScope.push(
      inArray(
        servers.id,
        sourceServerIds.map((item) => item.serverId),
      ),
    );
  }
  const serverRows = await getTowbarDatabase()
    .select({
      id: servers.id,
      ip: servers.canonicalIp,
    })
    .from(servers)
    .where(and(...serverScope));
  if (serverRows.length === 0) return [];
  const serverIds = serverRows.map((server) => server.id);
  const [latestChecks, latestSuccessfulChecks, deployables] = await Promise.all(
    [
      getTowbarDatabase()
        .selectDistinctOn([serverChecks.serverId], {
          serverId: serverChecks.serverId,
          status: serverChecks.status,
        })
        .from(serverChecks)
        .where(inArray(serverChecks.serverId, serverIds))
        .orderBy(serverChecks.serverId, desc(serverChecks.createdAt)),
      getTowbarDatabase()
        .selectDistinctOn([serverChecks.serverId], {
          finishedAt: serverChecks.finishedAt,
          result: serverChecks.result,
          serverId: serverChecks.serverId,
        })
        .from(serverChecks)
        .where(
          and(
            inArray(serverChecks.serverId, serverIds),
            eq(serverChecks.status, "succeeded"),
          ),
        )
        .orderBy(serverChecks.serverId, desc(serverChecks.createdAt)),
      getTowbarDatabase()
        .select({
          id: apps.id,
          kind: apps.kind,
          name: apps.name,
          serverId: apps.serverId,
          sourceId: apps.sourceId,
        })
        .from(apps)
        .where(
          and(
            inArray(apps.serverId, serverIds),
            isNull(apps.archivedAt),
            ...(sourceId ? [eq(apps.sourceId, sourceId)] : []),
          ),
        ),
    ],
  );
  const latestByServer = new Map(
    latestChecks.map((check) => [check.serverId, check]),
  );
  const successfulByServer = new Map(
    latestSuccessfulChecks.map((check) => [check.serverId, check]),
  );
  const deployableById = new Map(deployables.map((item) => [item.id, item]));
  return serverRows.map((server) => {
    const latest = latestByServer.get(server.id);
    const successful = successfulByServer.get(server.id);
    const parsed = serverResultSchema.safeParse(successful?.result);
    const result = parsed.success ? parsed.data : null;
    const runtimes = (result?.runtime ?? []).flatMap((runtime) => {
      const deployable = deployableById.get(runtime.deployableId);
      if (!deployable) return [];
      return [
        {
          cpuPercent: runtime.cpuPercent,
          healthStatus: runtime.healthStatus,
          id: runtime.deployableId,
          kind: deployable.kind,
          memoryLimitBytes: runtime.memoryLimitBytes,
          memoryUsageBytes: runtime.memoryUsageBytes,
          name: deployable.name,
          observedState: runtime.observedState,
          restartCount: runtime.restartCount,
          sourceId: deployable.sourceId,
          startedAt: runtime.startedAt,
        },
      ];
    });
    const host = result?.host ?? null;
    const memoryUsedPercent = host
      ? percentage(
          host.memoryTotalKb - host.memoryAvailableKb,
          host.memoryTotalKb,
        )
      : null;
    const diskUsedPercent = host
      ? percentage(host.diskTotalKb - host.diskAvailableKb, host.diskTotalKb)
      : null;
    const checkedAt = successful?.finishedAt?.toISOString() ?? null;
    return {
      checkedAt,
      cpu: host
        ? {
            logicalCount: host.cpuLogicalCount,
            loadAverage1m: host.loadAverage1m,
            usagePercent: host.cpuUsagePercent,
          }
        : null,
      disk: host
        ? {
            availableBytes: host.diskAvailableKb * 1_024,
            totalBytes: host.diskTotalKb * 1_024,
            usedPercent: diskUsedPercent!,
          }
        : null,
      id: server.id,
      ip: server.ip,
      latestCheckStatus: latest?.status ?? null,
      memory: host
        ? {
            availableBytes: host.memoryAvailableKb * 1_024,
            totalBytes: host.memoryTotalKb * 1_024,
            usedPercent: memoryUsedPercent!,
          }
        : null,
      runtimes,
      status: classifyCapacityHealth({
        checkedAt,
        cpuUsagePercent: host?.cpuUsagePercent ?? null,
        diskUsedPercent,
        latestCheckStatus: latest?.status ?? null,
        memoryUsedPercent,
        runtimes,
      }),
      uptimeSeconds: host?.uptimeSeconds ?? null,
    };
  });
}

export function classifyCapacityHealth(input: {
  checkedAt: string | null;
  cpuUsagePercent: number | null;
  diskUsedPercent: number | null;
  latestCheckStatus: "queued" | "running" | "succeeded" | "failed" | null;
  memoryUsedPercent: number | null;
  runtimes: RuntimeCapacity["runtimes"];
}): SystemHealthStatus {
  if (input.latestCheckStatus === "failed") return "critical";
  if (!input.checkedAt) return "unknown";
  if (input.runtimes.some((runtime) => runtime.healthStatus === "unhealthy"))
    return "critical";
  if (
    (input.cpuUsagePercent ?? 0) >= 90 ||
    (input.diskUsedPercent ?? 0) >= 95 ||
    (input.memoryUsedPercent ?? 0) >= 90
  )
    return "critical";
  if (
    Date.now() - new Date(input.checkedAt).getTime() > 15 * 60_000 ||
    (input.cpuUsagePercent ?? 0) >= 70 ||
    (input.diskUsedPercent ?? 0) >= 85 ||
    (input.memoryUsedPercent ?? 0) >= 70 ||
    input.runtimes.some((runtime) => (runtime.restartCount ?? 0) >= 3)
  )
    return "attention";
  return "healthy";
}

function percentage(used: number, total: number) {
  return Math.round((used / total) * 1_000) / 10;
}
