import {
  analyticsCells,
  analyticsConditions,
  analyticsDimension,
} from "./filters.js";
import { getAnalyticsEngagement } from "./engagement.js";
import { getDeploymentEvents } from "../monitoring/deployment-events.js";
import { type SQL, and, eq, isNull, sql } from "drizzle-orm";
import {
  type AnalyticsConfig,
  type AnalyticsFilter,
  type AnalyticsReport,
  type MonitoringSample,
  analyticsHttpFilterFields,
  analyticsLatencyBounds,
  analyticsResponseTimeRanges,
  analyticsWebFilterFields,
  isNormalizedApp,
} from "@workspace/towbar-core";
import {
  analyticsRefresh,
  analyticsSamples,
  apps,
  monitoringAgents,
} from "@workspace/towbar-database/schema";
import {
  type AuthDatabase,
  getTowbarDatabase,
} from "../../infrastructure/database.js";
import { badRequest, notFound } from "../../http/errors.js";

export async function getAnalyticsConfiguration(serverId: string) {
  const database = getTowbarDatabase();
  const services = await database
    .select({ id: apps.id, config: apps.config })
    .from(apps)
    .where(and(eq(apps.serverId, serverId), isNull(apps.archivedAt)));
  const [refresh] = await database.select().from(analyticsRefresh).limit(1);
  return {
    refresh: refresh?.requestedAt.toISOString() ?? "initial",
    services: services.flatMap(({ id, config }) =>
      isNormalizedApp(config) && config.analytics && config.domains
        ? [
            {
              id,
              host: config.domains.primary,
              cloudflareProxy:
                config.tls?.mode === "cloudflare-dns" &&
                config.tls.proxied !== false,
              cloudflareTunnel: config.ingress?.type === "cloudflare-tunnel",
              ...config.analytics,
            },
          ]
        : [],
    ),
  };
}

export async function ingestAnalytics(
  database: AuthDatabase,
  serverId: string,
  sample: MonitoringSample,
) {
  if (!sample.analytics?.length && sample.analyticsListenerReady === undefined)
    return;
  const services = await database
    .select()
    .from(apps)
    .where(and(eq(apps.serverId, serverId), isNull(apps.archivedAt)));
  for (const app of services) {
    if (!isNormalizedApp(app.config) || !app.config.analytics) continue;
    const config = app.config.analytics;
    const ready = sample.analyticsServices?.find(
      (service) => service.appId === app.id,
    );
    const cells = (sample.analytics ?? [])
      .filter(
        (cell) =>
          cell.appId === app.id &&
          (cell.kind === "request" || config.pageviews) &&
          !isExcludedPath(cell.path, config.excludePaths) &&
          !cell.path.startsWith("/.well-known/towbar-analytics"),
      )
      .map((cell) => ({
        ...cell,
        visitor: config.visitorIdentity ? cell.visitor : "",
        session: config.visitorIdentity ? cell.session : "",
      }));
    await database
      .insert(analyticsSamples)
      .values({
        serverId,
        sampleId: sample.id,
        appId: app.id,
        collectedAt: new Date(sample.collectedAt),
        coverage: {
          requests: sample.analyticsListenerReady === true && Boolean(ready),
          pageviews:
            sample.analyticsListenerReady === true &&
            Boolean(ready?.pageviews) &&
            config.pageviews,
          dropped: sample.analyticsDropped ?? 0,
        },
        cells,
      })
      .onConflictDoNothing();
  }
}

export async function maintainAnalytics() {
  const database = getTowbarDatabase();
  await database.execute(sql`delete from towbar_analytics_samples s using towbar_apps a
    where a.id=s.app_id and s.collected_at < now() - make_interval(days => least(90, greatest(7, coalesce((a.config->'analytics'->>'retentionDays')::int,30))))`);
  // The durable Temporal workflow advances this marker once per day. Agents check it
  // when polling configuration and validate/replace their local database atomically.
  await database
    .insert(analyticsRefresh)
    .values({ id: 1, requestedAt: new Date() })
    .onConflictDoUpdate({
      target: analyticsRefresh.id,
      set: { requestedAt: new Date() },
    });
  return { ok: true };
}

