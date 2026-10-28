import {
  collectsHostDockerLogs,
  isNormalizedApp,
} from "@workspace/towbar-core";
import type {
  NormalizedDeployable,
  NormalizedServer,
} from "@workspace/towbar-core";
import type { Scope } from "@workspace/towbar-access";
import { and, eq } from "drizzle-orm";
import { deployments } from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";

export function hostLogDeploymentPermissions(
  ...deployables: NormalizedDeployable[]
): Scope[] {
  return deployables.some(collectsHostDockerLogs) ? ["admin"] : ["admin"];
}

export function requireHostLogCollection(
  server: NormalizedServer,
  ...deployables: NormalizedDeployable[]
) {
  if (deployables.some(collectsHostDockerLogs) && !server.hostLogCollection)
    throw conflict(
      "An Admin must allow Docker log collection in this server's settings before deploying a collector.",
      "HOST_LOG_COLLECTION_DISABLED",
    );
}

export function rollbackHostLogConfiguration(
  app: NormalizedDeployable,
  original: NormalizedDeployable,
): NormalizedDeployable {
  if (!isNormalizedApp(app) || !isNormalizedApp(original)) return app;
  const { hostLogs: _hostLogs, ...container } = app.container;
  return {
    ...app,
    container: {
      ...container,
      ...(original.container.hostLogs
        ? {
            hostLogs: original.container.hostLogs,
            resources: original.container.resources,
            volumes: original.container.volumes,
          }
        : {}),
    },
    ...(original.container.hostLogs ? { rollout: original.rollout } : {}),
  };
}

export async function hostLogExecutionDeployables(context: {
  app: NormalizedDeployable;
  currentServerConfig: NormalizedServer;
  environment: "production" | "preview";
  kind: "deploy" | "rollback";
  rollbackRelease: { sourceDeploymentId: string } | null;
  workspaceId: string;
}) {
  const deployables = [context.app];
  let app = context.app;
  if (context.kind === "rollback") {
    if (!context.rollbackRelease)
      throw new Error("Rollback deployment is missing its release snapshot");
    const [original] = await getTowbarDatabase()
      .select({ app: deployments.appSnapshot })
      .from(deployments)
      .where(
        and(
          eq(deployments.id, context.rollbackRelease.sourceDeploymentId),
          eq(deployments.workspaceId, context.workspaceId),
        ),
      )
      .limit(1);
    if (!original) throw notFound("Release deployment");
    deployables.push(original.app);
    app = rollbackHostLogConfiguration(app, original.app);
  }
  if (
    context.environment === "preview" &&
    deployables.some(collectsHostDockerLogs)
  )
    throw conflict(
      "Host log collectors cannot run in Preview environments",
      "HOST_LOG_COLLECTION_PREVIEW_FORBIDDEN",
    );
  requireHostLogCollection(context.currentServerConfig, ...deployables);
  return { app, deployables };
}
