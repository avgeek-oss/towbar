import { lockDomainClaims } from "../deployments/domain-claims.js";
import { assertNoRunningCleanup } from "../resource-operations/server-cleanup.js";
import { captureQueuedActor } from "../auth/actor-context.js";
import { deploymentEnvironmentSnapshot } from "../apps/instance-environment.js";
import { randomUUID } from "node:crypto";

import { and, eq, notInArray, sql } from "drizzle-orm";

import {
  digestValue,
  isNormalizedResource,
  previewRef,
  previewRuntimeId,
} from "@workspace/towbar-core";
import { deploymentWorkflowId } from "@workspace/towbar-core/temporal";
import type { servers } from "@workspace/towbar-database/schema";
import {
  apps,
  deployments,
  previewEnvironments,
  releases,
} from "@workspace/towbar-database/schema";

import {
  getInstanceEnvironment,
  lockDeploymentEnvironment,
} from "../apps/instance-environment.js";
import { resolveBuildServerAdmission } from "../apps/build-server-admission.js";
import { cloudflareDnsCredential } from "../deployments/cloudflare-readiness.js";
import { conflict } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import {
  isPreviewReleaseCurrent,
  previewAdmissionLockKey,
  previewAdmissionReplayAction,
  previewDeploymentIdempotencyKey,
  shouldDeferPreviewAdmission,
} from "./admission-state.js";

import type { NormalizedApp, RequiredSecrets } from "@workspace/towbar-core";

type Transaction = Parameters<
  Parameters<ReturnType<typeof getTowbarDatabase>["transaction"]>[0]
>[0];

