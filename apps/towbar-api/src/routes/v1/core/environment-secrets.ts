import { sessionUser } from "../../../http/session-user.js";
import { z } from "zod";
import { operation } from "../../../http/operation.js";
import { type Context, Hono } from "hono";
import {
  secretEnvironmentSchema,
  secretKeySchema,
  secretMutationSchema,
  secretStageSchema,
} from "@workspace/towbar-core";
import {
  getEnvironmentSecretOwner,
  getInstanceSecretReadiness,
  listEnvironmentSecrets,
  listSecretEnvironments,
  updateEnvironmentSecrets,
} from "../../../areas/apps/secrets.js";
import { getApp, getResource } from "../../../areas/apps/queries.js";
import {
  revealSecretValue,
  revealSecretValues,
} from "../../../areas/secrets/store.js";
import { unprocessable } from "../../../http/errors.js";
import { readJson, readUuidPathParameter } from "../../../http/requests.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";

export function environmentSecretRoutes(
  kind: "workspace" | "repository" | "app" | "resource",
) {
  const environment = (value: string | undefined) =>
    kind === "workspace" || kind === "repository"
      ? "production"
      : secretEnvironmentSchema.parse(value);
  const routes = new Hono<TowbarHonoEnvironment>();
  routes.use("*", async (context, next) => {
    const id =
      kind === "workspace"
        ? null
        : readUuidPathParameter(context.req.param("ownerId")!, "ownerId");
    const workspaceId = context.get("user").workspaceId;
    if (kind === "app") await getApp(id!, workspaceId);
    if (kind === "resource") await getResource(id!, workspaceId);
    if (kind === "repository")
      await getEnvironmentSecretOwner({
        type: "repository",
        id: id!,
        workspaceId,
      });
    context.header("Cache-Control", "no-store");
    await next();
  });
  routes.get(
    "/",
    operation({
      permissions: ["member"],
      responseSchema: 'environment-secrets.ts:get:"/"',
      summary: "List environment secrets",
      query: z
        .object({ environment: secretEnvironmentSchema.optional() })
        .strict(),
      response: "JSON object containing bindings, canManageSecrets.",
      status: 200,
    }),
    async (context) => {
      const user = context.get("user");
      const owner =
        kind === "workspace"
          ? ({ type: "workspace", workspaceId: user.workspaceId } as const)
          : ({
              type:
                kind === "repository"
                  ? ("repository" as const)
                  : ("app" as const),
              id: readUuidPathParameter(
                context.req.param("ownerId")!,
                "ownerId",
              ),
              workspaceId: user.workspaceId,
            } as const);
      const environments = await listSecretEnvironments(owner);
      const requestedEnvironment =
        context.req.query("environment") ?? environments[0];
      const selectedEnvironment = requestedEnvironment
        ? environment(requestedEnvironment)
        : undefined;
      if (selectedEnvironment && !environments.includes(selectedEnvironment))
        throw unprocessable(
          "Connect this environment before managing its secrets",
          "SECRET_ENVIRONMENT_MISMATCH",
        );
      return context.json({
        environments,
        bindings: selectedEnvironment
          ? await listEnvironmentSecrets(owner, selectedEnvironment)
          : [],
        canManageSecrets:
          user.workspaceRole === "admin" || user.workspaceRole === "member",
      });
    },
  );
  if (kind === "app" || kind === "resource")
    routes.get(
      "/readiness",
      operation({
        permissions: ["member"],
        responseSchema: 'environment-secrets.ts:get:"/readiness"',
        summary: "Get deployment secret readiness",
        response: "Whether all required secrets can be resolved.",
        status: 200,
      }),
      async (context) =>
        context.json(
          await getInstanceSecretReadiness({
            appId: readUuidPathParameter(
              context.req.param("ownerId")!,
              "ownerId",
            ),
            workspaceId: context.get("user").workspaceId,
          }),
        ),
    );
  routes.patch(
    "/:environment/:stage",
    operation({
      permissions: ["member"],
      responseSchema: 'environment-secrets.ts:patch:"/:environment/:stage"',
      summary: "Update environment secrets",
      body: secretMutationSchema,
      response: "JSON object containing secret.",
      status: 200,
    }),
    async (context) => {
      const user = context.get("user");
      return context.json({
        secret: await updateEnvironmentSecrets({
          owner:
            kind === "workspace"
              ? { type: "workspace", workspaceId: user.workspaceId }
              : {
                  type: kind === "repository" ? "repository" : "app",
                  id: readUuidPathParameter(
                    context.req.param("ownerId")!,
                    "ownerId",
                  ),
                  workspaceId: user.workspaceId,
                },
          actorUserId: user.id,
          environment: environment(context.req.param("environment")),
          stage: secretStageSchema.parse(context.req.param("stage")),
          mutation: await readJson(context, secretMutationSchema, 300 * 1024),
        }),
      });
    },
  );
  routes.post(
    "/:environment/:stage/reveal",
    operation({
      permissions: ["admin"],
      freshSession: true,
      browserOnly: true,
      responseSchema:
        'environment-secrets.ts:post:"/:environment/:stage/reveal"',
      summary: "Reveal an environment secret",
      body: z.object({ key: secretKeySchema }).strict(),
      response: "JSON object containing the stored value and revision.",
      status: 200,
    }),
    async (context) => {
      const slot = await revealSlot(context);
      const { key } = await readJson(
        context,
        z.object({ key: secretKeySchema }).strict(),
        2048,
      );
      return context.json(await revealSecretValue(slot, key));
    },
  );
  routes.post(
    "/:environment/:stage/reveal-all",
    operation({
      permissions: ["admin"],
      freshSession: true,
      browserOnly: true,
      responseSchema:
        'environment-secrets.ts:post:"/:environment/:stage/reveal-all"',
      summary: "Reveal all environment secrets in a stage",
      body: z.object({}).strict(),
      response: "JSON object containing stored values and their revision.",
      status: 200,
    }),
    async (context) => {
      const slot = await revealSlot(context);
      await readJson(context, z.object({}).strict(), 2048);
      return context.json(await revealSecretValues(slot));
    },
  );
  async function revealSlot(context: Context<TowbarHonoEnvironment>) {
    const user = sessionUser(context);
    const owner =
      kind === "workspace"
        ? { type: "workspace" as const, workspaceId: user.workspaceId }
        : {
            type:
              kind === "repository"
                ? ("repository" as const)
                : ("app" as const),
            id: readUuidPathParameter(context.req.param("ownerId")!, "ownerId"),
            workspaceId: user.workspaceId,
          };
    const ownership = await getEnvironmentSecretOwner(owner);
    const selectedEnvironment = environment(context.req.param("environment"));
    const stage = secretStageSchema.parse(context.req.param("stage"));
    if (
      ownership.resource &&
      (selectedEnvironment === "preview" ||
        selectedEnvironment.startsWith("preview:") ||
        stage !== "deployment")
    )
      throw unprocessable(
        "Resources only support their environment runtime secrets",
      );

    return { ...owner, environment: selectedEnvironment, stage };
  }
  return routes;
}
