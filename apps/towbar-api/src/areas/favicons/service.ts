import { and, eq } from "drizzle-orm";
import { deployments } from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { notFound } from "../../http/errors.js";
import { getApp } from "../apps/queries.js";
import { cachedIcon } from "./cache.js";

type IconConfiguration = {
  faviconDomain?: string;
  domains?: { primary?: string; redirects?: Array<{ host: string }> };
};

export function appIconDomain(config: IconConfiguration) {
  return (
    config.faviconDomain ??
    config.domains?.primary ??
    config.domains?.redirects?.[0]?.host ??
    null
  );
}

export function deploymentIconDomain(deployment: {
  environment: string;
  hostname: string | null;
  appSnapshot: IconConfiguration;
}) {
  return (
    deployment.appSnapshot.faviconDomain ??
    deployment.hostname ??
    (deployment.environment === "production"
      ? appIconDomain(deployment.appSnapshot)
      : null)
  );
}

export async function getAppIcon(appId: string, workspaceId: string) {
  const app = await getApp(appId, workspaceId);
  return cachedIcon(workspaceId, appIconDomain(app.config));
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
