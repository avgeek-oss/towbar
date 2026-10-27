import { HttpError } from "../../http/errors.js";

import type { GitHubPullRequest as RepositoryPullRequest } from "../github/client.js";

export type PreviewPullRequestDisposition =
  { action: "deploy" } | { action: "cleanup"; reason: string };

export function previewPullRequestsToReconcile(
  openPullRequestNumbers: number[],
  existingPullRequestNumbers: number[],
) {
  return [
    ...new Set([...openPullRequestNumbers, ...existingPullRequestNumbers]),
  ];
}

export function previewPullRequestDisposition(input: {
  pullRequest: RepositoryPullRequest;
  repositoryName: string;
  repositoryOwner: string;
  sourceBranches: string[];
}): PreviewPullRequestDisposition {
  const { pullRequest } = input;
  if (pullRequest.state === "closed") {
    return {
      action: "cleanup",
      reason: pullRequest.merged
        ? `Pull request #${pullRequest.number} was merged`
        : `Pull request #${pullRequest.number} was closed`,
    };
  }

  const sourceRepository = `${input.repositoryOwner}/${input.repositoryName}`;
  if (
    !pullRequest.headRepository ||
    !sameRepository(pullRequest.headRepository, sourceRepository)
  ) {
    return {
      action: "cleanup",
      reason:
        "Preview deployments are unavailable for pull requests from forks",
    };
  }
  if (!sameRepository(pullRequest.baseRepository, sourceRepository)) {
    return {
      action: "cleanup",
      reason: "The pull request no longer targets the Source repository",
    };
  }
  if (!input.sourceBranches.includes(pullRequest.baseBranch)) {
    return {
      action: "cleanup",
      reason:
        "The pull request no longer targets a connected environment with previews enabled",
    };
  }
  return { action: "deploy" };
}

function sameRepository(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

export function samePreviewPullRequestRevision(
  left: RepositoryPullRequest,
  right: RepositoryPullRequest,
) {
  return (
    left.headSha === right.headSha &&
    left.baseBranch === right.baseBranch &&
    left.state === right.state &&
    left.merged === right.merged &&
    left.draft === right.draft &&
    left.headBranch === right.headBranch &&
    left.headRepository === right.headRepository &&
    left.baseRepository === right.baseRepository
  );
}

/** Returns the skip reason for missing Preview secrets and rethrows other errors. */
export function missingPreviewSecretsReason(error: unknown) {
  if (error instanceof HttpError && error.code === "REQUIRED_SECRETS_MISSING")
    return error.publicMessage;
  throw error;
}
