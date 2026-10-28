import { fetchGitHubEnvironmentSnapshot } from "../github/environment-snapshot.js";
import {
  fetchGitHubPullRequest,
  fetchGitHubPullRequestChangedPaths,
  fetchGitHubRepositoryTree,
  listOpenGitHubPullRequestNumbers,
} from "../github/client.js";
import { listRepositoryBranches as listGitHubRepositoryBranches } from "../github/branches.js";
import { and, eq } from "drizzle-orm";
import {
  integrationInstallations,
  sources,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { notFound } from "../../http/errors.js";

export type RepositoryConnection = {
  provider: "github";
  installationId: string;
  repositoryName: string;
  repositoryOwner: string;
};

export const fetchRepositoryEnvironmentSnapshot =
  fetchGitHubEnvironmentSnapshot;
export function fetchRepositoryPullRequest(
  connection: RepositoryConnection,
  pullRequestNumber: number,
) {
  return fetchGitHubPullRequest({ ...connection, pullRequestNumber });
}
export function fetchRepositoryPullRequestChangedPaths(
  connection: RepositoryConnection,
  input: { changedFileCount: number; pullRequestNumber: number },
) {
  return fetchGitHubPullRequestChangedPaths({ ...connection, ...input });
}
export function listOpenRepositoryPullRequestNumbers(
  connection: RepositoryConnection,
  baseBranch: string,
) {
  return listOpenGitHubPullRequestNumbers({ ...connection, baseBranch });
}

export async function sourceProviderClient(
  sourceId: string,
): Promise<RepositoryConnection> {
  const [source] = await getTowbarDatabase()
    .select({
      installationId: integrationInstallations.externalId,
      repositoryName: sources.repositoryName,
      repositoryOwner: sources.repositoryOwner,
    })
    .from(sources)
    .innerJoin(
      integrationInstallations,
      eq(integrationInstallations.id, sources.integrationInstallationId),
    )
    .where(
      and(
        eq(sources.id, sourceId),
        eq(sources.status, "active"),
        eq(sources.provider, "github"),
      ),
    )
    .limit(1);
  if (!source) throw notFound("Repository");
  return { ...source, provider: "github" };
}

export function fetchRepositoryTree(
  connection: RepositoryConnection,
  commitSha: string,
) {
  return fetchGitHubRepositoryTree({ ...connection, commitSha });
}

export function listRepositoryBranches(connection: RepositoryConnection) {
  return listGitHubRepositoryBranches({
    installationId: connection.installationId,
    owner: connection.repositoryOwner,
    repository: connection.repositoryName,
  });
}
