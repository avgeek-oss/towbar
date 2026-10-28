import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
} from "drizzle-orm";

import { terminalDeploymentStates } from "@workspace/towbar-core/temporal";
import {
  deployments,
  previewEnvironments,
  sources,
} from "@workspace/towbar-database/schema";

import { getTowbarDatabase } from "../../infrastructure/database.js";
import {
  createGitHubPreviewDeployment,
  updateGitHubPreviewDeployment,
} from "../github/client.js";
import { sourceProviderClient } from "../sources/repository-provider.js";
import { publishPreviewPullRequestCommentForDeployment } from "../previews/pr-comment.js";
import { emitPreviewNotification } from "../notifications/events.js";
import {
  type PreviewReportIdentity,
  deliverPreviewReport,
} from "../previews/reporting-delivery.js";

import { HttpError, serviceUnavailable } from "../../http/errors.js";

import type { DeploymentState } from "@workspace/towbar-core/temporal";

async function recordPreviewTerminalState(
  deploymentId: string,
  state: DeploymentState,
) {
  if (!terminalDeploymentStates.has(state)) return;
  const [deployment] = await getTowbarDatabase()
    .select({
      errorMessage: deployments.errorMessage,
      previewEnvironmentId: deployments.previewEnvironmentId,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!deployment?.previewEnvironmentId) return;
  const succeeded = ["succeeded", "succeeded_with_warnings"].includes(state);
  const [updated] = await getTowbarDatabase()
    .update(previewEnvironments)
    .set({
      errorMessage: succeeded ? null : deployment.errorMessage,
      status: succeeded ? "healthy" : "failed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(previewEnvironments.id, deployment.previewEnvironmentId),
        eq(previewEnvironments.latestDeploymentId, deploymentId),
        notInArray(previewEnvironments.status, ["deleting", "deleted"]),
      ),
    )
    .returning({ id: previewEnvironments.id });
  if (updated && (succeeded || state === "failed")) {
    await emitPreviewNotification(
      updated.id,
      succeeded ? "preview.ready" : "preview.failed",
    ).catch(() => undefined);
  }
}

export async function propagatePreviewDeploymentState(
  deploymentId: string,
  state: DeploymentState,
  options: { publish?: boolean } = {},
) {
  await recordPreviewTerminalState(deploymentId, state);
  if (options.publish !== false) {
    await Promise.all([
      publishPreviewDeploymentStatus(deploymentId, state).catch(
        () => undefined,
      ),
      publishPreviewPullRequestCommentForDeployment(deploymentId).catch(
        () => undefined,
      ),
    ]);
  }
}

export async function publishPreviewDeploymentStatus(
  deploymentId: string,
  _state: DeploymentState | "inactive",
) {
  // Delayed callbacks must publish persisted state rather than replaying their old state.
  const [preview] = await getTowbarDatabase()
    .select({
      sourceId: previewEnvironments.sourceId,
      pullRequestNumber: previewEnvironments.pullRequestNumber,
    })
    .from(deployments)
    .innerJoin(
      previewEnvironments,
      eq(previewEnvironments.id, deployments.previewEnvironmentId),
    )
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!preview) return;
  return await publishPreviewDeploymentReport(preview, {}, deploymentId);
}

export async function publishPreviewDeploymentReport(
  input: PreviewReportIdentity,
  options: { onlyIfDue?: boolean; force?: boolean } = {},
  changedDeploymentId?: string,
) {
  return await deliverPreviewReport(
    input,
    "deployment",
    async () => {
      const current = await getTowbarDatabase()
        .select({ id: deployments.id })
        .from(deployments)
        .innerJoin(
          previewEnvironments,
          eq(previewEnvironments.id, deployments.previewEnvironmentId),
        )
        .where(
          and(
            eq(previewEnvironments.sourceId, input.sourceId),
            eq(previewEnvironments.pullRequestNumber, input.pullRequestNumber),
            or(
              eq(deployments.id, previewEnvironments.latestDeploymentId),
              changedDeploymentId
                ? eq(deployments.id, changedDeploymentId)
                : undefined,
              and(
                isNotNull(deployments.githubDeploymentId),
                or(
                  isNull(deployments.githubDeploymentStatus),
                  ne(deployments.githubDeploymentStatus, "inactive"),
                ),
                or(
                  inArray(deployments.state, ["cancelled", "skipped"]),
                  eq(previewEnvironments.status, "deleted"),
                ),
              ),
            ),
          ),
        );
      let failure: unknown;
      const deadline = Date.now() + 50_000;
      for (const deployment of current) {
        if (Date.now() >= deadline)
          throw serviceUnavailable(
            "Preview status publication will continue on the next maintenance pass",
          );
        try {
          await publishCurrentPreviewDeploymentStatus(deployment.id);
        } catch (error) {
          failure ??= error;
          if (error instanceof HttpError && error.status === 429) throw error;
        }
      }
      if (failure) throw failure;
    },
    options,
  );
}