function percentile(histogram: number[], fraction: number) {
  const total = histogram.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let count = 0;
  for (const [index, value] of histogram.entries()) {
    count += value;
    if (count >= total * fraction) return analyticsLatencyBounds[index] ?? null;
  }
  return null;
}

function trendStep(days: number) {
  if (days <= 1 / 96) return 60;
  if (days <= 1 / 24) return 120;
  if (days <= 1 / 8) return 600;
  if (days <= 1 / 2) return 1800;
  if (days <= 1) return 3600;
  return 86400;
}

export async function getAnalyticsReport(input: {
  appId: string;
  workspaceId: string;
  days: number;
  kind: "request" | "pageview";
  filters?: AnalyticsFilter[];
}): Promise<AnalyticsReport> {
  assertFilterFields(
    input.kind,
    (input.filters ?? []).map((filter) => filter.field),
  );
  const database = getTowbarDatabase();
  const [app] = await database
    .select()
    .from(apps)
    .where(
      and(
        eq(apps.id, input.appId),
        eq(apps.workspaceId, input.workspaceId),
        isNull(apps.archivedAt),
      ),
    )
    .limit(1);
  if (!app || !isNormalizedApp(app.config)) throw notFound("Service");
  const config = app.config.analytics ?? null;
  const [agent] = await database
    .select()
    .from(monitoringAgents)
    .where(eq(monitoringAgents.serverId, app.serverId))
    .limit(1);
  const end = new Date();
  const start = new Date(
    end.getTime() -
      Math.min(input.days, config?.retentionDays ?? 30) * 86400_000,
  );
  const conditions = analyticsConditions(input.filters ?? [], {
    appId: app.id,
    start,
    end,
  });
  const cells = analyticsCells(input.filters ?? []);
  const currentPeriod = sql`s.app_id=${app.id}::uuid and s.collected_at>=${start.toISOString()}::timestamptz and s.collected_at<${end.toISOString()}::timestamptz and c->>'kind'=${input.kind}`;
  const filter = sql`${currentPeriod} and ${conditions}`;
  const step = trendStep(input.days);
  const includeIdentity = hasVisitorIdentity(config, input.kind);
  const { totals, trend } = await periodSummary(
    database,
    filter,
    start,
    end,
    step,
    cells,
    includeIdentity,
  );
  const previousStart = new Date(
    start.getTime() - (end.getTime() - start.getTime()),
  );
  const canCompare =
    Boolean(config) &&
    previousStart.getTime() >=
      end.getTime() - (config?.retentionDays ?? 30) * 86400_000;
  const previousPeriod = sql`s.app_id=${app.id}::uuid and s.collected_at>=${previousStart.toISOString()}::timestamptz and s.collected_at<${start.toISOString()}::timestamptz and c->>'kind'=${input.kind}`;
  const previousConditions = analyticsConditions(input.filters ?? [], {
    appId: app.id,
    start: previousStart,
    end: start,
  });
  const previous = canCompare
    ? await periodSummary(
        database,
        sql`${previousPeriod} and ${previousConditions}`,
        previousStart,
        start,
        step,
        cells,
        includeIdentity,
      )
    : null;
  const previousHasData = Boolean(previous?.totals.last);
  const histogramRows = await database.execute<{
    idx: number;
    count: string;
  }>(sql`
    select h.ordinality::int idx,sum(h.value::text::bigint)::text count from towbar_analytics_samples s
    cross join lateral ${cells} cross join lateral jsonb_array_elements(c->'histogram') with ordinality h(value,ordinality)
    where ${filter} group by h.ordinality order by h.ordinality`);
  const histogram = Array<number>(analyticsLatencyBounds.length + 1).fill(0);
  for (const row of histogramRows) histogram[row.idx - 1] = Number(row.count);
  const dimensions = await reportDimensions(
    database,
    input.kind,
    filter,
    cells,
  );
  const engagement = await getAnalyticsEngagement(database, {
    appId: app.id,
    kind: input.kind,
    config,
    start,
    end,
    conditions,
  });
  const previousEngagement = await getAnalyticsEngagement(database, {
    appId: app.id,
    kind: input.kind,
    config,
    available: previousHasData,
    start: previousStart,
    end: start,
    retentionEnd: end,
    conditions: previousConditions,
  });
  return {
    ...engagement,
    filters: input.filters ?? [],
    enabled: Boolean(config),
    config,
    ...agentDiagnostics(agent),
    lastReceivedAt: totals?.last ? new Date(totals.last).toISOString() : null,
    start: start.toISOString(),
    end: end.toISOString(),
    kind: input.kind,
    ...summaryMetrics(totals, input.kind, config),
    bytes: totals.bytes === null ? null : Number(totals.bytes),
    p50Ms: percentile(histogram, 0.5),
    p95Ms: percentile(histogram, 0.95),
    histogram,
    trend,
    deployments: config
      ? await getDeploymentEvents(database, {
          workspaceId: input.workspaceId,
          serverId: app.serverId,
          deployableId: app.id,
          start,
          end,
          limit: 20,
        })
      : [],
    comparison:
      previous && previousHasData
        ? {
            start: previousStart.toISOString(),
            end: start.toISOString(),
            ...summaryMetrics(previous.totals, input.kind, config),
            bounceRate: previousEngagement.bounceRate,
            averageTimeMs: previousEngagement.averageTimeMs,
            trend: previous.trend,
          }
        : null,
    dimensions,
  };
}

