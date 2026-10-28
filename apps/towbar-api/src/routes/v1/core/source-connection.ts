import { Hono } from "hono";
import {
  connectRepositorySource,
  discoverSource,
  sourceConnectionSchema,
  sourceDiscoverySchema,
} from "../../../areas/sources/connection.js";

import { operation } from "../../../http/operation.js";
import { readJson } from "../../../http/requests.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const sourceConnectionRoutes = new Hono<TowbarHonoEnvironment>();
sourceConnectionRoutes.post(
  "/discover",
  operation({
    permissions: ["admin"],
    responseSchema: 'source-connection.ts:post:"/discover"',
    summary: "Discover repository environments",
    body: sourceDiscoverySchema,
    response: "Environments declared in towbar.yml.",
    status: 200,
  }),
  async (context) =>
    context.json(
      await discoverSource({
        ...(await readJson(context, sourceDiscoverySchema)),
        workspaceId: context.get("user").workspaceId,
      }),
    ),
);
sourceConnectionRoutes.post(
  "/connect",
  operation({
    permissions: ["admin"],
    responseSchema: 'source-connection.ts:post:"/connect"',
    summary: "Connect repository and environments",
    body: sourceConnectionSchema,
    response: "Source, connected environments and initial sync outcomes.",
    status: 201,
  }),
  async (context) => {
    const user = context.get("user");
    return context.json(
      await connectRepositorySource({
        ...(await readJson(context, sourceConnectionSchema)),
        workspaceId: user.workspaceId,
        actorUserId: user.id,
      }),
      201,
    );
  },
);
