import { Hono } from "hono";
import { z } from "zod";
import {
  finishLogCollectorOperation,
  getLogCollectorExecutionContext,
} from "../../../areas/logs/lifecycle.js";
import { readJson, readUuidPathParameter } from "../../../http/requests.js";

export const internalLogCollectorRoutes = new Hono();
internalLogCollectorRoutes.get(
  "/:serverId/:generation/context",
  async (context) =>
    context.json({
      context: await getLogCollectorExecutionContext(
        readUuidPathParameter(context.req.param("serverId"), "serverId"),
        readUuidPathParameter(context.req.param("generation"), "generation"),
      ),
    }),
);
internalLogCollectorRoutes.post(
  "/:serverId/:generation/complete",
  async (context) => {
    const body = await readJson(
      context,
      z.object({ succeeded: z.boolean() }).strict(),
    );
    await finishLogCollectorOperation(
      readUuidPathParameter(context.req.param("serverId"), "serverId"),
      readUuidPathParameter(context.req.param("generation"), "generation"),
      body.succeeded,
    );
    return context.json({ ok: true });
  },
);
