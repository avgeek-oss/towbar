import { createPrivateKey } from "node:crypto";

import { SignJWT } from "jose";
import { z } from "zod";

import {
  getGitHubAppConfiguration,
  getGitHubAppConfigurationForInstallation,
} from "./configuration.js";
import { githubRequest } from "./request.js";
import { serviceUnavailable } from "../../http/errors.js";

type GitHubAppConfiguration = Awaited<
  ReturnType<typeof getGitHubAppConfiguration>
>;

const installationSchema = z.object({
  account: z.object({
    id: z.number().int().positive(),
    login: z.string(),
    type: z.string(),
  }),
  id: z.number().int().positive(),
  permissions: z.record(z.string(), z.string()),
  suspended_at: z.string().nullable(),
});

const installationTokenSchema = z.object({
  expires_at: z.string().datetime(),
  token: z.string().min(1),
});

const repositoriesSchema = z.object({
  repositories: z.array(
    z.object({
      default_branch: z.string(),
      full_name: z.string(),
      id: z.number().int().positive(),
      name: z.string(),
      owner: z.object({ login: z.string() }),
      private: z.boolean(),
    }),
  ),
  total_count: z.number().int().nonnegative(),
});

const gitCommitSchema = z.object({
  tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) }),
});

const gitTreeSchema = z.object({
  tree: z.array(
    z.object({
      mode: z.string().min(1),
      path: z.string().min(1),
      sha: z.string().regex(/^[a-f0-9]{40}$/u),
      type: z.enum(["blob", "commit", "tree"]),
    }),
  ),
  truncated: z.boolean(),
});

const githubDeploymentSchema = z.object({ id: z.number().int().positive() });
const githubDeploymentListSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    sha: z.string(),
    environment: z.string(),
    description: z.string().nullable(),
    payload: z.unknown(),
  }),
);
const issueCommentSchema = z.object({
  body: z.string().nullable(),
  id: z.number().int().positive(),
  performed_via_github_app: z
    .object({ id: z.number().int().positive() })
    .nullable()
    .optional(),
});
const issueCommentListSchema = z.array(issueCommentSchema);

type GitHubIssueComment = z.infer<typeof issueCommentSchema>;

const pullRequestFileListSchema = z.array(
  z.object({
    filename: z.string().min(1).max(4_096),
    previous_filename: z.string().min(1).max(4_096).optional(),
  }),
);

const pullRequestSchema = z.object({
  base: z.object({
    ref: z.string().min(1).max(255),
    repo: z.object({ full_name: z.string().min(3).max(255) }),
  }),
  changed_files: z.number().int().nonnegative(),
  draft: z.boolean().nullable(),
  head: z.object({
    ref: z.string().min(1).max(255),
    repo: z.object({ full_name: z.string().min(3).max(255) }).nullable(),
    sha: z.string().regex(/^[a-f0-9]{40}$/u),
  }),
  merged: z.boolean(),
  number: z.number().int().positive().max(2_147_483_647),
  state: z.enum(["closed", "open"]),
});
const pullRequestListSchema = z.array(
  z.object({
    number: z.number().int().positive().max(2_147_483_647),
  }),
);

export type GitHubPullRequest = {
  baseBranch: string;
  baseRepository: string;
  changedFileCount: number;
  draft: boolean;
  headBranch: string;
  headRepository: string | null;
  headSha: string;
  merged: boolean;
  number: number;
  state: "closed" | "open";
};

export async function getGitHubInstallation(
  installationId: string,
  workspaceId?: string,
) {
  const jwt = await createGitHubAppJwt({ installationId, workspaceId });
  const value = await githubRequest(`/app/installations/${installationId}`, {
    token: jwt,
  });
  return installationSchema.parse(value);
}

export async function deleteGitHubInstallation(installationId: string) {
  const jwt = await createGitHubAppJwt({ installationId });
  await githubRequest(`/app/installations/${installationId}`, {
    method: "DELETE",
    token: jwt,
  });
}

export async function listGitHubRepositories(installationId: string) {
  const token = await createInstallationToken(installationId);
  const repositories: z.infer<typeof repositoriesSchema>["repositories"] = [];
  for (let page = 1; ; page += 1) {
    const value = repositoriesSchema.parse(
      await githubRequest(
        `/installation/repositories?per_page=100&page=${page}`,
        { token },
      ),
    );
    repositories.push(...value.repositories);
    if (
      repositories.length >= value.total_count ||
      value.repositories.length < 100
    ) {
      break;
    }
  }
  return repositories.map((repository) => ({
    defaultBranch: repository.default_branch,
    fullName: repository.full_name,
    id: String(repository.id),
    name: repository.name,
    owner: repository.owner.login,
    private: repository.private,
  }));
}

