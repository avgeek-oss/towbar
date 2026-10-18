import { and, eq } from "drizzle-orm";
import { deployments } from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { notFound } from "../../http/errors.js";
import { getApp } from "../apps/queries.js";
import { cachedIcon } from "./cache.js";

type IconConfiguration = {
  iconUrl?: string;
  domains?: { primary?: string; redirects?: Array<{ host: string }> };
};

export function appIconSource(config: IconConfiguration) {
  return (
    config.iconUrl ??
    config.domains?.primary ??
    config.domains?.redirects?.[0]?.host ??
    null
  );
}

export function deploymentIconSource(deployment: {
  environment: string;
  hostname: string | null;
  appSnapshot: IconConfiguration;
}) {
  return (
    deployment.appSnapshot.iconUrl ??
    deployment.hostname ??
    (deployment.environment === "production"
      ? appIconSource(deployment.appSnapshot)
      : null)
  );
}

export async function getAppIcon(
  appId: string,
  workspaceId: string,
  iconCache = cachedIcon,
) {
  const app = await getApp(appId, workspaceId);
  return iconCache(workspaceId, appIconSource(app.config));
}

export async function getDeploymentIcon(
  deploymentId: string,
  workspaceId: string,
  iconCache = cachedIcon,
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
  return iconCache(workspaceId, deploymentIconSource(deployment));
}
