import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  SCOUT_ALERT_RULE_LIMIT_PER_ENTITY,
  type ScoutAlertRuleInput,
  digestValue,
  scoutAlertRuleSchema,
  scoutAnalyticsCapabilities,
  scoutAnalyticsMetricEnabled,
  withScoutAlertDuration,
} from "@workspace/towbar-core";
import {
  apps,
  scoutAlertIncidents,
  scoutAlertRules,
  servers,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { badRequest, conflict, notFound } from "../../http/errors.js";
import { getServer } from "../servers/service.js";
import { notificationProviderAvailability } from "../notifications/configuration.js";
import { notificationRoutesForWorkspace } from "../notifications/email-destinations.js";

export type ScoutScope = { serverId: string; workspaceId: string };
type Database = ReturnType<typeof getTowbarDatabase>;
export type ScoutTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export async function listScoutAlertRules(
  scope: ScoutScope & { deployableId?: string },
) {
  await getServer(scope.serverId, scope.workspaceId);
  const database = getTowbarDatabase();
  const [rules, workloads] = await Promise.all([
    database
      .select()
      .from(scoutAlertRules)
      .where(
        and(
          eq(scoutAlertRules.serverId, scope.serverId),
          eq(scoutAlertRules.workspaceId, scope.workspaceId),
          isNull(scoutAlertRules.deletedAt),
          scope.deployableId === "server"
            ? isNull(scoutAlertRules.deployableId)
            : scope.deployableId
              ? eq(scoutAlertRules.deployableId, scope.deployableId)
              : undefined,
        ),
      )
      .orderBy(desc(scoutAlertRules.createdAt))
      .limit(100),
    database
      .select({
        id: apps.id,
        name: apps.name,
        sourceId: apps.sourceId,
        kind: apps.kind,
        config: apps.config,
      })
      .from(apps)
      .where(
        and(
          eq(apps.workspaceId, scope.workspaceId),
          eq(apps.serverId, scope.serverId),
          isNull(apps.archivedAt),
        ),
      )
      .orderBy(apps.name)
      .limit(512),
  ]);
  const destinations = (await notificationRoutesForWorkspace(scope.workspaceId))
    .filter((route) => route.categories.includes("scout"))
    .map((route) => ({
      categories: route.categories,
      enabled: true,
      id: route.id,
      provider: route.provider,
      source: "environment" as const,
    }));
  const checks = await database.execute<{
    rule_id: string;
    checked_at: string | null;
    state: string;
    status_code: number | null;
    latency_ms: number | null;
    reason: string | null;
  }>(sql`
    select distinct on(c.rule_id) c.rule_id,c.checked_at::text,c.state,c.status_code,c.latency_ms,c.reason
    from towbar_scout_http_checks c join towbar_scout_alert_rules r on r.id=c.rule_id
    where r.server_id=${scope.serverId}::uuid and r.workspace_id=${scope.workspaceId}::uuid and r.deleted_at is null and date_trunc('milliseconds',r.updated_at)=c.rule_revision
    order by c.rule_id,c.scheduled_at desc limit 100`);
  return {
    rules: rules.map((rule) => ({
      ...rule,
      condition: withScoutAlertDuration(rule.condition),
      httpCheck: checks.find((check) => check.rule_id === rule.id) ?? null,
    })),
    workloads: workloads.map(({ config, ...workload }) => ({
      ...workload,
      analytics: scoutAnalyticsCapabilities(config),
    })),
    destinations,
    providers: await notificationProviderAvailability(scope.workspaceId),
  };
}

export async function saveScoutAlertRule(
  input: ScoutScope & {
    ruleId?: string;
    rule: ScoutAlertRuleInput;
    requestedBy: string | null;
  },
) {
  const rule = scoutAlertRuleSchema.parse(input.rule);
  const database = getTowbarDatabase();
  return await database.transaction(async (tx) => {
    // Serialize admission with removal, other rule creates, and workload moves.
    await lockScoutServer(tx, input);
    const workload = await validateWorkload(tx, input, rule.deployableId);
    if (
      rule.enabled &&
      !scoutAnalyticsMetricEnabled(rule.condition.metric, workload?.config)
    )
      throw badRequest(
        "Enable the corresponding analytics collection for this service before creating this alert",
      );
    if (rule.condition.metric === "httpAvailability") {
      const existingHttp = await tx
        .select({ id: scoutAlertRules.id })
        .from(scoutAlertRules)
        .where(
          and(
            eq(scoutAlertRules.serverId, input.serverId),
            isNull(scoutAlertRules.deletedAt),
            sql`${scoutAlertRules.condition}->>'metric'='httpAvailability'`,
          ),
        )
        .limit(11);
      if (existingHttp.filter((item) => item.id !== input.ruleId).length >= 10)
        throw conflict("A server supports up to 10 public HTTP checks");
    }
    let result;
    if (input.ruleId) {
      const [old] = await tx
        .select()
        .from(scoutAlertRules)
        .where(
          and(
            eq(scoutAlertRules.id, input.ruleId),
            eq(scoutAlertRules.serverId, input.serverId),
            eq(scoutAlertRules.workspaceId, input.workspaceId),
            isNull(scoutAlertRules.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!old) throw notFound("Scout alert rule");
      if (old.deployableId !== rule.deployableId)
        await assertEntityRuleCapacity(tx, input, rule.deployableId);
      const conditionChanged =
        digestValue(withScoutAlertDuration(old.condition)) !==
          digestValue(rule.condition) ||
        old.deployableId !== rule.deployableId ||
        old.environment !== "production";
      if (conditionChanged || !rule.enabled)
        await resolveRuleIncidents(
          tx,
          input.ruleId,
          conditionChanged ? "rule_changed" : "rule_disabled",
        );
      [result] = await tx
        .update(scoutAlertRules)
        .set({
          ...rule,
          environment: "production",
          updatedAt: new Date(),
          ...(conditionChanged
            ? {
                evaluatedAt: null,
                evaluationState: "unknown",
                observedValue: null,
              }
            : {}),
        })
        .where(eq(scoutAlertRules.id, input.ruleId))
        .returning();
    } else {
      await assertEntityRuleCapacity(tx, input, rule.deployableId);
      const existing = await tx
        .select({ id: scoutAlertRules.id })
        .from(scoutAlertRules)
        .where(
          and(
            eq(scoutAlertRules.serverId, input.serverId),
            isNull(scoutAlertRules.deletedAt),
          ),
        )
        .limit(100);
      if (existing.length >= 100)
        throw conflict("A server supports up to 100 Scout alert rules");
      [result] = await tx
        .insert(scoutAlertRules)
        .values({
          ...rule,
          environment: "production",
          workspaceId: input.workspaceId,
          serverId: input.serverId,
        })
        .returning();
    }
    if (!result) throw new Error("Scout rule was not saved");
    return result;
  });
}

async function assertEntityRuleCapacity(
  tx: ScoutTransaction,
  scope: ScoutScope,
  deployableId: string | null,
) {
  const rules = await tx
    .select({ id: scoutAlertRules.id })
    .from(scoutAlertRules)
    .where(
      and(
        eq(scoutAlertRules.workspaceId, scope.workspaceId),
        eq(scoutAlertRules.serverId, scope.serverId),
        deployableId
          ? eq(scoutAlertRules.deployableId, deployableId)
          : isNull(scoutAlertRules.deployableId),
        isNull(scoutAlertRules.deletedAt),
      ),
    )
    .limit(SCOUT_ALERT_RULE_LIMIT_PER_ENTITY);
  if (rules.length >= SCOUT_ALERT_RULE_LIMIT_PER_ENTITY)
    throw conflict(
      `Each server, app, or resource supports up to ${SCOUT_ALERT_RULE_LIMIT_PER_ENTITY} Scout alert rules. Delete a rule before adding another.`,
      "SCOUT_ALERT_RULE_LIMIT_REACHED",
    );
}

export async function deleteScoutAlertRule(
  input: ScoutScope & { ruleId: string; requestedBy: string | null },
) {
  await getTowbarDatabase().transaction(async (tx) => {
    await lockScoutServer(tx, input);
    const [row] = await tx
      .update(scoutAlertRules)
      .set({ enabled: false, deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(scoutAlertRules.id, input.ruleId),
          eq(scoutAlertRules.workspaceId, input.workspaceId),
          eq(scoutAlertRules.serverId, input.serverId),
          isNull(scoutAlertRules.deletedAt),
        ),
      )
      .returning({ id: scoutAlertRules.id });
    if (!row) throw notFound("Scout alert rule");
    await resolveRuleIncidents(tx, row.id, "rule_deleted");
  });
}

export async function listScoutIncidents(
  input: ScoutScope & {
    state: "active" | "resolved" | "all";
    limit: number;
    before?: string;
    beforeId?: string;
    ruleId?: string;
    deployableId?: string;
  },
) {
  await getServer(input.serverId, input.workspaceId);
  const limit = Math.max(1, Math.min(50, input.limit));
  const rows = await getTowbarDatabase()
    .select()
    .from(scoutAlertIncidents)
    .where(
      and(
        eq(scoutAlertIncidents.workspaceId, input.workspaceId),
        eq(scoutAlertIncidents.serverId, input.serverId),
        input.state === "active"
          ? isNull(scoutAlertIncidents.resolvedAt)
          : input.state === "resolved"
            ? sql`${scoutAlertIncidents.resolvedAt} is not null`
            : undefined,
        input.before
          ? or(
              lt(scoutAlertIncidents.openedAt, new Date(input.before)),
              input.beforeId
                ? and(
                    eq(scoutAlertIncidents.openedAt, new Date(input.before)),
                    lt(scoutAlertIncidents.id, input.beforeId),
                  )
                : undefined,
            )
          : undefined,
        input.ruleId ? eq(scoutAlertIncidents.ruleId, input.ruleId) : undefined,
        input.deployableId === "server"
          ? isNull(scoutAlertIncidents.deployableId)
          : input.deployableId
            ? eq(scoutAlertIncidents.deployableId, input.deployableId)
            : undefined,
      ),
    )
    .orderBy(desc(scoutAlertIncidents.openedAt), desc(scoutAlertIncidents.id))
    .limit(limit + 1);
  return {
    incidents: rows.slice(0, limit).map((incident) => ({
      ...incident,
      condition: withScoutAlertDuration(incident.condition),
    })),
    nextBefore:
      rows.length > limit ? rows[limit - 1]!.openedAt.toISOString() : null,
    nextBeforeId: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}

async function lockScoutServer(tx: ScoutTransaction, scope: ScoutScope) {
  const [server] = await tx
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.id, scope.serverId),
        eq(servers.workspaceId, scope.workspaceId),
        isNull(servers.archivedAt),
      ),
    )
    .for("update")
    .limit(1);
  if (!server) throw notFound("Server");
  return server;
}
async function validateWorkload(
  tx: ScoutTransaction,
  scope: ScoutScope,
  deployableId: string | null,
) {
  if (!deployableId) return null;
  const [app] = await tx
    .select({ sourceId: apps.sourceId, config: apps.config })
    .from(apps)
    .where(
      and(
        eq(apps.id, deployableId),
        eq(apps.serverId, scope.serverId),
        eq(apps.workspaceId, scope.workspaceId),
        isNull(apps.archivedAt),
      ),
    )
    .for("share")
    .limit(1);
  if (!app)
    throw badRequest("Choose an active workload assigned to this server");
  return app;
}
export async function resolveRuleIncidents(
  tx: ScoutTransaction,
  ruleId: string,
  reason: string,
  now = new Date(),
) {
  await tx
    .update(scoutAlertIncidents)
    .set({ resolvedAt: now, resolutionReason: reason })
    .where(
      and(
        eq(scoutAlertIncidents.ruleId, ruleId),
        isNull(scoutAlertIncidents.resolvedAt),
      ),
    );
}
