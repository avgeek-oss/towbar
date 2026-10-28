import { listServerCleanups } from "../../../areas/resource-operations/server-cleanup.js";
import { actorAllows } from "@workspace/towbar-access";
import { filterServers, serverFilters } from "@workspace/towbar-core/inventory";
import { operation } from "../../../http/operation.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  normalizeServerConfiguration,
  serverConfigurationSchema,
} from "@workspace/towbar-core";

import {
  createServer,
  removeServer,
  updateServer,
  updateServerName,
} from "../../../areas/servers/lifecycle.js";
import {
  getServer,
  listServerApps,
  listServerDeployments,
  listServerResources,
  listServers,
  requestServerCheck,
} from "../../../areas/servers/service.js";
import {
  listTrustedHostKeys,
  revokeServerHostKey,
  trustServerHostKey,
} from "../../../areas/servers/trusted-host-keys.js";
import { listServerChecks } from "../../../areas/servers/checks.js";
import {
  listServerPreparations,
  requestServerPreparation,
} from "../../../areas/servers/preparations.js";
import {
  getServerOrphans,
  hasActiveOrphanCleanup,
  requestOrphanCleanup,
} from "../../../areas/resource-operations/service.js";
import { getServerCapacity } from "../../../areas/servers/capacity.js";
import { badRequest, notFound } from "../../../http/errors.js";
import { readJson } from "../../../http/requests.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

const hostKeySchema = z
  .object({
    algorithm: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9@._+-]{0,79}$/u),
    fingerprint: z.string().trim().startsWith("SHA256:").max(255),
    publicKey: z.string().trim().min(32).max(16_384),
    replaceExisting: z.boolean().optional().default(false),
  })
  .strict();
const serverChecksQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(10),
    page: z.coerce.number().int().min(1).default(1),
  })
  .strict();
const cleanupSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            kind: z.enum(["container", "image", "volume"]),
            name: z.string().trim().min(1).max(512),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .optional(),
  })
  .strict();
const serverNameSchema = z
  .object({ name: z.string().trim().min(1).max(120).nullable() })
  .strict();

export const serverRoutes = new Hono<TowbarHonoEnvironment>();

