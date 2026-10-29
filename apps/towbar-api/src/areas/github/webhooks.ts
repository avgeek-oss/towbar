import { withActor } from "../auth/actor-context.js";
import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { digestValue } from "@workspace/towbar-core";
import {
  integrationInstallations,
  integrationWebhookDeliveries,
  sourceEnvironments,
  sources,
} from "@workspace/towbar-database/schema";

import { badRequest, unauthorized } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { enqueuePreviewPullRequestEvent } from "../../infrastructure/temporal.js";
import { requestEnvironmentSync } from "../sources/environments.js";
import { shouldReconcilePreviewPullRequest } from "./webhook-events.js";
import { requireGitHubRuntimeConfiguration } from "../../infrastructure/runtime-integrations.js";
import { getGitHubInstallation } from "./client.js";
import { saveGitHubInstallation } from "./service.js";
import { workspaces } from "@workspace/towbar-database/schema";

const pushSchema = z.object({
  after: z.string().regex(/^[a-f0-9]{40}$/u),
  deleted: z.boolean(),
  installation: z.object({ id: z.number().int().positive() }),
  ref: z.string(),
  repository: z.object({
    id: z.number().int().positive().optional(),
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});
const installationSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
});
const pullRequestSchema = z.object({
  action: z.string().min(1).max(100),
  installation: z.object({ id: z.number().int().positive() }),
  number: z.number().int().positive().max(2_147_483_647),
  repository: z.object({
    id: z.number().int().positive().optional(),
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

export async function processGitHubWebhook(input: {
  body: string;
  deliveryId: string | undefined;
  eventName: string | undefined;
  signature: string | undefined;
  targetId: string | undefined;
}) {
  if (!input.deliveryId || !input.eventName) {
    throw badRequest("Required GitHub webhook headers are missing");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.body);
  } catch {
    throw badRequest("GitHub webhook body is invalid JSON");
  }
  const configuration = requireGitHubRuntimeConfiguration();
  if (input.targetId && input.targetId !== configuration.appId)
    throw unauthorized("GitHub App target is invalid");
  verifyWebhookSignature(
    input.body,
    input.signature,
    configuration.webhookSecret,
  );
  if (input.eventName === "ping") return { accepted: true, duplicate: false };
  const installationId = getWebhookInstallationId(payload);
  const github = await resolveWebhookInstallation({
    installationId,
    eventName: input.eventName,
    payload,
    signed: Boolean(configuration.webhookSecret),
  });
  if (!github) return { accepted: true, duplicate: false };
  const database = getTowbarDatabase();
  const created = await database
    .insert(integrationWebhookDeliveries)
    .values({
      action:
        typeof payload === "object" && payload && "action" in payload
          ? String(payload.action).slice(0, 100)
          : null,
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      installationId: github.id,
      payloadDigest: digestValue(input.body),
      provider: "github",
    })
    .onConflictDoNothing()
    .returning({ deliveryId: integrationWebhookDeliveries.deliveryId });
  if (created.length === 0) return { accepted: true, duplicate: true };

  try {
    const sourceId =
      input.eventName === "push"
        ? await processGitHubPush(payload)
        : input.eventName === "pull_request"
          ? await processPullRequest(payload)
          : input.eventName === "installation"
            ? await processInstallation(payload)
            : null;
    await database
      .update(integrationWebhookDeliveries)
      .set({ processedAt: new Date(), sourceId })
      .where(
        and(
          eq(integrationWebhookDeliveries.provider, "github"),
          eq(integrationWebhookDeliveries.deliveryId, input.deliveryId),
        ),
      );
    return { accepted: true, duplicate: false };
  } catch (error) {
    await database
      .delete(integrationWebhookDeliveries)
      .where(
        and(
          eq(integrationWebhookDeliveries.provider, "github"),
          eq(integrationWebhookDeliveries.deliveryId, input.deliveryId),
        ),
      );
    throw error;
  }
}

export async function processGitHubPush(
  payload: unknown,
  enqueue: (
    input: Parameters<typeof requestEnvironmentSync>[0],
  ) => Promise<unknown> = requestEnvironmentSync,
) {
  const push = pushSchema.parse(payload);
  const branch = push.ref.startsWith("refs/heads/")
    ? push.ref.slice("refs/heads/".length)
    : null;
  if (!branch) return null;
  const matchingSources = await findActiveSources({
    installationId: push.installation.id,
    repositoryId: push.repository.id ? String(push.repository.id) : undefined,
    repositoryName: push.repository.name,
    repositoryOwner: push.repository.owner.login,
  });
  const deleted = isDeletedPush(push);
  for (const source of matchingSources) {
    if (deleted) continue;
    const environments = await getTowbarDatabase()
      .select()
      .from(sourceEnvironments)
      .where(
        and(
          eq(sourceEnvironments.sourceId, source.id),
          eq(sourceEnvironments.branch, branch),
          isNull(sourceEnvironments.disconnectedAt),
        ),
      );
    for (const environment of environments) {
      await withActor(
        {
          kind: "system",
          source: "github",
          workspaceId: source.workspaceId,
          grants: ["admin"],
        },
        () =>
          enqueue({
            sourceId: source.id,
            environmentId: environment.id,
            expectedMappingRevision: environment.mappingRevision,
            workspaceId: source.workspaceId,
            requestedBy: null,
            deployAfterSync: !environment.autoDeployPaused,
          }),
      );
    }
  }
  return matchingSources[0]?.id ?? null;
}

async function processPullRequest(payload: unknown) {
  const pullRequest = pullRequestSchema.parse(payload);
  if (!shouldReconcilePreviewPullRequest(pullRequest.action)) return null;
  const matchingSources = await findActiveSources({
    installationId: pullRequest.installation.id,
    repositoryId: pullRequest.repository.id
      ? String(pullRequest.repository.id)
      : undefined,
    repositoryName: pullRequest.repository.name,
    repositoryOwner: pullRequest.repository.owner.login,
  });
  for (const source of matchingSources) {
    await enqueuePreviewPullRequestEvent({
      pullRequestNumber: pullRequest.number,
      sourceId: source.id,
    });
  }
  return matchingSources[0]?.id ?? null;
}

async function findActiveSources(input: {
  installationId: number;
  repositoryId?: string;
  repositoryName: string;
  repositoryOwner: string;
}) {
  return await getTowbarDatabase()
    .select({
      id: sources.id,
      workspaceId: sources.workspaceId,
    })
    .from(sources)
    .innerJoin(
      integrationInstallations,
      eq(integrationInstallations.id, sources.integrationInstallationId),
    )
    .where(
      and(
        eq(integrationInstallations.externalId, String(input.installationId)),
        eq(integrationInstallations.provider, "github"),
        or(
          input.repositoryId
            ? eq(sources.providerRepositoryId, input.repositoryId)
            : undefined,
          and(
            isNull(sources.providerRepositoryId),
            sql`lower(${sources.repositoryOwner}) = ${input.repositoryOwner.toLowerCase()}`,
            sql`lower(${sources.repositoryName}) = ${input.repositoryName.toLowerCase()}`,
          ),
          ...(!input.repositoryId
            ? [
                and(
                  eq(sources.repositoryOwner, input.repositoryOwner),
                  eq(sources.repositoryName, input.repositoryName),
                ),
              ]
            : []),
        ),
        eq(sources.status, "active"),
        isNull(integrationInstallations.suspendedAt),
      ),
    )
    .orderBy(sources.createdAt);
}

async function processInstallation(payload: unknown) {
  const installation = installationSchema.parse(payload);
  const suspendedAt = ["deleted", "suspend"].includes(installation.action)
    ? new Date()
    : installation.action === "unsuspend"
      ? null
      : undefined;
  if (suspendedAt === undefined) return null;
  await getTowbarDatabase()
    .update(integrationInstallations)
    .set({ suspendedAt, updatedAt: new Date() })
    .where(
      and(
        eq(integrationInstallations.provider, "github"),
        eq(
          integrationInstallations.externalId,
          String(installation.installation.id),
        ),
      ),
    );
  return null;
}

export async function resolveWebhookInstallation(
  input: {
    installationId: string;
    eventName: string;
    payload: unknown;
    signed: boolean;
  },
  lookup = getGitHubInstallation,
) {
  const database = getTowbarDatabase();
  const [known] = await database
    .select()
    .from(integrationInstallations)
    .where(
      and(
        eq(integrationInstallations.provider, "github"),
        eq(integrationInstallations.externalId, input.installationId),
      ),
    );
  const event = installationSchema.safeParse(input.payload);
  if (
    input.eventName !== "installation" ||
    !event.success ||
    !["created", "unsuspend", "new_permissions_accepted"].includes(
      event.data.action,
    )
  )
    return known ?? null;
  if (!input.signed)
    throw unauthorized(
      "A webhook secret is required to connect GitHub accounts automatically",
    );
  const available = known
    ? [{ id: known.workspaceId }]
    : await database.select({ id: workspaces.id }).from(workspaces).limit(2);
  if (available.length !== 1) return null;
  const installation = await lookup(input.installationId, available[0]!.id);
  return await saveGitHubInstallation(available[0]!.id, installation);
}

function isDeletedPush(push: z.infer<typeof pushSchema>) {
  return push.deleted || /^0{40}$/u.test(push.after);
}

export function verifyWebhookSignature(
  body: string,
  supplied: string | undefined,
  webhookSecret: string | undefined,
) {
  if (!webhookSecret) return;
  if (!supplied) {
    throw badRequest("Required GitHub webhook signature is missing");
  }
  const expected = `sha256=${createHmac("sha256", webhookSecret)
    .update(body)
    .digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw unauthorized("GitHub webhook signature is invalid");
  }
}

function getWebhookInstallationId(payload: unknown) {
  const result = z
    .object({ installation: z.object({ id: z.number().int().positive() }) })
    .safeParse(payload);
  if (!result.success) {
    throw badRequest("GitHub webhook installation is missing");
  }
  return String(result.data.installation.id);
}