export async function getGitHubRepository(input: {
  installationId: string;
  repositoryOwner: string;
  repositoryName: string;
}) {
  const token = await createInstallationToken(input.installationId);
  const repository = z
    .object({
      id: z.number().int().positive(),
      name: z.string().min(1),
      owner: z.object({ login: z.string().min(1) }),
    })
    .parse(
      await githubRequest(
        `/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}`,
        { token },
      ),
    );
  return {
    id: String(repository.id),
    name: repository.name,
    owner: repository.owner.login,
  };
}

export async function fetchGitHubRepositoryTree(input: {
  commitSha: string;
  installationId: string;
  repositoryName: string;
  repositoryOwner: string;
}) {
  const token = await createInstallationToken(input.installationId);
  const repository = `${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}`;
  const commit = gitCommitSchema.parse(
    await githubRequest(
      `/repos/${repository}/git/commits/${encodeURIComponent(input.commitSha)}`,
      { token },
    ),
  );
  const tree = gitTreeSchema.parse(
    await githubRequest(
      `/repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`,
      { token },
    ),
  );
  return {
    complete: !tree.truncated,
    entries: tree.tree
      .filter(
        (entry): entry is typeof entry & { type: "blob" | "commit" } =>
          entry.type === "blob" || entry.type === "commit",
      )
      .map(({ mode, path, sha, type }) => ({ mode, path, sha, type })),
  };
}

export async function fetchGitHubPullRequest(input: {
  installationId: string;
  pullRequestNumber: number;
  repositoryName: string;
  repositoryOwner: string;
}): Promise<GitHubPullRequest> {
  const token = await createInstallationToken(input.installationId);
  const repository = `${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}`;
  const pullRequest = pullRequestSchema.parse(
    await githubRequest(
      `/repos/${repository}/pulls/${input.pullRequestNumber}`,
      { token },
    ),
  );
  return {
    baseBranch: pullRequest.base.ref,
    baseRepository: pullRequest.base.repo.full_name,
    changedFileCount: pullRequest.changed_files,
    draft: pullRequest.draft ?? false,
    headBranch: pullRequest.head.ref,
    headRepository: pullRequest.head.repo?.full_name ?? null,
    headSha: pullRequest.head.sha,
    merged: pullRequest.merged,
    number: pullRequest.number,
    state: pullRequest.state,
  };
}

export async function fetchGitHubPullRequestChangedPaths(input: {
  changedFileCount: number;
  installationId: string;
  pullRequestNumber: number;
  repositoryName: string;
  repositoryOwner: string;
}) {
  if (input.changedFileCount === 0) return { complete: true, paths: [] };
  const token = await createInstallationToken(input.installationId);
  const repository = `${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}`;
  const paths: string[] = [];
  let fetchedFileCount = 0;
  for (let page = 1; page <= 30; page += 1) {
    const files = pullRequestFileListSchema.parse(
      await githubRequest(
        `/repos/${repository}/pulls/${input.pullRequestNumber}/files?per_page=100&page=${page}`,
        { token },
      ),
    );
    fetchedFileCount += files.length;
    for (const file of files) {
      paths.push(file.filename);
      if (file.previous_filename) paths.push(file.previous_filename);
    }
    if (files.length < 100 || fetchedFileCount >= input.changedFileCount) break;
  }
  return {
    complete: fetchedFileCount >= input.changedFileCount,
    paths,
  };
}

export async function listOpenGitHubPullRequestNumbers(input: {
  baseBranch: string;
  installationId: string;
  repositoryName: string;
  repositoryOwner: string;
}) {
  const token = await createInstallationToken(input.installationId);
  const repository = `${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}`;
  const pullRequestNumbers: number[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const pullRequests = pullRequestListSchema.parse(
      await githubRequest(
        `/repos/${repository}/pulls?state=open&base=${encodeURIComponent(input.baseBranch)}&per_page=100&page=${page}`,
        { token },
      ),
    );
    pullRequestNumbers.push(
      ...pullRequests.map((pullRequest) => pullRequest.number),
    );
    if (pullRequests.length < 100) break;
  }
  return pullRequestNumbers;
}