serverRoutes.get(
  "/",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/"',
    query: serverFilters,
    summary: "List servers",
    response: "JSON object containing servers.",
    status: 200,
  }),
  async (context) => {
    const result = filterServers(
      await listServers(context.get("user").workspaceId),
      serverFilters.parse(context.req.query()),
    );
    return context.json({ servers: result.items, counts: result.counts });
  },
);
serverRoutes.post(
  "/",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:post:"/"',
    summary: "Create server",
    body: serverConfigurationSchema,
    response: "JSON object containing server.",
    status: 201,
  }),
  async (context) => {
    const user = context.get("user");
    const configuration = await readJson(context, serverConfigurationSchema);
    const config = normalizeServerConfiguration(configuration);
    return context.json(
      {
        server: await createServer({
          config,
          workspaceId: user.workspaceId,
        }),
      },
      201,
    );
  },
);
serverRoutes.get(
  "/:serverId",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/:serverId"',
    summary: "Get server",
    response:
      "JSON object containing canCleanupOrphans, canManageServer, canRemoveServer, server.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const server = await getServer(
      context.req.param("serverId"),
      user.workspaceId,
    );
    return context.json({
      canCleanupOrphans: actorAllows(context.get("actor"), ["admin"]),
      canManageServer: actorAllows(context.get("actor"), ["admin"]),
      canRemoveServer: actorAllows(context.get("actor"), ["admin"]),
      server,
    });
  },
);
serverRoutes.patch(
  "/:serverId",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:patch:"/:serverId"',
    summary: "Update server",
    body: serverConfigurationSchema,
    response: "JSON object containing server.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const configuration = await readJson(context, serverConfigurationSchema);
    const config = normalizeServerConfiguration(configuration);
    return context.json({
      server: await updateServer({
        config,
        serverId: context.req.param("serverId"),
        workspaceId: user.workspaceId,
      }),
    });
  },
);
serverRoutes.patch(
  "/:serverId/name",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:patch:"/:serverId/name"',
    summary: "Update server name",
    body: serverNameSchema,
    response: "JSON object containing server.",
    status: 200,
  }),
  async (context) => {
    const input = await readJson(context, serverNameSchema);
    return context.json({
      server: await updateServerName({
        name: input.name,
        serverId: context.req.param("serverId"),
        workspaceId: context.get("user").workspaceId,
      }),
    });
  },
);
serverRoutes.get(
  "/:serverId/apps",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/:serverId/apps"',
    summary: "List server apps",
    response: "JSON object containing apps.",
    status: 200,
  }),
  async (context) =>
    context.json({
      apps: await listServerApps(
        context.req.param("serverId"),
        context.get("user").workspaceId,
      ),
    }),
);
serverRoutes.get(
  "/:serverId/resources",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/:serverId/resources"',
    summary: "List server resources",
    response: "JSON object containing resources.",
    status: 200,
  }),
  async (context) =>
    context.json({
      resources: await listServerResources(
        context.req.param("serverId"),
        context.get("user").workspaceId,
      ),
    }),
);
serverRoutes.get(
  "/:serverId/deployments",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/:serverId/deployments"',
    summary: "List server deployments",
    response: "JSON object containing deployments.",
    status: 200,
  }),
  async (context) =>
    context.json({
      deployments: await listServerDeployments(
        context.req.param("serverId"),
        context.get("user").workspaceId,
      ),
    }),
);
serverRoutes.get(
  "/:serverId/cleanup",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/:serverId/cleanup"',
    summary: "Get server cleanup history",
    query: serverChecksQuerySchema,
    response: "Paginated server cleanup attempts and current queue status.",
    status: 200,
  }),
  async (context) => {
    const serverId = context.req.param("serverId");
    const workspaceId = context.get("user").workspaceId;
    await getServer(serverId, workspaceId);
    return context.json({
      inProgress: await hasActiveOrphanCleanup(serverId, workspaceId),
      ...(await listServerCleanups({
        serverId,
        workspaceId,
        ...serverChecksQuerySchema.parse(context.req.query()),
      })),
    });
  },
);
serverRoutes.get(
  "/:serverId/capacity",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/:serverId/capacity"',
    summary: "Get server capacity",
    response: "JSON object containing capacity.",
    status: 200,
  }),
  async (context) => {
    const serverId = context.req.param("serverId");
    const workspaceId = context.get("user").workspaceId;
    await getServer(serverId, workspaceId);
    const capacity = await getServerCapacity(workspaceId, serverId);
    if (!capacity) throw notFound("Server capacity");
    return context.json({ capacity });
  },
);
serverRoutes.get(
  "/:serverId/checks",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/:serverId/checks"',
    summary: "List server checks",
    query: serverChecksQuerySchema,
    response: "Server checks and pagination metadata.",
    status: 200,
  }),
  async (context) => {
    const pagination = serverChecksQuerySchema.parse(context.req.query());
    return context.json(
      await listServerChecks({
        ...pagination,
        serverId: context.req.param("serverId"),
        workspaceId: context.get("user").workspaceId,
      }),
    );
  },
);
serverRoutes.get(
  "/:serverId/preparations",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/:serverId/preparations"',
    summary: "List server preparations",
    response: "JSON object containing preparations.",
    status: 200,
  }),
  async (context) =>
    context.json({
      preparations: await listServerPreparations(
        context.req.param("serverId"),
        context.get("user").workspaceId,
      ),
    }),
);
serverRoutes.get(
  "/:serverId/orphans",
  operation({
    permissions: ["viewer"],
    responseSchema: 'servers.ts:get:"/:serverId/orphans"',
    summary: "Get server orphans",
    response: "JSON object containing orphans.",
    status: 200,
  }),
  async (context) =>
    context.json({
      orphans: await getServerOrphans(
        context.req.param("serverId"),
        context.get("user").workspaceId,
      ),
    }),
);
serverRoutes.get(
  "/:serverId/host-keys",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:get:"/:serverId/host-keys"',
    summary: "List trusted host keys",
    response: "JSON object containing hostKeys.",
    status: 200,
  }),
  async (context) =>
    context.json({
      hostKeys: await listTrustedHostKeys(
        context.req.param("serverId"),
        context.get("user").workspaceId,
      ),
    }),
);
serverRoutes.post(
  "/:serverId/actions/check",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:post:"/:serverId/actions/check"',
    summary: "Request server check",
    response: "JSON object containing check.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json(
      {
        check: await requestServerCheck({
          requestedBy: user.id,
          serverId: context.req.param("serverId"),
          workspaceId: user.workspaceId,
        }),
      },
      202,
    );
  },
);
serverRoutes.post(
  "/:serverId/actions/prepare",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:post:"/:serverId/actions/prepare"',
    summary: "Request server preparation",
    response: "JSON object containing preparation.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json(
      {
        preparation: await requestServerPreparation({
          requestedBy: user.id,
          serverId: context.req.param("serverId"),
          workspaceId: user.workspaceId,
        }),
      },
      202,
    );
  },
);
serverRoutes.post(
  "/:serverId/actions/cleanup-orphans",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:post:"/:serverId/actions/cleanup-orphans"',
    summary: "Request orphan cleanup",
    body: cleanupSchema,
    idempotencyKey: true,
    response: "The cleanup operation and whether the request was replayed.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const body = await readJson(context, cleanupSchema);
    const result = await requestOrphanCleanup({
      items: body.items,
      idempotencyKey: requireIdempotencyKey(
        context.req.header("idempotency-key"),
      ),
      requestedBy: user.id,
      serverId: context.req.param("serverId"),
      workspaceId: user.workspaceId,
    });
    return context.json(result, result.replayed ? 200 : 202);
  },
);
serverRoutes.post(
  "/:serverId/host-keys/actions/trust",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:post:"/:serverId/host-keys/actions/trust"',
    summary: "Trust server host key",
    body: hostKeySchema,
    response: "JSON object containing hostKey.",
    status: 201,
  }),
  async (context) => {
    const body = await readJson(context, hostKeySchema);
    const user = context.get("user");
    return context.json(
      {
        hostKey: await trustServerHostKey({
          ...body,
          serverId: context.req.param("serverId"),
          trustedBy: user.id,
          workspaceId: user.workspaceId,
        }),
      },
      201,
    );
  },
);
serverRoutes.delete(
  "/:serverId/host-keys/:hostKeyId",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:delete:"/:serverId/host-keys/:hostKeyId"',
    summary: "Revoke server host key",
    response: "No response body.",
    status: 204,
  }),
  async (context) => {
    const user = context.get("user");
    await revokeServerHostKey({
      hostKeyId: context.req.param("hostKeyId"),
      serverId: context.req.param("serverId"),
      workspaceId: user.workspaceId,
    });
    return context.body(null, 204);
  },
);

function requireIdempotencyKey(value: string | undefined) {
  const key = value?.trim();
  if (!key || key.length > 255) {
    throw badRequest(
      "A valid Idempotency-Key header is required",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  return key;
}

serverRoutes.delete(
  "/:serverId",
  operation({
    permissions: ["admin"],
    responseSchema: 'servers.ts:delete:"/:serverId"',
    summary: "Remove server",
    additionalStatuses: [202],
    response:
      "Stops Towbar management, archives assigned inventory, and removes stored server credentials and host-key trust. Active operations block removal. A later Source sync restores an archived server referenced by IP.",
    status: 204,
  }),
  async (context) => {
    const user = context.get("user");
    const removal = await removeServer({
      serverId: context.req.param("serverId"),
      workspaceId: user.workspaceId,
      requestedBy: user.id,
    });
    if (removal.pending) return context.json({ pending: true }, 202);
    return context.body(null, 204);
  },
);