async function publishCurrentPreviewDeploymentStatus(deploymentId: string) {
  const [deployment] = await getTowbarDatabase()
    .select({
      app: deployments.appSnapshot,
      state: deployments.state,
      environmentStatus: previewEnvironments.status,
      commitSha: deployments.commitSha,
      gitRef: deployments.gitRef,
      githubDeploymentId: deployments.githubDeploymentId,
      githubDeploymentStatus: deployments.githubDeploymentStatus,
      hostname: deployments.hostname,
      pullRequestNumber: previewEnvironments.pullRequestNumber,
      repositoryName: sources.repositoryName,
      repositoryOwner: sources.repositoryOwner,
      sourceId: deployments.sourceId,
    })
    .from(deployments)
    .innerJoin(sources, eq(sources.id, deployments.sourceId))
    .innerJoin(
      previewEnvironments,
      eq(previewEnvironments.id, deployments.previewEnvironmentId),
    )
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.environment, "preview"),
      ),
    )
    .limit(1);
  if (!deployment?.hostname || !deployment.gitRef) return;
  const state =
    deployment.environmentStatus === "deleted" ? "inactive" : deployment.state;
  const provider = await sourceProviderClient(deployment.sourceId);
  const githubState =
    state === "inactive" ? "inactive" : previewGitHubDeploymentState(state);
  let githubDeploymentId = deployment.githubDeploymentId;
  if (githubDeploymentId && deployment.githubDeploymentStatus === githubState)
    return;
  if (githubState !== "inactive" || githubDeploymentId) {
    if (!githubDeploymentId) {
      githubDeploymentId = await createGitHubPreviewDeployment({
        appName: deployment.app.name,
        commitSha: deployment.commitSha,
        environmentUrl: `https://${deployment.hostname}`,
        installationId: provider.installationId,
        pullRequestNumber: deployment.pullRequestNumber,
        towbarDeploymentId: deploymentId,
        repositoryName: deployment.repositoryName,
        repositoryOwner: deployment.repositoryOwner,
      });
      await getTowbarDatabase()
        .update(deployments)
        .set({ githubDeploymentId, updatedAt: new Date() })
        .where(
          and(
            eq(deployments.id, deploymentId),
            isNull(deployments.githubDeploymentId),
          ),
        );
    }
    if (githubState) {
      await updateGitHubPreviewDeployment({
        deploymentId: githubDeploymentId,
        environmentUrl: `https://${deployment.hostname}`,
        installationId: provider.installationId,
        repositoryName: deployment.repositoryName,
        repositoryOwner: deployment.repositoryOwner,
        state: githubState,
      });
      await getTowbarDatabase()
        .update(deployments)
        .set({ githubDeploymentStatus: githubState })
        .where(eq(deployments.id, deploymentId));
    }
  }
}

function previewGitHubDeploymentState(state: DeploymentState) {
  switch (state) {
    case "queued":
      return "queued" as const;
    case "waiting_for_server":
    case "preparing":
    case "validating_credentials":
    case "checking_server":
    case "fetching_source":
    case "resolving_secrets":
    case "transferring":
    case "building":
    case "running_pre_deploy":
    case "starting_candidate":
    case "checking_health":
    case "configuring_routing":
    case "provisioning_tls":
    case "checking_public_endpoint":
    case "switching_traffic":
    case "running_post_deploy":
    case "cleaning_up":
      return "in_progress" as const;
    case "succeeded":
    case "succeeded_with_warnings":
      return "success" as const;
    case "failed":
      return "failure" as const;
    case "cancelled":
    case "skipped":
      return "inactive" as const;
  }
}