export async function createInstallationToken(
  installationId: string,
  configuration?: GitHubAppConfiguration,
) {
  const github =
    configuration ??
    (await getGitHubAppConfigurationForInstallation(installationId, true));
  const jwt = await createGitHubAppJwt({ installationId }, github);
  const value = installationTokenSchema.parse(
    await githubRequest(`/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      retry: true,
      token: jwt,
    }),
  );
  return value.token;
}

export async function createGitHubPreviewDeployment(
  input: {
    appName: string;
    commitSha: string;
    environmentUrl: string;
    installationId: string;
    pullRequestNumber: number;
    repositoryName: string;
    repositoryOwner: string;
    towbarDeploymentId?: string;
  },
  configuration?: GitHubAppConfiguration,
) {
  const token = await createInstallationToken(
    input.installationId,
    configuration,
  );
  const repository = `${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}`;
  const environment = `${input.appName.slice(0, 245)} (preview)`;
  const description = `Towbar Preview deployment for PR #${input.pullRequestNumber}`;
  if (input.towbarDeploymentId) {
    for (let page = 1; page <= 10; page += 1) {
      const existing = githubDeploymentListSchema.parse(
        await githubRequest(
          `/repos/${repository}/deployments?sha=${encodeURIComponent(input.commitSha)}&environment=${encodeURIComponent(environment)}&per_page=100&page=${page}`,
          { token },
        ),
      );
      const match = existing.find((deployment) => {
        const payload = deployment.payload;
        return (
          payload !== null &&
          typeof payload === "object" &&
          "managedBy" in payload &&
          payload.managedBy === "towbar" &&
          "environmentUrl" in payload &&
          payload.environmentUrl === input.environmentUrl &&
          deployment.sha === input.commitSha &&
          deployment.environment === environment &&
          deployment.description === description &&
          (!("towbarDeploymentId" in payload) ||
            payload.towbarDeploymentId === input.towbarDeploymentId)
        );
      });
      if (match) return String(match.id);
      if (existing.length < 100) break;
      if (page === 10)
        throw serviceUnavailable(
          "Could not finish reconciling GitHub preview deployments",
        );
    }
  }
  const deployment = githubDeploymentSchema.parse(
    await githubRequest(`/repos/${repository}/deployments`, {
      body: {
        auto_merge: false,
        description,
        environment,
        payload: {
          environmentUrl: input.environmentUrl,
          managedBy: "towbar",
          ...(input.towbarDeploymentId
            ? { towbarDeploymentId: input.towbarDeploymentId }
            : {}),
        },
        production_environment: false,
        ref: input.commitSha,
        required_contexts: [],
        transient_environment: true,
      },
      method: "POST",
      token,
    }),
  );
  return String(deployment.id);
}

export async function updateGitHubPreviewDeployment(
  input: {
    deploymentId: string;
    environmentUrl: string;
    installationId: string;
    repositoryName: string;
    repositoryOwner: string;
    state:
      "error" | "failure" | "inactive" | "in_progress" | "queued" | "success";
  },
  configuration?: GitHubAppConfiguration,
) {
  const token = await createInstallationToken(
    input.installationId,
    configuration,
  );
  const repository = `${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}`;
  await githubRequest(
    `/repos/${repository}/deployments/${encodeURIComponent(input.deploymentId)}/statuses`,
    {
      body: {
        // Each PR has its own lifecycle even when previews share an environment.
        auto_inactive: false,
        environment_url: input.environmentUrl,
        state: input.state,
      },
      method: "POST",
      token,
    },
  );
}

export async function upsertGitHubPullRequestComment(input: {
  body: string;
  installationId: string;
  marker: string;
  pullRequestNumber: number;
  repositoryName: string;
  repositoryOwner: string;
}) {
  const token = await createInstallationToken(input.installationId);
  const repository = `${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}`;
  const appId = (
    await getGitHubAppConfigurationForInstallation(input.installationId)
  ).appId;
  const comments: GitHubIssueComment[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageComments = issueCommentListSchema.parse(
      await githubRequest(
        `/repos/${repository}/issues/${input.pullRequestNumber}/comments?per_page=100&page=${page}`,
        { token },
      ),
    );
    comments.push(...pageComments);
    if (pageComments.length < 100) break;
  }
  const { canonical, duplicates } = classifyGitHubPullRequestComments({
    appId,
    comments,
    marker: input.marker,
  });
  let comment = canonical;
  if (!comment || comment.body !== input.body) {
    comment = issueCommentSchema.parse(
      await githubRequest(
        comment
          ? `/repos/${repository}/issues/comments/${comment.id}`
          : `/repos/${repository}/issues/${input.pullRequestNumber}/comments`,
        {
          body: { body: input.body },
          method: comment ? "PATCH" : "POST",
          token,
        },
      ),
    );
  }
  for (const duplicate of duplicates) {
    await githubRequest(
      `/repos/${repository}/issues/comments/${duplicate.id}`,
      { method: "DELETE", token },
    );
  }
  return String(comment.id);
}

export function classifyGitHubPullRequestComments(input: {
  appId: string;
  comments: GitHubIssueComment[];
  marker: string;
}) {
  const matches = input.comments
    .filter(
      (comment) =>
        comment.body?.includes(input.marker) === true &&
        String(comment.performed_via_github_app?.id) === input.appId,
    )
    .sort((left, right) => left.id - right.id);
  return {
    canonical: matches[0],
    duplicates: matches.slice(1),
  };
}

async function createGitHubAppJwt(
  input: {
    installationId: string;
    workspaceId?: string;
  },
  configuration?: GitHubAppConfiguration,
) {
  const github =
    configuration ??
    (input.workspaceId
      ? await getGitHubAppConfiguration(input.workspaceId)
      : await getGitHubAppConfigurationForInstallation(input.installationId));
  const now = Math.floor(Date.now() / 1_000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 30)
    .setIssuer(github.appId)
    .setExpirationTime(now + 9 * 60)
    .sign(createPrivateKey(github.privateKey));
}
