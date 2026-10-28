import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  deployments,
  integrationInstallations,
  sources,
} from "@workspace/towbar-database/schema";

import { notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { createInstallationToken } from "../github/client.js";
import { githubRequest } from "../github/request.js";

const commitSchema = z.object({
  commit: z.object({ message: z.string() }),
});

const pullRequestSchema = z.object({
  base: z.object({ ref: z.string() }),
  changed_files: z.number().int().nonnegative(),
  draft: z.boolean().nullable(),
  head: z.object({ ref: z.string() }),
  html_url: z.url(),
  merged: z.boolean(),
  number: z.number().int().positive(),
  state: z.enum(["closed", "open"]),
  title: z.string(),
  user: z.object({ login: z.string() }).nullable(),
});

export function pullRequestNumberFromRevision({
  commitMessage,
  gitRef,
}: {
  commitMessage?: string;
  gitRef?: string | null;
}) {
  const refMatch = gitRef?.match(/^refs\/pull\/(\d+)\/(?:head|merge)$/u);
  if (refMatch) return Number(refMatch[1]);

  const subject = commitMessage?.split("\n", 1)[0]?.trim();
  if (!subject) return null;
  const messageMatch =
    subject.match(/^Merge pull request #(\d+)\b/iu) ??
    subject.match(/\(#(\d+)\)\s*$/u);
  return messageMatch ? Number(messageMatch[1]) : null;
}

export async function getDeploymentSourceRevision(
  deploymentId: string,
  workspaceId: string,
) {
  const [revision] = await getTowbarDatabase()
    .select({
      commitSha: deployments.commitSha,
      gitRef: deployments.gitRef,
      installationId: integrationInstallations.externalId,
      repositoryName: sources.repositoryName,
      repositoryOwner: sources.repositoryOwner,
    })
    .from(deployments)
    .innerJoin(sources, eq(sources.id, deployments.sourceId))
    .leftJoin(
      integrationInstallations,
      eq(integrationInstallations.id, sources.integrationInstallationId),
    )
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!revision) throw notFound("Deployment");

  if (!revision.installationId)
    throw new Error("GitHub repository is missing its installation");

  const token = await createInstallationToken(revision.installationId);
  const repository = `${encodeURIComponent(revision.repositoryOwner)}/${encodeURIComponent(revision.repositoryName)}`;
  let pullRequestNumber = pullRequestNumberFromRevision({
    gitRef: revision.gitRef,
  });
  if (!pullRequestNumber) {
    const commit = commitSchema.parse(
      await githubRequest(
        `/repos/${repository}/commits/${encodeURIComponent(revision.commitSha)}`,
        { token },
      ),
    );
    pullRequestNumber = pullRequestNumberFromRevision({
      commitMessage: commit.commit.message,
    });
  }
  if (!pullRequestNumber) return { pullRequest: null };

  const pullRequest = pullRequestSchema.parse(
    await githubRequest(`/repos/${repository}/pulls/${pullRequestNumber}`, {
      token,
    }),
  );
  return {
    pullRequest: {
      author: pullRequest.user?.login ?? null,
      baseBranch: pullRequest.base.ref,
      changedFileCount: pullRequest.changed_files,
      draft: pullRequest.draft ?? false,
      headBranch: pullRequest.head.ref,
      merged: pullRequest.merged,
      number: pullRequest.number,
      state: pullRequest.state,
      title: pullRequest.title,
      url: pullRequest.html_url,
    },
  };
}
