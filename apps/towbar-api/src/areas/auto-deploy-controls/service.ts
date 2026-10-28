import { requireActor } from "../auth/actor-context.js";
import { and, eq, isNull } from "drizzle-orm";
import { evaluateAutoDeployPause } from "@workspace/towbar-core";
import type {
  AutoDeployPauseGate,
  DeferredAutomaticDeployment,
} from "@workspace/towbar-core";
import {
  apps,
  sourceEnvironments,
  sourceSyncs,
  sources,
} from "@workspace/towbar-database/schema";
import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";

export async function getSourceAutoDeployControl(
  sourceId: string,
  workspaceId: string,
) {
  const [source] = await getTowbarDatabase()
    .select({ paused: sources.autoDeployPaused })
    .from(sources)
    .where(
      and(
        eq(sources.id, sourceId),
        eq(sources.workspaceId, workspaceId),
        eq(sources.status, "active"),
      ),
    )
    .limit(1);
  if (!source) throw notFound("Source");
  return {
    effective: {
      ...evaluateAutoDeployPause({ sourcePaused: source.paused }),
      pending: null,
    },
    paused: source.paused,
  };
}

export async function getDeployableAutoDeployControl(input: {
  deployableId: string;
  expectedType: "app" | "resource";
  workspaceId: string;
}) {
  const target = await loadDeployableControl(input);
  return {
    effective: {
      ...evaluateAutoDeployPause({
        deployablePaused: target.paused,
        sourcePaused: target.sourcePaused,
        environmentPaused: target.environmentPaused,
      }),
      pending: target.pending,
    },
    manifestAutoDeployEnabled: Boolean(target.config.autoDeploy),
    paused: target.paused,
  };
}

export async function updateSourceAutoDeployControl(input: {
  paused: boolean;
  sourceId: string;
  workspaceId: string;
}) {
  const shouldReevaluate = await getTowbarDatabase().transaction(
    async (transaction) => {
      const [source] = await transaction
        .select({ id: sources.id, paused: sources.autoDeployPaused })
        .from(sources)
        .where(
          and(
            eq(sources.id, input.sourceId),
            eq(sources.workspaceId, input.workspaceId),
            eq(sources.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!source) throw notFound("Source");
      await transaction
        .update(sources)
        .set({ autoDeployPaused: input.paused, updatedAt: new Date() })
        .where(eq(sources.id, source.id));
      return source.paused && !input.paused;
    },
  );
  return {
    ...(await getSourceAutoDeployControl(input.sourceId, input.workspaceId)),
    shouldReevaluate,
  };
}

export async function updateDeployableAutoDeployControl(input: {
  deployableId: string;
  expectedType: "app" | "resource";
  paused: boolean;
  workspaceId: string;
}) {
  const shouldReevaluate = await getTowbarDatabase().transaction(
    async (transaction) => {
      const [target] = await transaction
        .select({ id: apps.id, kind: apps.kind, paused: apps.autoDeployPaused })
        .from(apps)
        .where(
          and(
            eq(apps.id, input.deployableId),
            eq(apps.workspaceId, input.workspaceId),
          ),
        )
        .for("update")
        .limit(1);
      if (!target || !matchesExpectedType(target.kind, input.expectedType)) {
        throw notFound(input.expectedType === "app" ? "App" : "Resource");
      }
      await transaction
        .update(apps)
        .set({ autoDeployPaused: input.paused, updatedAt: new Date() })
        .where(eq(apps.id, target.id));
      return target.paused && !input.paused;
    },
  );
  return {
    ...(await getDeployableAutoDeployControl(input)),
    shouldReevaluate,
  };
}

export function createDeferredAutomaticDeployment(input: {
  commitSha: string;
  deploymentDigest: string;
  gate: Extract<AutoDeployPauseGate, { paused: true }>;
  manifestId: string;
  now?: Date;
}): DeferredAutomaticDeployment {
  return {
    commitSha: input.commitSha,
    deploymentDigest: input.deploymentDigest,
    deferredAt: (input.now ?? new Date()).toISOString(),
    manifestId: input.manifestId,
    reason: "paused",
    scope: input.gate.scope,
  };
}

async function loadDeployableControl(input: {
  deployableId: string;
  expectedType: "app" | "resource";
  workspaceId: string;
}) {
  const [target] = await getTowbarDatabase()
    .select({
      config: apps.config,
      kind: apps.kind,
      paused: apps.autoDeployPaused,
      pending: apps.deferredAutomaticDeployment,
      sourcePaused: sources.autoDeployPaused,
      environmentPaused: sourceEnvironments.autoDeployPaused,
    })
    .from(apps)
    .innerJoin(sources, eq(sources.id, apps.sourceId))
    .innerJoin(
      sourceEnvironments,
      eq(sourceEnvironments.id, apps.sourceEnvironmentId),
    )
    .where(
      and(
        eq(apps.id, input.deployableId),
        eq(apps.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!target || !matchesExpectedType(target.kind, input.expectedType)) {
    throw notFound(input.expectedType === "app" ? "App" : "Resource");
  }
  return target;
}

function matchesExpectedType(
  kind: import("@workspace/towbar-core").DeployableKind,
  expected: "app" | "resource",
) {
  return expected === "app"
    ? kind === "app" || kind === "compose"
    : kind !== "app" && kind !== "compose";
}

export async function updateEnvironmentAutomation(input: {
  sourceId: string;
  environmentId: string;
  workspaceId: string;
  expectedRevision: string;
  paused: boolean;
}) {
  requireActor(input.workspaceId, ["admin"]);
  await getTowbarDatabase().transaction(async (tx) => {
    const [environment] = await tx
      .select({
        environment: sourceEnvironments,
        workspaceId: sources.workspaceId,
      })
      .from(sourceEnvironments)
      .innerJoin(sources, eq(sources.id, sourceEnvironments.sourceId))
      .where(
        and(
          eq(sourceEnvironments.id, input.environmentId),
          eq(sources.id, input.sourceId),
          eq(sources.workspaceId, input.workspaceId),
          isNull(sourceEnvironments.disconnectedAt),
        ),
      )
      .for("update");
    if (!environment) throw notFound("Environment");
    if (environment.environment.mappingRevision !== input.expectedRevision)
      throw conflict(
        "The branch mapping changed. Refresh and review it before continuing",
        "ENVIRONMENT_MAPPING_CHANGED",
      );
    if (!input.paused) {
      const [sync] = environment.environment.latestSuccessfulSyncId
        ? await tx
            .select({ revision: sourceSyncs.mappingRevision })
            .from(sourceSyncs)
            .where(
              eq(
                sourceSyncs.id,
                environment.environment.latestSuccessfulSyncId,
              ),
            )
        : [];
      if (!sync || sync.revision !== input.expectedRevision)
        throw conflict(
          "Sync the current branch mapping before enabling runtime automation",
          "ENVIRONMENT_SYNC_REQUIRED",
        );
    }
    await tx
      .update(sourceEnvironments)
      .set({ autoDeployPaused: input.paused, updatedAt: new Date() })
      .where(eq(sourceEnvironments.id, input.environmentId));
  });
}
