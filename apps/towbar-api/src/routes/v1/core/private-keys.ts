import { sessionUser } from "../../../http/session-user.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  createWorkspacePrivateKey,
  deleteWorkspacePrivateKey,
  listWorkspacePrivateKeys,
  revealWorkspacePrivateKey,
  updateWorkspacePrivateKey,
} from "../../../areas/private-keys/service.js";

import { operation } from "../../../http/operation.js";
import { readJson, readUuidPathParameter } from "../../../http/requests.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";

const identitySchema = z.object({
  description: z.string().trim().max(500).nullable().optional(),
  name: z.string().trim().min(1).max(120),
});

const createPrivateKeySchema = z.discriminatedUnion("mode", [
  identitySchema.extend({
    algorithm: z.enum(["ed25519", "rsa"]),
    mode: z.literal("generate"),
  }),
  identitySchema.extend({
    mode: z.literal("manual"),
    privateKey: z
      .string()
      .min(64)
      .max(64 * 1_024),
    publicKey: z
      .string()
      .trim()
      .max(16 * 1_024)
      .nullable()
      .optional(),
  }),
]);

const updatePrivateKeySchema = identitySchema
  .extend({
    privateKey: z
      .string()
      .min(64)
      .max(64 * 1_024)
      .optional(),
    publicKey: z
      .string()
      .trim()
      .max(16 * 1_024)
      .nullable()
      .optional(),
  })
  .strict();

export const privateKeyRoutes = new Hono<TowbarHonoEnvironment>();

privateKeyRoutes.get(
  "/",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'private-keys.ts:get:"/"',
    summary: "List stored SSH private keys",
    response: "JSON object containing privateKeys and canManage.",
    status: 200,
  }),
  async (context) => {
    const user = sessionUser(context);
    context.header("Cache-Control", "no-store");
    return context.json({
      canManage: user.workspaceRole === "admin",
      privateKeys: await listWorkspacePrivateKeys(user.workspaceId),
    });
  },
);

privateKeyRoutes.post(
  "/",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'private-keys.ts:post:"/"',
    summary: "Create or generate an SSH private key",
    body: createPrivateKeySchema,
    response: "JSON object containing privateKey.",
    status: 201,
  }),
  async (context) => {
    const user = sessionUser(context);
    const input = await readJson(context, createPrivateKeySchema, 80 * 1_024);
    const privateKey = await createWorkspacePrivateKey({
      algorithm: input.mode === "generate" ? input.algorithm : undefined,
      description: input.description,
      name: input.name,
      privateKey: input.mode === "manual" ? input.privateKey : undefined,
      publicKey: input.mode === "manual" ? input.publicKey : undefined,
      workspaceId: user.workspaceId,
    });
    context.header("Cache-Control", "no-store");
    return context.json({ privateKey }, 201);
  },
);

privateKeyRoutes.patch(
  "/:privateKeyId",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'private-keys.ts:patch:"/:privateKeyId"',
    summary: "Update a stored SSH private key",
    body: updatePrivateKeySchema,
    response: "JSON object containing privateKey.",
    status: 200,
  }),
  async (context) => {
    const user = sessionUser(context);
    const input = await readJson(context, updatePrivateKeySchema, 80 * 1_024);
    const privateKey = await updateWorkspacePrivateKey({
      ...input,
      id: readUuidPathParameter(
        context.req.param("privateKeyId")!,
        "privateKeyId",
      ),
      workspaceId: user.workspaceId,
    });
    context.header("Cache-Control", "no-store");
    return context.json({ privateKey });
  },
);

privateKeyRoutes.get(
  "/:privateKeyId/reveal",
  operation({
    permissions: ["admin"],
    freshSession: true,
    browserOnly: true,
    responseSchema: 'private-keys.ts:get:"/:privateKeyId/reveal"',
    summary: "Reveal a stored SSH private key",
    response: "JSON object containing value.",
    status: 200,
  }),
  async (context) => {
    const user = sessionUser(context);
    const id = readUuidPathParameter(
      context.req.param("privateKeyId")!,
      "privateKeyId",
    );
    context.header("Cache-Control", "no-store");
    return context.json({
      value: await revealWorkspacePrivateKey(id, user.workspaceId),
    });
  },
);

privateKeyRoutes.delete(
  "/:privateKeyId",
  operation({
    permissions: ["admin"],
    browserOnly: true,
    responseSchema: 'private-keys.ts:delete:"/:privateKeyId"',
    summary: "Delete a stored SSH private key",
    response: "JSON object containing ok.",
    status: 200,
  }),
  async (context) => {
    const user = sessionUser(context);
    await deleteWorkspacePrivateKey({
      id: readUuidPathParameter(
        context.req.param("privateKeyId")!,
        "privateKeyId",
      ),
      workspaceId: user.workspaceId,
    });
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true });
  },
);
