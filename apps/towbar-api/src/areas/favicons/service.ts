import { and, eq } from "drizzle-orm";
import { deployments } from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { notFound } from "../../http/errors.js";
import { getApp } from "../apps/queries.js";
import { cachedIcon } from "./cache.js";

export function deploymentIconDomain(deployment: {
  environment: string;
  hostname: string | null;
  appSnapshot: {
    domains?: { primary?: string; redirects?: Array<{ host: string }> };
  };
}) {
  return (
    deployment.hostname ??
    (deployment.environment === "production"
      ? (deployment.appSnapshot.domains?.primary ??
        deployment.appSnapshot.domains?.redirects?.[0]?.host ??
        null)
      : null)
  );
}

export async function getAppIcon(appId: string, workspaceId: string) {
  const app = await getApp(appId, workspaceId);
  return cachedIcon(
    workspaceId,
    app.config.domains?.primary ??
      app.config.domains?.redirects[0]?.host ??
      null,
  );
}

export async function getDeploymentIcon(
  deploymentId: string,
  workspaceId: string,
) {
  const [deployment] = await getTowbarDatabase()
    .select({
      hostname: deployments.hostname,
      environment: deployments.environment,
      appSnapshot: deployments.appSnapshot,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!deployment) throw notFound("Deployment");
  return cachedIcon(workspaceId, deploymentIconDomain(deployment));
}
