import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";

import {
  apps,
  deployableRuntimeStates,
  servers,
  sourceEnvironments,
} from "@workspace/towbar-database/schema";

import { notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";

export async function listApps(workspaceId: string, sourceId?: string) {
  return await listDeployables(workspaceId, sourceId, "app");
}

export async function listResources(workspaceId: string, sourceId?: string) {
  return await listDeployables(workspaceId, sourceId, "resource");
}

async function listDeployables(
  workspaceId: string,
  sourceId: string | undefined,
  type: "app" | "resource",
) {
  const appRows = await getTowbarDatabase()
    .select({
      archivedAt: apps.archivedAt,
      manifestState: apps.manifestState,
      config: apps.config,
      createdAt: apps.createdAt,
      description: apps.description,
      entityId: apps.entityId,
      environment: {
        id: sourceEnvironments.id,
        name: sourceEnvironments.name,
        branch: sourceEnvironments.branch,
        disconnectedAt: sourceEnvironments.disconnectedAt,
        previewsEnabled: sourceEnvironments.previewsEnabled,
      },
      id: apps.id,
      kind: apps.kind,
      manifestId: apps.manifestId,
      name: apps.name,
      runtimeState: {
        checkedAt: deployableRuntimeStates.checkedAt,
        desiredState: deployableRuntimeStates.desiredState,
        driftReasons: deployableRuntimeStates.driftReasons,
        driftStatus: deployableRuntimeStates.driftStatus,
        healthStatus: deployableRuntimeStates.healthStatus,
        ingressContainerName: deployableRuntimeStates.ingressContainerName,
        ingressImage: deployableRuntimeStates.ingressImage,
        ingressRestartCount: deployableRuntimeStates.ingressRestartCount,
        ingressStatus: deployableRuntimeStates.ingressStatus,
        observedContainerName: deployableRuntimeStates.observedContainerName,
        observedImage: deployableRuntimeStates.observedImage,
        observedState: deployableRuntimeStates.observedState,
      },
      serverIp: servers.canonicalIp,
      serverPreparedAt: servers.preparedAt,
      serverPreparedConfigDigest: servers.preparedConfigDigest,
      serverConfigDigest: servers.configDigest,
      sourceId: apps.sourceId,
      sourceRevision: apps.sourceRevision,
      updatedAt: apps.updatedAt,
    })
    .from(apps)
    .innerJoin(servers, eq(servers.id, apps.serverId))
    .leftJoin(
      sourceEnvironments,
      and(
        eq(sourceEnvironments.id, apps.sourceEnvironmentId),
        eq(sourceEnvironments.sourceId, apps.sourceId),
      ),
    )
    .leftJoin(
      deployableRuntimeStates,
      eq(deployableRuntimeStates.appId, apps.id),
    )
    .where(
      and(
        sourceId
          ? and(eq(apps.workspaceId, workspaceId), eq(apps.sourceId, sourceId))
          : eq(apps.workspaceId, workspaceId),
        isNull(apps.archivedAt),
        isNull(servers.archivedAt),
        type === "app"
          ? inArray(apps.kind, ["app", "compose"])
          : notInArray(apps.kind, ["app", "compose"]),
      ),
    )
    .orderBy(desc(apps.updatedAt));

  return appRows.map((app) => {
    const {
      serverConfigDigest,
      serverPreparedAt,
      serverPreparedConfigDigest,
      ...publicApp
    } = app;
    return {
      ...publicApp,
      runtimeState: normalizeRuntimeState(app.runtimeState),
      serverReady:
        Boolean(serverPreparedAt) &&
        serverPreparedConfigDigest === serverConfigDigest,
    };
  });
}

export async function getApp(appId: string, workspaceId: string) {
  return await getDeployable(appId, workspaceId, "app");
}

export async function getResource(resourceId: string, workspaceId: string) {
  return await getDeployable(resourceId, workspaceId, "resource");
}

async function getDeployable(
  appId: string,
  workspaceId: string,
  type: "app" | "resource",
) {
  const [app] = await getTowbarDatabase()
    .select({
      archivedAt: apps.archivedAt,
      manifestState: apps.manifestState,
      config: apps.config,
      createdAt: apps.createdAt,
      description: apps.description,
      entityId: apps.entityId,
      environment: {
        id: sourceEnvironments.id,
        name: sourceEnvironments.name,
        branch: sourceEnvironments.branch,
        disconnectedAt: sourceEnvironments.disconnectedAt,
        previewsEnabled: sourceEnvironments.previewsEnabled,
      },
      id: apps.id,
      kind: apps.kind,
      manifestId: apps.manifestId,
      name: apps.name,
      runtimeState: {
        checkedAt: deployableRuntimeStates.checkedAt,
        desiredState: deployableRuntimeStates.desiredState,
        driftReasons: deployableRuntimeStates.driftReasons,
        driftStatus: deployableRuntimeStates.driftStatus,
        healthStatus: deployableRuntimeStates.healthStatus,
        ingressContainerName: deployableRuntimeStates.ingressContainerName,
        ingressImage: deployableRuntimeStates.ingressImage,
        ingressRestartCount: deployableRuntimeStates.ingressRestartCount,
        ingressStatus: deployableRuntimeStates.ingressStatus,
        observedContainerName: deployableRuntimeStates.observedContainerName,
        observedImage: deployableRuntimeStates.observedImage,
        observedState: deployableRuntimeStates.observedState,
      },
      serverId: apps.serverId,
      serverConfig: servers.config,
      serverIp: servers.canonicalIp,
      serverPreparedAt: servers.preparedAt,
      serverPreparedConfigDigest: servers.preparedConfigDigest,
      serverConfigDigest: servers.configDigest,
      sourceId: apps.sourceId,
      sourceRevision: apps.sourceRevision,
      updatedAt: apps.updatedAt,
    })
    .from(apps)
    .innerJoin(servers, eq(servers.id, apps.serverId))
    .leftJoin(
      sourceEnvironments,
      and(
        eq(sourceEnvironments.id, apps.sourceEnvironmentId),
        eq(sourceEnvironments.sourceId, apps.sourceId),
      ),
    )
    .leftJoin(
      deployableRuntimeStates,
      eq(deployableRuntimeStates.appId, apps.id),
    )
    .where(
      and(
        eq(apps.id, appId),
        eq(apps.workspaceId, workspaceId),
        isNull(apps.archivedAt),
        isNull(servers.archivedAt),
        type === "app"
          ? inArray(apps.kind, ["app", "compose"])
          : notInArray(apps.kind, ["app", "compose"]),
      ),
    )
    .limit(1);
  if (!app) throw notFound(type === "app" ? "App" : "Resource");
  const {
    serverConfig,
    serverConfigDigest,
    serverPreparedAt,
    serverPreparedConfigDigest,
    ...publicApp
  } = app;
  return {
    ...publicApp,
    runtimeState: normalizeRuntimeState(app.runtimeState),
    serverReady:
      Boolean(serverPreparedAt) &&
      serverPreparedConfigDigest === serverConfigDigest,
    ...(type === "resource"
      ? {
          serverSsh: {
            port: serverConfig.ssh.port,
            username: serverConfig.ssh.username,
          },
        }
      : {}),
  };
}

function normalizeRuntimeState(
  runtimeState: {
    checkedAt: Date | null;
    desiredState: "running" | "stopped" | null;
    driftReasons: string[] | null;
    driftStatus: "drifted" | "in_sync" | "unknown" | null;
    healthStatus:
      "healthy" | "none" | "starting" | "unhealthy" | "unknown" | null;
    ingressContainerName: string | null;
    ingressImage: string | null;
    ingressRestartCount: number | null;
    ingressStatus:
      | "disabled"
      | "missing"
      | "ready"
      | "reconnecting"
      | "stopped"
      | "unknown"
      | null;
    observedContainerName: string | null;
    observedImage: string | null;
    observedState: "missing" | "running" | "stopped" | "unknown" | null;
  } | null,
) {
  if (!runtimeState) {
    return {
      checkedAt: null,
      desiredState: "running" as const,
      driftReasons: [],
      driftStatus: "unknown" as const,
      healthStatus: "unknown" as const,
      ingressContainerName: null,
      ingressImage: null,
      ingressRestartCount: null,
      ingressStatus: "unknown" as const,
      observedContainerName: null,
      observedImage: null,
      observedState: "unknown" as const,
    };
  }
  return {
    ...runtimeState,
    desiredState: runtimeState.desiredState ?? "running",
    driftReasons: runtimeState.driftReasons ?? [],
    driftStatus: runtimeState.driftStatus ?? "unknown",
    healthStatus: runtimeState.healthStatus ?? "unknown",
    ingressStatus: runtimeState.ingressStatus ?? "unknown",
    observedState: runtimeState.observedState ?? "unknown",
  };
}