export async function admitPreviewDeployment(input: {
  targetEnvironment: {
    id: string;
    mappingRevision: string;
    latestCommitSha: string | null;
  };
  targetConfigDigest: string;
  requiredSecrets: RequiredSecrets;
  force?: boolean;
  requestedBy?: string | null;
  appId: string;
  branch: string;
  commitSha: string;
  config: NormalizedApp;
  deploymentDigest: string;
  hostname: string;
  manifestDigest: string;
  pullRequestNumber: number;
  server: (typeof servers.$inferSelect)["config"];
  serverId: string;
  sourceId: string;
  sourceInputDigest: string | null;
  ttlHours: number;
  workspaceId: string;
}) {
  const database = getTowbarDatabase();
  const gitRef = previewRef(input.pullRequestNumber);
  const runtimeId = previewRuntimeId({
    appId: input.appId,
    pullRequestNumber: input.pullRequestNumber,
    sourceId: input.sourceId,
  });
  const deploymentId = randomUUID();
  const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60_000);
  // eslint-disable-next-line complexity -- Preview admission atomically enforces quotas, identity, source state, and idempotency.
  return await database.transaction(async (transaction) => {
    await lockDomainClaims(transaction, input.workspaceId);
    await assertNoRunningCleanup(transaction, input.workspaceId);
    const targetEnvironment = await lockPreviewTarget(transaction, input);
    const admissionLockKey = previewAdmissionLockKey({
      appId: input.appId,
      gitRef,
      sourceId: input.sourceId,
    });
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${admissionLockKey}, 0))`,
    );
    const [existingEnvironment] = await transaction
      .select({
        id: previewEnvironments.id,
        latestDeploymentId: previewEnvironments.latestDeploymentId,
        status: previewEnvironments.status,
      })
      .from(previewEnvironments)
      .where(
        and(
          eq(previewEnvironments.sourceId, input.sourceId),
          eq(previewEnvironments.appId, input.appId),
          eq(previewEnvironments.gitRef, gitRef),
        ),
      )
      .for("update")
      .limit(1);
    if (input.force)
      await assertManualPreviewAdmission(transaction, existingEnvironment);
    if (
      existingEnvironment &&
      shouldDeferPreviewAdmission(existingEnvironment.status)
    ) {
      return {
        created: false,
        deferred: true,
        deploymentId: null,
        shouldEnqueue: false,
        environmentId: existingEnvironment.id,
        supersededDeploymentIds: [],
      };
    }
    const latestDeployment = await loadLatestPreviewDeployment(
      transaction,
      existingEnvironment?.latestDeploymentId,
    );
    if (
      !input.force &&
      existingEnvironment &&
      latestDeployment?.commitSha === input.commitSha &&
      latestDeployment.deploymentDigest === input.deploymentDigest
    ) {
      const replay = await replayPreviewDeployment(transaction, {
        deployment: latestDeployment,
        environment: existingEnvironment,
        expiresAt,
        input,
        runtimeId,
      });
      if (replay) return replay;
    }
    const reopeningEnvironment = isReopeningPreview(
      existingEnvironment?.status,
    );
    const [environment] = await transaction
      .insert(previewEnvironments)
      .values({
        appId: input.appId,
        branch: input.branch,
        expiresAt,
        gitRef,
        hostname: input.hostname,
        latestCommitSha: input.commitSha,
        pullRequestNumber: input.pullRequestNumber,
        runtimeId,
        serverId: input.serverId,
        sourceId: input.sourceId,
        workspaceId: input.workspaceId,
      })
      .onConflictDoUpdate({
        target: [
          previewEnvironments.sourceId,
          previewEnvironments.appId,
          previewEnvironments.gitRef,
        ],
        set: {
          branch: input.branch,
          deletedAt: null,
          errorMessage: null,
          expiresAt,
          hostname: input.hostname,
          latestCommitSha: input.commitSha,
          pullRequestNumber: input.pullRequestNumber,
          runtimeId,
          serverId: input.serverId,
          status: "building",
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!environment)
      throw new Error("Unable to materialize Preview environment");

    const baseIdempotencyKey = previewDeploymentIdempotencyKey({
      commitSha: input.commitSha,
      deploymentDigest: input.deploymentDigest,
      environmentId: environment.id,
    });
    const idempotencyKey = manualPreviewIdempotencyKey(
      input.force,
      reopeningEnvironment,
      baseIdempotencyKey,
      deploymentId,
    );
    const [existingDeployment] = await transaction
      .select({
        errorCode: deployments.errorCode,
        errorMessage: deployments.errorMessage,
        id: deployments.id,
        state: deployments.state,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.workspaceId, input.workspaceId),
          eq(deployments.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existingDeployment) {
      const replay = await replayPreviewDeployment(transaction, {
        deployment: existingDeployment,
        environment: {
          id: environment.id,
          status: existingEnvironment?.status ?? environment.status,
        },
        expiresAt,
        input,
        runtimeId,
      });
      if (replay) return replay;
    }

    const [current] = await transaction
      .select({ deploymentDigest: releases.deploymentDigest })
      .from(releases)
      .where(
        and(
          eq(releases.previewEnvironmentId, environment.id),
          eq(releases.status, "current"),
        ),
      )
      .limit(1);
    if (
      !input.force &&
      !reopeningEnvironment &&
      isPreviewReleaseCurrent(current?.deploymentDigest, input.deploymentDigest)
    ) {
      await transaction
        .update(previewEnvironments)
        .set({ status: "healthy", updatedAt: new Date() })
        .where(eq(previewEnvironments.id, environment.id));
      return {
        created: false,
        deferred: false,
        deploymentId: null,
        environmentId: environment.id,
        shouldEnqueue: false,
        supersededDeploymentIds: [],
      };
    }

    cloudflareDnsCredential(input.config);

    const now = new Date();
    const buildServer = await resolveBuildServerAdmission(transaction, {
      deployable: input.config,
      runtimeServerId: input.serverId,
      workspaceId: input.workspaceId,
    });
    const supersededDeployments = await transaction
      .update(deployments)
      .set({
        errorCode: "PREVIEW_SUPERSEDED",
        errorMessage: "Superseded by a newer Preview commit",
        finishedAt: now,
        state: "skipped",
        updatedAt: now,
      })
      .where(
        and(
          eq(deployments.previewEnvironmentId, environment.id),
          eq(deployments.state, "queued"),
        ),
      )
      .returning({ id: deployments.id });
    const [insertedDeployment] = await transaction
      .insert(deployments)
      .values({
        appId: input.appId,
        appSnapshot: input.config,
        requiredSecrets: input.requiredSecrets,
        targetEnvironment: deploymentEnvironmentSnapshot(targetEnvironment),
        commitSha: input.commitSha,
        configDigest: digestValue(input.config),
        deployableKind: "app",
        deploymentDigest: input.deploymentDigest,
        environment: "preview",
        gitRef,
        hostname: input.hostname,
        id: deploymentId,
        idempotencyKey,
        manifestDigest: input.manifestDigest,
        previewEnvironmentId: environment.id,
        requestedBy: input.requestedBy ?? null,
        ...captureQueuedActor(input.workspaceId, ["deployment.create"]),
        serverId: input.serverId,
        serverSnapshot: input.server,
        buildServerId: buildServer?.id,
        buildServerSnapshot: buildServer?.snapshot,
        sourceId: input.sourceId,
        sourceInputDigest: input.sourceInputDigest,
        temporalWorkflowId: deploymentWorkflowId(deploymentId),
        workspaceId: input.workspaceId,
      })
      .onConflictDoNothing({
        target: [deployments.workspaceId, deployments.idempotencyKey],
      })
      .returning({ id: deployments.id });
    if (!insertedDeployment) {
      const [acceptedDeployment] = await transaction
        .select({
          errorCode: deployments.errorCode,
          errorMessage: deployments.errorMessage,
          id: deployments.id,
          state: deployments.state,
        })
        .from(deployments)
        .where(
          and(
            eq(deployments.workspaceId, input.workspaceId),
            eq(deployments.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (!acceptedDeployment) {
        throw new Error("Unable to recover idempotent Preview admission");
      }
      const replay = await replayPreviewDeployment(transaction, {
        deployment: acceptedDeployment,
        environment,
        expiresAt,
        input,
        runtimeId,
      });
      if (!replay)
        throw new Error("Unable to recover active Preview admission");
      return replay;
    }
    await transaction
      .update(previewEnvironments)
      .set({ latestDeploymentId: deploymentId, updatedAt: now })
      .where(eq(previewEnvironments.id, environment.id));
    return {
      created: true,
      deferred: false,
      deploymentId,
      environmentId: environment.id,
      shouldEnqueue: true,
      supersededDeploymentIds: supersededDeployments.map(
        (deployment) => deployment.id,
      ),
    };
  });
}

function isReopeningPreview(status: string | undefined) {
  return status === "deleted" || status === "cleanup_failed";
}

async function assertManualPreviewAdmission(
  transaction: Transaction,
  existingEnvironment:
    Pick<typeof previewEnvironments.$inferSelect, "id" | "status"> | undefined,
) {
  if (
    !existingEnvironment ||
    !["healthy", "failed", "building"].includes(existingEnvironment.status)
  )
    throw conflict("This preview is being removed and cannot be deployed");
  const [active] = await transaction
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.previewEnvironmentId, existingEnvironment.id),
        notInArray(deployments.state, [
          "cancelled",
          "failed",
          "skipped",
          "succeeded",
          "succeeded_with_warnings",
        ]),
      ),
    )
    .limit(1);
  if (active)
    throw conflict(
      "A preview deployment is already active. Secrets are saved; deploy again after it finishes.",
    );
}

async function loadLatestPreviewDeployment(
  transaction: Transaction,
  deploymentId: string | null | undefined,
) {
  if (!deploymentId) return undefined;
  const [deployment] = await transaction
    .select({
      commitSha: deployments.commitSha,
      deploymentDigest: deployments.deploymentDigest,
      errorCode: deployments.errorCode,
      errorMessage: deployments.errorMessage,
      id: deployments.id,
      state: deployments.state,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  return deployment;
}

function manualPreviewIdempotencyKey(
  force: boolean | undefined,
  reopening: boolean,
  base: string,
  deploymentId: string,
) {
  if (force) return `preview:manual:${deploymentId}`;
  return reopening ? `${base}:${deploymentId}` : base;
}

async function replayPreviewDeployment(
  transaction: Transaction,
  replay: {
    deployment: Pick<
      typeof deployments.$inferSelect,
      "errorCode" | "errorMessage" | "id" | "state"
    >;
    environment: Pick<typeof previewEnvironments.$inferSelect, "id" | "status">;
    expiresAt: Date;
    input: {
      branch: string;
      commitSha: string;
      hostname: string;
      pullRequestNumber: number;
      serverId: string;
    };
    runtimeId: string;
  },
) {
  const action = previewAdmissionReplayAction({
    deploymentErrorCode: replay.deployment.errorCode,
    deploymentState: replay.deployment.state,
    environmentStatus: replay.environment.status,
  });
  if (action === "replace") return null;
  const now = new Date();
  if (action === "reset_and_enqueue") {
    await transaction
      .update(deployments)
      .set({
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        startedAt: null,
        state: "queued",
        updatedAt: now,
      })
      .where(eq(deployments.id, replay.deployment.id));
  }
  const succeeded = ["succeeded", "succeeded_with_warnings"].includes(
    replay.deployment.state,
  );
  await transaction
    .update(previewEnvironments)
    .set({
      branch: replay.input.branch,
      deletedAt: null,
      errorMessage:
        action === "reuse" && !succeeded
          ? replay.deployment.errorMessage
          : null,
      expiresAt: replay.expiresAt,
      hostname: replay.input.hostname,
      latestCommitSha: replay.input.commitSha,
      latestDeploymentId: replay.deployment.id,
      pullRequestNumber: replay.input.pullRequestNumber,
      runtimeId: replay.runtimeId,
      serverId: replay.input.serverId,
      status:
        action === "reuse" ? (succeeded ? "healthy" : "failed") : "building",
      updatedAt: now,
    })
    .where(eq(previewEnvironments.id, replay.environment.id));
  return {
    created: false,
    deferred: false,
    deploymentId: replay.deployment.id,
    environmentId: replay.environment.id,
    shouldEnqueue: action !== "reuse",
    supersededDeploymentIds: [],
  };
}

async function lockPreviewTarget(
  transaction: Transaction,
  input: Parameters<typeof admitPreviewDeployment>[0],
) {
  const environment = await getInstanceEnvironment(
    { appId: input.appId, workspaceId: input.workspaceId },
    transaction,
  );
  if (!environment)
    throw conflict(
      "This instance requires an environment mapping",
      "ENVIRONMENT_REQUIRED",
    );
  if (
    !input.targetEnvironment ||
    input.targetEnvironment.id !== environment.id ||
    !environment.previewsEnabled ||
    environment.mappingRevision !== environment.syncedMappingRevision
  )
    throw conflict(
      "The preview target changed. Sync and retry.",
      "PREVIEW_TARGET_CHANGED",
    );
  const current = await lockDeploymentEnvironment(
    input.targetEnvironment,
    transaction,
  );
  if (!current.previewsEnabled)
    throw conflict(
      "Previews are disabled for this environment",
      "PREVIEW_TARGET_CHANGED",
    );
  const [target] = await transaction
    .select()
    .from(apps)
    .where(
      and(eq(apps.id, input.appId), eq(apps.workspaceId, input.workspaceId)),
    )
    .for("update");
  if (
    !target ||
    target.sourceId !== input.sourceId ||
    target.archivedAt ||
    isNormalizedResource(target.config) ||
    !target.config.preview?.enabled ||
    target.configDigest !== input.targetConfigDigest ||
    target.serverId !== input.serverId
  )
    throw conflict(
      "The preview target changed. Retry against the current configuration.",
      "PREVIEW_TARGET_CHANGED",
    );
  return current;
}
