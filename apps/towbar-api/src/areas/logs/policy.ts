import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  apps,
  logPolicies,
  logRetentionState,
  logSources,
} from "@workspace/towbar-database/schema";
import { actorAllows } from "@workspace/towbar-access";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { requireActor } from "../auth/actor-context.js";

export async function retainLogCutoff(
  workspaceId: string,
  retentionDays: number,
  now = new Date(),
) {
  const cutoffAt = new Date(now.getTime() - retentionDays * 86400000);
  const [state] = await getTowbarDatabase()
    .insert(logRetentionState)
    .values({ workspaceId, cutoffAt })
    .onConflictDoUpdate({
      target: logRetentionState.workspaceId,
      set: {
        cutoffAt: sql`greatest(${logRetentionState.cutoffAt}, ${cutoffAt.toISOString()}::timestamptz)`,
      },
    })
    .returning({ cutoffAt: logRetentionState.cutoffAt });
  return state!.cutoffAt;
}

export async function synchronizeLogPolicies(workspaceId: string) {
  const db = getTowbarDatabase();
  const workloads = await db
    .select({ id: apps.id, config: apps.config })
    .from(apps)
    .where(eq(apps.workspaceId, workspaceId));
  const restricted = workloads.filter(
    (app) => app.config.logs?.restrict === "admin",
  );
  if (restricted.length)
    await db
      .insert(logPolicies)
      .values(
        restricted.map(({ id }) => ({
          workspaceId,
          workloadId: id,
          restricted: true,
        })),
      )
      .onConflictDoUpdate({
        target: [logPolicies.workspaceId, logPolicies.workloadId],
        set: { restricted: true, updatedAt: new Date() },
      });
  return workloads;
}

export async function logReadScope(workspaceId: string) {
  const actor = requireActor(workspaceId, ["logs.read"]);
  await synchronizeLogPolicies(workspaceId);
  const db = getTowbarDatabase();
  const [policies, sources] = await Promise.all([
    db
      .select({ id: logPolicies.workloadId })
      .from(logPolicies)
      .where(
        and(
          eq(logPolicies.workspaceId, workspaceId),
          eq(logPolicies.restricted, true),
        ),
      ),
    db
      .selectDistinct({ id: logSources.workloadId })
      .from(logSources)
      .where(eq(logSources.workspaceId, workspaceId)),
  ]);
  return {
    administrator: actorAllows(actor, ["logs.readAdmin"]),
    restrictedIds: policies.map((p) => p.id),
    knownIds: sources.map((s) => s.id),
  };
}

export async function sourcePolicies(
  workspaceId: string,
  workloadIds: string[],
) {
  await synchronizeLogPolicies(workspaceId);
  if (!workloadIds.length) return new Set<string>();
  const policies = await getTowbarDatabase()
    .select({ id: logPolicies.workloadId })
    .from(logPolicies)
    .where(
      and(
        eq(logPolicies.workspaceId, workspaceId),
        eq(logPolicies.restricted, true),
        inArray(logPolicies.workloadId, workloadIds),
      ),
    );
  return new Set(policies.map((p) => p.id));
}

export async function currentLogSequence(workspaceId: string) {
  const [state] = await getTowbarDatabase()
    .select({ value: logRetentionState.committedSequence })
    .from(logRetentionState)
    .where(eq(logRetentionState.workspaceId, workspaceId));
  return String(state?.value ?? 0);
}

export function logAccessRevision(scope: {
  administrator: boolean;
  restrictedIds: string[];
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        administrator: scope.administrator,
        restrictedIds: [...scope.restrictedIds].sort(),
      }),
    )
    .digest("hex");
}
