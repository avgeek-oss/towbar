import { sessionUser } from "../../../http/session-user.js";
import { getWorkspaceRepositoryBranches } from "../../../areas/github/branches.js";
import { operation } from "../../../http/operation.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  completeInstallation,
  createInstallationUrl,
  disconnectGitHub,
  getGitHubConnectionStatuses,
  getGitHubConnections,
  getWorkspaceGitHubRepositories,
} from "../../../areas/github/service.js";
import { getGitHubAppConfigurationMetadata } from "../../../areas/github/configuration.js";
import { retryFailedPreviewReporting } from "../../../areas/previews/reporting-retry.js";
import { getPreviewReportingHealth } from "../../../areas/previews/reporting-state.js";
import { readJson } from "../../../http/requests.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

const completeSchema = z
  .object({
    installationId: z.string().regex(/^\d+$/u),
    state: z.string().min(20).max(4_096),
  })
  .strict();

const connectionQuery = z
  .object({ connectionId: z.string().uuid().optional() })
  .strict();

export const githubRoutes = new Hono<TowbarHonoEnvironment>();

githubRoutes.get(
  "/",
  operation({
    permissions: ["admin"],
    responseSchema: 'github.ts:get:"/"',
    summary: "Get GitHub integration",
    response:
      "JSON object containing configuration, connections, and previewReporting.",
    status: 200,
  }),
  async (context) => {
    const workspaceId = context.get("user").workspaceId;
    const [configuration, connections, previewReporting] = await Promise.all([
      getGitHubAppConfigurationMetadata(workspaceId),
      getGitHubConnectionStatuses(workspaceId),
      getPreviewReportingHealth(workspaceId),
    ]);
    return context.json({
      canManage: context.get("user").workspaceRole === "admin",
      configuration,
      connections,
      connection: connections.length === 1 ? connections[0] : null,
      previewReporting,
    });
  },
);

githubRoutes.post(
  "/actions/retry-preview-reporting",
  operation({
    permissions: ["admin"],
    responseSchema: 'github.ts:post:"/actions/retry-preview-reporting"',
    summary: "Retry failed preview reporting",
    response: "The number of preview reports queued for retry.",
    status: 200,
  }),
  async (context) => {
    const result = await retryFailedPreviewReporting(
      context.get("user").workspaceId,
    );
    return context.json(result);
  },
);

githubRoutes.post(
  "/actions/installation-url",
  operation({
    permissions: ["admin"],
    responseSchema: 'github.ts:post:"/actions/installation-url"',
    summary: "Create installation URL",
    browserOnly: true,
    response: "JSON object containing url.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const url = await createInstallationUrl({
      userId: sessionUser(context).id,
      workspaceId: user.workspaceId,
    });
    return context.json({ url });
  },
);

githubRoutes.post(
  "/actions/complete-installation",
  operation({
    permissions: ["admin"],
    responseSchema: 'github.ts:post:"/actions/complete-installation"',
    summary: "Complete installation",
    browserOnly: true,
    body: completeSchema,
    response: "JSON object containing installation.",
    status: 201,
  }),
  async (context) => {
    const input = await readJson(context, completeSchema);
    const user = context.get("user");
    const installation = await completeInstallation({
      ...input,
      userId: sessionUser(context).id,
      workspaceId: user.workspaceId,
    });
    return context.json({ installation }, 201);
  },
);

githubRoutes.get(
  "/repositories",
  operation({
    permissions: ["member"],
    responseSchema: 'github.ts:get:"/repositories"',
    query: connectionQuery,
    summary: "Get workspace GitHub repositories",
    response:
      "Repositories with connection IDs, unavailable accounts, and identity warnings.",
    status: 200,
  }),
  async (context) => {
    const result = await getWorkspaceGitHubRepositories(
      context.get("user").workspaceId,
      connectionQuery.parse(context.req.query()).connectionId,
    );
    return context.json(result);
  },
);

const branchesQuery = z
  .object({
    connectionId: z.string().uuid().optional(),
    owner: z.string().trim().min(1).max(255),
    repository: z.string().trim().min(1).max(255),
  })
  .strict();

githubRoutes.get(
  "/branches",
  operation({
    permissions: ["member"],
    responseSchema: 'github.ts:get:"/branches"',
    summary: "List repository branches",
    query: branchesQuery,
    response:
      "Repository branch names available to the selected GitHub account.",
    status: 200,
  }),
  async (context) => {
    const input = branchesQuery.parse(context.req.query());
    const branches = await getWorkspaceRepositoryBranches(
      context.get("user").workspaceId,
      input,
    );
    return context.json({ branches });
  },
);

githubRoutes.delete(
  "/",
  operation({
    permissions: ["admin"],
    responseSchema: 'github.ts:delete:"/"',
    query: connectionQuery,
    summary: "Disconnect GitHub account",
    response: "No response body.",
    status: 204,
  }),
  async (context) => {
    await disconnectGitHub(
      context.get("user").workspaceId,
      connectionQuery.parse(context.req.query()).connectionId,
    );
    return context.body(null, 204);
  },
);

githubRoutes.get(
  "/installation",
  operation({
    permissions: ["member"],
    summary: "Get connected GitHub installation",
    responseSchema: 'github.ts:get:"/installation"',
    response:
      "Connected accounts and installation IDs without provider credentials.",
  }),
  async (context) => {
    const installations = await getGitHubConnections(
      context.get("user").workspaceId,
    );
    const connections = installations.map((connection) => ({
      id: connection.id,
      accountLogin: connection.accountLogin,
      accountType: connection.accountType,
      suspendedAt: connection.suspendedAt,
    }));
    return context.json({
      connections,
      connection: connections.length === 1 ? connections[0] : null,
    });
  },
);
