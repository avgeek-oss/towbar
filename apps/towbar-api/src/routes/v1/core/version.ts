import { Hono } from "hono";

import { getReleaseVersion } from "../../../release-version.js";
import { operation } from "../../../http/operation.js";

import type { TowbarHonoEnvironment } from "../../../http/types.js";

export const versionRoutes = new Hono<TowbarHonoEnvironment>();

versionRoutes.get(
  "/",
  operation({
    permissions: ["identity.read"],
    responseSchema: 'version.ts:get:"/"',
    summary: "Get installed Towbar version",
    response: "Installed control-plane version.",
    status: 200,
  }),
  (context) => context.json({ installedVersion: getReleaseVersion() }),
);
