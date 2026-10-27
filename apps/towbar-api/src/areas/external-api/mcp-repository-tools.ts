import { z } from "zod";
import {
  type McpTool,
  action,
  id,
  page,
  pageItems,
  records,
  sourceId,
  tool,
} from "./mcp-toolkit.js";

export const repositoryTools: McpTool[] = [
  tool(
    "manifest_lifecycle_list",
    "Inspect conflicts and retirements",
    "List duplicate manifest IDs, repository declarations, configuration diff paths and preserved retirements. Conflicts have no mutation action: correct Git and sync affected repositories. Use the returned workload revision when explicitly removing a retirement.",
    z
      .object({
        tab: z.enum(["conflicts", "retirements"]).optional(),
        search: z.string().max(255).optional(),
        ...page,
      })
      .strict(),
    async (args, context) =>
      context.call({
        method: "GET",
        route: "/manifest-lifecycle",
        query: args,
      }),
    { permissions: ["workload.read"] },
  ),
  action(
    "retirement_remove",
    "Permanently remove retired workload",
    "Destructive: confirm the exact manifest ID and storage loss with the user first. Removes this workload's containers, routes and volumes across associated servers; preserves history and backups. A verified Git declaration blocks a new removal request. Once queued, removal reserves the ID until cleanup finishes. Poll every returned operation. Reuse the idempotency key only for a retry of this same request.",
    "POST",
    "/retirements/:workloadId/actions/remove",
    { workloadId: id("Retired workload") },
  ),
  action(
    "source_change_github_connection",
    "Change repository GitHub connection",
    "Update an existing source after its GitHub repository transfers or changes name. The destination must be the same repository and expose all configured branches. Preserves history and settings without deploying; sync afterward. Find the destination connection ID with towbar_repository_search.",
    "POST",
    "/sources/:sourceId/actions/change-github-connection",
    sourceId,
    { destructive: false },
  ),
  tool(
    "repository_search",
    "Find available GitHub or GitLab repositories",
    "Find a repository connection and provider-specific identifier for towbar_source_connect. GitHub returns a githubInstallationId for each repository and supports an optional connectionId account filter; GitLab uses its workspace provider configuration and supports cloud or self-managed instances. For GitLab, supply integration and omit connectionId; omit integration for GitHub.",
    z
      .object({
        provider: z.enum(["github", "gitlab"]).default("github"),
        integration: z.string().trim().min(1).max(80).optional(),
        connectionId: id("GitHub connection").optional(),
        search: z.string().max(255).default(""),
        ...page,
      })
      .strict()
      .refine(
        (a) =>
          a.provider === "gitlab"
            ? Boolean(a.integration) && !a.connectionId
            : !a.integration,
        "integration is required for GitLab and must be omitted for GitHub; connectionId is only supported for GitHub.",
      ),
    async (a, c) => {
      if (a.provider === "gitlab") {
        const repositories = await c.call({
          method: "GET",
          route: "/gitlab/repositories",
          query: {
            integration: a.integration,
            search: a.search,
            page: Math.floor(a.offset / a.limit) + 1,
            perPage: a.limit,
          },
        });
        return {
          provider: "gitlab",
          integration: a.integration,
          ...repositories,
        };
      }
      const github = await c.call({
        method: "GET",
        route: "/github/installation",
      });
      const connections = records(github.connections);
      const connection = connections.length === 1 ? connections[0] : null;
      const repositories = await c.call({
        method: "GET",
        route: "/github/repositories",
        ...(a.connectionId ? { query: { connectionId: a.connectionId } } : {}),
      });
      return {
        connections,
        unavailableConnections: records(repositories.unavailableConnections),
        identityWarnings: repositories.identityWarnings ?? [],
        githubInstallationId: connection?.id ?? null,
        ...pageItems(
          records(repositories.repositories)
            .filter((item) =>
              JSON.stringify(item)
                .toLowerCase()
                .includes(a.search.toLowerCase()),
            )
            .map((item) => ({
              ...item,
              githubInstallationId: item.connectionId,
            })),
          a.offset,
          a.limit,
        ),
      };
    },
    { permissions: ["githubInstallation.read", "integration.manage"] },
  ),
  tool(
    "github_disconnect",
    "Disconnect GitHub account",
    "Disconnect one connected GitHub account, affecting only its repository syncs and deployments. Confirm the selected account with the user. Other accounts and running workloads remain unaffected.",
    z.object({ connectionId: id("GitHub connection") }).strict(),
    async (a, c) =>
      c.call({
        method: "DELETE",
        route: "/github",
        query: { connectionId: a.connectionId },
      }),
    {
      permissions: ["integration.manage"],
      readOnly: false,
      destructive: true,
      idempotent: true,
    },
  ),
  action(
    "github_retry_reporting",
    "Retry preview reporting",
    "Retry failed GitHub preview status/comment reporting. This retries reporting, not deployment; inspect preview/deployment state separately.",
    "POST",
    "/github/actions/retry-preview-reporting",
    {},
    { destructive: false },
  ),
];
