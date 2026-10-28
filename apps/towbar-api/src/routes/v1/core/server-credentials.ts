import { operation } from "../../../http/operation.js";
import { Hono } from "hono";
import { z } from "zod";
import { secretMutationSchema } from "@workspace/towbar-core";
import {
  mutateServerCredentials,
  readSecretMetadata,
  requireSecretOwner,
} from "../../../areas/secrets/store.js";
import { unprocessable } from "../../../http/errors.js";
import { readJson, readUuidPathParameter } from "../../../http/requests.js";
import type { TowbarHonoEnvironment } from "../../../http/types.js";
import {
  getServerCredentialVerification,
  requestServerCredentialVerification,
} from "../../../areas/servers/credential-verification.js";
import { getServerPrivateKeyId } from "../../../areas/servers/private-key-selection.js";

const privateKeyVerificationSchema = z
  .object({
    expectedRevision: z.uuid().nullable(),
    privateKeyId: z.uuid(),
  })
  .strict();

export const serverCredentialRoutes = new Hono<TowbarHonoEnvironment>();
serverCredentialRoutes.get(
  "/",
  operation({
    permissions: ["admin"],
    responseSchema: 'server-credentials.ts:get:"/"',
    summary: "Get server credential metadata",
    response: "JSON object containing credential, canManage.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const slot = {
      type: "server" as const,
      id: readUuidPathParameter(context.req.param("serverId")!, "serverId"),
      workspaceId: user.workspaceId,
      environment: "production" as const,
      stage: "credentials",
    };
    await requireSecretOwner(slot);
    context.header("Cache-Control", "no-store");
    return context.json({
      credential: await readSecretMetadata(slot),
      canManage: user.workspaceRole === "admin",
      selectedPrivateKeyId: await getServerPrivateKeyId(
        slot.id,
        user.workspaceId,
      ),
    });
  },
);
serverCredentialRoutes.patch(
  "/",
  operation({
    permissions: ["admin"],
    responseSchema: 'server-credentials.ts:patch:"/"',
    summary: "Update server credentials",
    body: secretMutationSchema,
    response: "JSON object containing credential.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    const mutation = await readJson(context, secretMutationSchema, 300 * 1024);
    if (mutation.set.privateKey !== undefined)
      throw unprocessable(
        "Verify SSH private keys before saving them.",
        "SSH_PRIVATE_KEY_VERIFICATION_REQUIRED",
      );
    const slot = {
      type: "server" as const,
      id: readUuidPathParameter(context.req.param("serverId")!, "serverId"),
      workspaceId: user.workspaceId,
      environment: "production" as const,
      stage: "credentials",
    };
    const credential = await mutateServerCredentials(slot, mutation, user.id);
    context.header("Cache-Control", "no-store");
    return context.json({ credential });
  },
);

serverCredentialRoutes.post(
  "/actions/verify-private-key",
  operation({
    permissions: ["admin"],
    responseSchema: 'server-credentials.ts:post:"/actions/verify-private-key"',
    summary: "Verify and save an SSH private key",
    body: privateKeyVerificationSchema,
    response: "JSON object containing the credential verification.",
    status: 202,
  }),
  async (context) => {
    const user = context.get("user");
    const serverId = readUuidPathParameter(
      context.req.param("serverId")!,
      "serverId",
    );
    const input = await readJson(
      context,
      privateKeyVerificationSchema,
      70 * 1_024,
    );
    context.header("Cache-Control", "no-store");
    return context.json(
      {
        verification: await requestServerCredentialVerification({
          ...input,
          requestedBy: user.id,
          serverId,
          workspaceId: user.workspaceId,
        }),
      },
      202,
    );
  },
);

serverCredentialRoutes.get(
  "/verifications/:verificationId",
  operation({
    permissions: ["admin"],
    responseSchema:
      'server-credentials.ts:get:"/verifications/:verificationId"',
    summary: "Get SSH private key verification",
    response: "JSON object containing the credential verification.",
    status: 200,
  }),
  async (context) => {
    const user = context.get("user");
    context.header("Cache-Control", "no-store");
    return context.json({
      verification: await getServerCredentialVerification({
        id: readUuidPathParameter(
          context.req.param("verificationId")!,
          "verificationId",
        ),
        serverId: readUuidPathParameter(
          context.req.param("serverId")!,
          "serverId",
        ),
        workspaceId: user.workspaceId,
      }),
    });
  },
);