export async function getAnalyticsFilterOptions(input: {
  appId: string;
  workspaceId: string;
  days: number;
  kind: "request" | "pageview";
  field: Exclude<AnalyticsFilter["field"], "path">;
  search: string;
}) {
  assertFilterFields(input.kind, [input.field]);
  const database = getTowbarDatabase();
  const [app] = await database
    .select({ config: apps.config })
    .from(apps)
    .where(
      and(
        eq(apps.id, input.appId),
        eq(apps.workspaceId, input.workspaceId),
        isNull(apps.archivedAt),
      ),
    )
    .limit(1);
  if (!app || !isNormalizedApp(app.config)) throw notFound("Service");
  const retention = app.config.analytics?.retentionDays ?? 30;
  const end = new Date();
  const start = new Date(
    end.getTime() - Math.min(input.days, retention) * 86400_000,
  );
  if (input.field === "responseTime")
    return analyticsResponseTimeRanges.filter((range) =>
      range.toLowerCase().includes(input.search.toLowerCase()),
    );
  const field = analyticsDimension(input.field);
  const rows = await database.execute<{ value: string }>(sql`
    select ${field} value from towbar_analytics_samples s
    cross join lateral jsonb_array_elements(s.cells) c
    where s.app_id=${input.appId}::uuid and s.collected_at>=${start.toISOString()}::timestamptz
      and s.collected_at<${end.toISOString()}::timestamptz
      and c->>'kind'=${input.field === "destination" ? "outbound" : input.kind}
      and position(lower(${input.search}::text) in lower(${field})) > 0
    group by 1 order by sum((c->>'count')::bigint) desc,1 limit ${input.field === "country" ? 250 : 50}`);
  return rows.map((row) => row.value);
}

async function reportDimensions(
  database: AuthDatabase,
  kind: "request" | "pageview",
  filter: SQL,
  cells: SQL,
) {
  const dimensions: AnalyticsReport["dimensions"] = {};
  for (const key of kind === "request"
    ? ["path", "referrer", "status", "method"]
    : ["path", "referrer", "country", "city", "browser", "device"]) {
    const dimension = analyticsDimension(key);
    const rows = await database.execute<{ value: string; count: string }>(sql`
      select ${dimension} value,sum((c->>'count')::bigint)::text count
      from towbar_analytics_samples s cross join lateral ${cells} where ${filter}
      group by 1 order by sum((c->>'count')::bigint) desc,1 limit 25`);
    dimensions[key] = rows.map((r) => ({
      value: r.value,
      count: Number(r.count),
    }));
  }
  return dimensions;
}

function assertFilterFields(
  kind: "request" | "pageview",
  fields: AnalyticsFilter["field"][],
) {
  const available =
    kind === "request" ? analyticsHttpFilterFields : analyticsWebFilterFields;
  if (fields.some((field) => !available.some((allowed) => allowed === field)))
    throw badRequest(
      "Choose filters available for the selected analytics measure.",
    );
}

