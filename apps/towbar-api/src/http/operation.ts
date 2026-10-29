import { type Scope, actorAllows } from "@workspace/towbar-access";
import { withActor } from "../areas/auth/actor-context.js";
import { forbidden } from "./errors.js";
import { requireRecentAuthentication } from "../areas/auth/recent-authentication.js";
import { z } from "zod";
import type { MiddlewareHandler } from "hono";
import type { TowbarHonoEnvironment } from "./types.js";

export type OperationDescription = {
  summary: string;
  body?: z.ZodType;
  query?: z.ZodType;
  permissions: readonly Scope[];
  freshSession?: boolean;
  idempotencyKey?: boolean;
  response: string;
  responseSchema: string;
  status?: number;
  additionalStatuses?: number[];
  stream?: boolean;
  browserOnly?: boolean;
};
const descriptions = new WeakMap<
  MiddlewareHandler<TowbarHonoEnvironment>,
  OperationDescription
>();
/** Describe a route beside its handler; REST docs and internal MCP dispatch validate these inputs. */
export function operation(
  description: OperationDescription,
): MiddlewareHandler<TowbarHonoEnvironment> {
  const middleware: MiddlewareHandler<TowbarHonoEnvironment> = async (
    context,
    next,
  ) => {
    if (description.browserOnly && context.get("apiKey"))
      return context.notFound();
    const actor = context.get("actor");
    if (!actor || !actorAllows(actor, description.permissions))
      throw forbidden("Your role or API key does not permit this action");
    if (description.freshSession) {
      if (actor.kind !== "session") throw forbidden("Sign in to continue");
      await requireRecentAuthentication(
        actor.userId,
        context.get("currentSessionId"),
      );
    }
    for (const [name, value] of Object.entries(context.req.param())) {
      if (/Id$/.test(name)) z.uuid().parse(value);
    }
    await withActor(actor, () => next());
  };
  descriptions.set(middleware, description);
  return middleware;
}
export function operationDescription(
  handler: MiddlewareHandler<TowbarHonoEnvironment>,
) {
  return descriptions.get(handler);
}