function agentDiagnostics(
  agent: typeof monitoringAgents.$inferSelect | undefined,
) {
  const stale =
    agent?.status === "online" &&
    (!agent.lastCollectedAt ||
      Date.now() - agent.lastCollectedAt.getTime() > 90_000);
  const outdated = agent?.installedVersion?.startsWith("1.0.");
  return {
    agentStatus: outdated
      ? "needs an update"
      : stale
        ? "offline"
        : (agent?.status ?? "disabled"),
    droppedSamples: agent?.diagnostics?.droppedSamples ?? 0,
    collectionErrors: agent?.diagnostics?.collectionErrors ?? 0,
    droppedEvents: agent?.diagnostics?.analyticsDropped ?? 0,
    geolocationBuiltAt: agent?.diagnostics?.analyticsGeoBuiltAt ?? null,
    collectionReady: agent?.diagnostics?.analyticsListenerReady ?? false,
  };
}

function isExcludedPath(path: string, prefixes: string[]) {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  return prefixes.some(
    (prefix) => path.startsWith(prefix) || decoded.startsWith(prefix),
  );
}

type PeriodTotals = {
  count: string;
  bytes: string | null;
  duration: string | null;
  errors: string;
  visitors: string;
  sessions: string;
  last: string | null;
};
function hasVisitorIdentity(
  config: AnalyticsConfig | null,
  kind: "request" | "pageview",
) {
  return Boolean(config?.visitorIdentity && kind === "pageview");
}
function summaryMetrics(
  totals: PeriodTotals,
  kind: "request" | "pageview",
  config: AnalyticsConfig | null,
) {
  const total = Number(totals.count);
  const includeIdentity = hasVisitorIdentity(config, kind);
  return {
    total,
    errors: Number(totals.errors),
    meanMs:
      kind === "request" && total && totals.duration !== null
        ? Number(totals.duration) / total
        : null,
    visitors: includeIdentity ? Number(totals.visitors) : null,
    sessions: includeIdentity ? Number(totals.sessions) : null,
  };
}
async function periodSummary(
  database: AuthDatabase,
  filter: SQL,
  start: Date,
  end: Date,
  step: number,
  cells: SQL,
  includeIdentity: boolean,
) {
  const [
    totals = {
      count: "0",
      bytes: "0",
      duration: "0",
      errors: "0",
      visitors: "0",
      sessions: "0",
      last: null,
    },
  ] = await database.execute<{
    count: string;
    bytes: string | null;
    duration: string | null;
    errors: string;
    visitors: string;
    sessions: string;
    last: string | null;
  }>(sql`
    select coalesce(sum((c->>'count')::bigint),0)::text count, case when bool_or(c->>'bytes' is null) then null else coalesce(sum((c->>'bytes')::bigint),0)::text end bytes,
      case when bool_or(c->>'durationMs' is null) then null else coalesce(sum((c->>'durationMs')::double precision),0)::text end duration,
      coalesce(sum((c->>'count')::bigint) filter(where (c->>'status')::int >= 400),0)::text errors,
      count(distinct nullif(c->>'visitor',''))::text visitors, count(distinct nullif(c->>'session',''))::text sessions,
      max(s.collected_at)::text last
    from towbar_analytics_samples s cross join lateral ${cells} where ${filter}`);
  const trendRows = await database.execute<{
    at: string;
    count: string;
    errors: string;
    visitors: string;
    sessions: string;
  }>(sql`
    select (${start.toISOString()}::timestamptz + floor(extract(epoch from (s.collected_at - ${start.toISOString()}::timestamptz))/${step}) * ${step} * interval '1 second')::text at,
      sum((c->>'count')::bigint)::text count, coalesce(sum((c->>'count')::bigint) filter(where (c->>'status')::int>=400),0)::text errors,
      count(distinct nullif(c->>'visitor',''))::text visitors, count(distinct nullif(c->>'session',''))::text sessions
    from towbar_analytics_samples s cross join lateral ${cells} where ${filter} group by at order by at`);

  const points = new Map(
    trendRows.map((row) => [new Date(row.at).getTime(), row]),
  );
  const trend = [];
  for (let at = start.getTime(); at < end.getTime(); at += step * 1000) {
    const row = points.get(at);
    trend.push({
      at: new Date(at).toISOString(),
      count: Number(row?.count ?? 0),
      errors: Number(row?.errors ?? 0),
      visitors: includeIdentity ? Number(row?.visitors ?? 0) : null,
      sessions: includeIdentity ? Number(row?.sessions ?? 0) : null,
    });
  }
  return { totals, trend };
}
