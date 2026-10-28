"use client";

import {
  MonitoringEventMarker,
  monitoringEventColor,
} from "./monitoring-events";
import { PageSelectionTitle } from "./page-selection-title";
import {
  ChartNoAxesColumnIcon,
  ApiIcon,
  BrowserIcon,
  City01Icon,
  Clock01Icon,
  ComputerIcon,
  EqualSignIcon,
  Flag01Icon,
  FilterIcon,
  FilterRemoveIcon,
  Globe02Icon,
  LinkSquare02Icon,
  ListViewIcon,
  Route01Icon,
  TextAlignLeftIcon,
  CodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useId, useState } from "react";
import { usePageQuery, useQueryChoice } from "@/hooks/use-page-query";
import { analyticsUrlState } from "@/lib/page-query-state";
import styles from "./scout-analytics.module.css";
import {
  analyticsHttpFilterFields,
  analyticsWebFilterFields,
  analyticsResponseTimeRanges,
  type AnalyticsReport,
  type AnalyticsFilter,
} from "@workspace/towbar-web-client";
import {
  FilterDialog,
  type FilterField,
} from "@avgeek-oss/design-system/patterns/filters/filter-dialog";
import { CodePanel } from "@workspace/towbar-web-ui/code-panel";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { LineChart } from "@avgeek-oss/design-system/charts/line-chart";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Table } from "@avgeek-oss/design-system/data-display/table";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";
import {
  Tooltip,
  TooltipText,
} from "@avgeek-oss/design-system/overlays/tooltip";
import { HeadingHelp } from "@avgeek-oss/design-system/overlays/heading-help";
import { AnalyticsRowIcon } from "./analytics-row-icon";

import { ScoutSelect } from "./scout-controls";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import {
  analyticsRowFilterMatches,
  toggleAnalyticsRowFilter,
} from "@/lib/analytics-row-filter";

const axisTick = { fill: "var(--muted)", fontSize: 10 };
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const labels: Record<string, string> = {
  path: "Paths",
  referrer: "Referring websites",
  status: "Response codes",
  method: "Methods",
  country: "Countries",
  city: "Cities",
  browser: "Browsers",
  device: "Devices",
};
const latencyLabels = analyticsResponseTimeRanges;
const analyticsRanges = [
  { days: 1 / 96, label: "Last 15 mins" },
  { days: 1 / 24, label: "Last 1 hour" },
  { days: 1 / 8, label: "Last 3 hours" },
  { days: 1 / 2, label: "Last 12 hours" },
  { days: 1, label: "Last 24 hours" },
  { days: 7, label: "Last 7 days" },
  { days: 14, label: "Last 14 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
] as const;
const format = (n: number) => n.toLocaleString();
const filterIcons = {
  path: Route01Icon,
  referrer: Globe02Icon,
  status: CodeIcon,
  method: ApiIcon,
  responseTime: Clock01Icon,
  country: Flag01Icon,
  city: City01Icon,
  browser: BrowserIcon,
  device: ComputerIcon,
  destination: LinkSquare02Icon,
} satisfies Record<AnalyticsFilter["field"], typeof FilterIcon>;
const filterIcon = (icon: typeof FilterIcon) => (
  <HugeiconsIcon
    icon={icon}
    className="size-4 shrink-0 text-muted"
    aria-hidden="true"
  />
);
const pathFilterField: FilterField<
  AnalyticsFilter["field"],
  AnalyticsFilter["operator"]
> = {
  field: "path",
  label: "Path",
  icon: filterIcon(filterIcons.path),
  operators: [
    { value: "equals", label: "is", icon: filterIcon(EqualSignIcon) },
    {
      value: "startsWith",
      label: "starts with",
      icon: filterIcon(TextAlignLeftIcon),
    },
  ],
  placeholder: "/docs",
  pattern: "/[^?#\\r\\n]*",
  maxLength: 256,
};

export function ScoutAnalytics({
  appId,
  domain,
  supported = true,
}: {
  appId: string;
  domain?: string;
  supported?: boolean;
}) {
  const { search, update } = usePageQuery();
  const { kind, days, filters } = analyticsUrlState(search);
  const setFilters = (
    next: AnalyticsFilter[] | ((old: AnalyticsFilter[]) => AnalyticsFilter[]),
  ) => {
    const value = typeof next === "function" ? next(filters) : next;
    update({ filters: value.length ? JSON.stringify(value) : null });
  };
  const filterLabels: Record<AnalyticsFilter["field"], string> = {
    path: "Path",
    referrer: "Referring website",
    status: "Response code",
    method: "Method",
    responseTime: "Response time",
    country: "Country",
    city: "City",
    browser: "Browser",
    device: "Device",
    destination: "Outbound website",
  };
  const filterFields: FilterField<
    AnalyticsFilter["field"],
    AnalyticsFilter["operator"]
  >[] = (
    kind === "request" ? analyticsHttpFilterFields : analyticsWebFilterFields
  ).map((field) =>
    field === "path"
      ? pathFilterField
      : {
          field,
          label: filterLabels[field],
          icon: filterIcon(filterIcons[field]),
          operators: [
            {
              value: "in",
              label: "is one of",
              icon: filterIcon(ListViewIcon),
              multiple: true,
            },
          ],
          searchable: true,
        },
  );
  const getFilterOptions = useCallback(
    async (field: AnalyticsFilter["field"], search: string) => {
      if (field === "path") return [];
      const params = new URLSearchParams({
        field,
        kind,
        days: String(days),
        search: field === "country" ? "" : search,
      });
      const { options } = await api.get<{ options: string[] }>(
        `/v1/core/apps/${appId}/analytics/filter-options?${params}`,
      );
      return field === "country"
        ? options.filter((code) =>
            `${code} ${/^[A-Z]{2}$/u.test(code) ? (countryNames.of(code) ?? "") : ""}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
        : options;
    },
    [appId, days, kind],
  );
  const params = new URLSearchParams({ kind, days: String(days) });
  if (filters.length) params.set("filters", JSON.stringify(filters));
  const query = useApiQuery<AnalyticsReport>(
    supported ? `/v1/core/apps/${appId}/analytics?${params}` : null,
  );
  if (!supported)
    return (
      <>
        <PageSelectionTitle
          label="Analytics"
          icon={
            <HugeiconsIcon aria-hidden="true" icon={ChartNoAxesColumnIcon} />
          }
          keepEntityName
        />
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title>
              Analytics is available for single-container services
            </EmptyState.Title>
            <EmptyState.Description>
              Compose workloads do not support Scout analytics yet.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </>
    );
  return (
    <>
      <PageSelectionTitle
        label="Analytics"
        icon={<HugeiconsIcon aria-hidden="true" icon={ChartNoAxesColumnIcon} />}
        keepEntityName
        actions={
          <div>
            <FilterDialog
              fields={filterFields}
              value={filters}
              onChange={setFilters}
              getOptions={getFilterOptions}
              renderOption={(field, value) => (
                <span className="flex min-w-0 items-center gap-2">
                  {field === "country" || field === "city" ? (
                    <span
                      aria-hidden="true"
                      className="w-5 shrink-0 text-center"
                    >
                      {/^[A-Z]{2}$/u.test(locationCountry(field, value))
                        ? String.fromCodePoint(
                            ...[...locationCountry(field, value)].map(
                              (letter) => 0x1f1e6 + letter.charCodeAt(0) - 65,
                            ),
                          )
                        : "🌐"}
                    </span>
                  ) : (
                    <AnalyticsRowIcon
                      dimension={field === "destination" ? "referrer" : field}
                      value={value}
                    />
                  )}
                  <span className="truncate">
                    {field === "country" && value !== "Unknown"
                      ? (countryNames.of(value) ?? value)
                      : field === "city"
                        ? cityLabel(value)
                        : value}
                  </span>
                </span>
              )}
            />
          </div>
        }
      />
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:max-w-lg">
          <ScoutSelect
            label="Measure"
            value={kind}
            onChange={(value) => {
              const next = value as "request" | "pageview";
              const available =
                next === "request"
                  ? analyticsHttpFilterFields
                  : analyticsWebFilterFields;
              const filtered = filters.filter((filter) =>
                available.some((field) => field === filter.field),
              );
              update({
                measure: next === "pageview" ? null : next,
                filters: filtered.length ? JSON.stringify(filtered) : null,
                metric: null,
              });
            }}
            options={[
              { id: "pageview", label: "Web analytics" },
              { id: "request", label: "HTTP analytics" },
            ]}
          />
          <ScoutSelect
            label="Time range"
            value={String(days)}
            onChange={(value) =>
              update({ days: Number(value) === 1 ? null : value })
            }
            options={analyticsRanges
              .filter(
                ({ days }) => days <= (query.data?.config?.retentionDays ?? 30),
              )
              .map(({ days, label }) => ({
                id: String(days),
                label,
              }))}
          />
        </div>
        {query.error ? <QueryError message={query.error} /> : null}
        {!query.data ? (
          query.error ? null : (
            <QueryLoading />
          )
        ) : (
          <AnalyticsView
            report={query.data}
            kind={kind}
            filters={filters}
            updating={query.isRefreshing || query.isPreviousData}
            domain={domain}
            onFilter={(field, value) =>
              setFilters((current) =>
                toggleAnalyticsRowFilter(current, field, value),
              )
            }
          />
        )}
      </div>
    </>
  );
}

export function AnalyticsView({
  report,
  kind = report.kind,
  filters = report.filters,
  updating = false,
  domain,
  onFilter,
}: {
  report: AnalyticsReport;
  kind?: "request" | "pageview";
  filters?: AnalyticsFilter[];
  updating?: boolean;
  domain?: string;
  onFilter: (field: AnalyticsFilter["field"], value: string) => void;
}) {
  const [eventActive, setEventActive] = useState(false);
  const [comparison, setComparison] = useQueryChoice(
    "compare",
    ["off", "on"],
    "off",
  );
  const compareEnabled = comparison === "on";
  const setCompareEnabled = (value: boolean | ((old: boolean) => boolean)) =>
    setComparison(
      (typeof value === "function" ? value(compareEnabled) : value)
        ? "on"
        : "off",
    );
  const [metric, setMetric] = useQueryChoice(
    "metric",
    ["all", "count", "errors", "visitors", "sessions"],
    "all",
  );
  const selectedMetric = metric === "all" ? null : metric;
  const setSelectedMetric = (
    value:
      | typeof selectedMetric
      | ((old: typeof selectedMetric) => typeof selectedMetric),
  ) =>
    setMetric(
      (typeof value === "function" ? value(selectedMetric) : value) ?? "all",
    );
  if (!report.enabled)
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>Analytics is disabled</EmptyState.Title>
          <EmptyState.Description>
            Enable analytics in the service manifest to see traffic for this
            service.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  const pageviews = report.kind === "pageview";
  const reportDuration = Date.parse(report.end) - Date.parse(report.start);
  const reportDays = Math.round(reportDuration / 86_400_000);
  const metrics = pageviews
    ? [
        {
          label: "Pageviews",
          value: report.total,
          previous: report.comparison?.total,
          lowerIsBetter: false,
        },
        {
          label: "Estimated visitors",
          value: report.visitors,
          previous: report.comparison?.visitors,
          lowerIsBetter: false,
        },
        {
          label: "Time spent",
          value: report.averageTimeMs ?? null,
          previous: report.comparison?.averageTimeMs,
          lowerIsBetter: false,
          unit: "time",
          help: "Average time a page was visible in a browser tab. Hidden tabs do not add time.",
        },
        {
          label: "Bounce rate",
          value: report.bounceRate ?? null,
          previous: report.comparison?.bounceRate,
          lowerIsBetter: true,
          unit: "percent",
          help: "Share of finished visits with one pageview. A visit finishes after 30 minutes without activity.",
        },
      ]
    : [
        {
          label: "Requests",
          value: report.total,
          previous: report.comparison?.total,
          lowerIsBetter: false,
        },
        {
          label: "4xx + 5xx",
          value: report.errors,
          previous: report.comparison?.errors,
          lowerIsBetter: true,
        },
        {
          label: "Average response time",
          value: report.meanMs,
          previous: report.comparison?.meanMs,
          lowerIsBetter: true,
          unit: "ms",
        },
      ];
  const trend = report.trend.map((point, index) => ({
    ...point,
    at: Date.parse(point.at),
    previous: report.comparison?.trend[index]?.count ?? null,
    previousErrors: report.comparison?.trend[index]?.errors ?? null,
    previousVisitors: report.comparison?.trend[index]?.visitors ?? null,
    previousSessions: report.comparison?.trend[index]?.sessions ?? null,
  }));
  const webSeries = [
    {
      key: "count",
      previousKey: "previous",
      label: "Page views",
      color: "var(--chart-accent)",
    },
    {
      key: "visitors",
      previousKey: "previousVisitors",
      label: "Estimated visitors",
      color: "var(--warning)",
    },
    {
      key: "sessions",
      previousKey: "previousSessions",
      label: "Estimated sessions",
      color: "var(--danger)",
    },
  ] as const;
  const httpSeries = [
    {
      key: "count",
      previousKey: "previous",
      label: "Requests",
      color: "var(--chart-accent)",
    },
    {
      key: "errors",
      previousKey: "previousErrors",
      label: "HTTP errors",
      color: "var(--danger)",
    },
  ] as const;
  const chartSeries = pageviews ? webSeries : httpSeries;
  const activeMetric = chartSeries.some(({ key }) => key === selectedMetric)
    ? selectedMetric
    : null;
  const visibleSeries = chartSeries.filter(
    ({ key }) => activeMetric === null || key === activeMetric,
  );
  const showComparison = Boolean(report.comparison) && compareEnabled;
  const breakdowns: {
    name: string;
    dimension: string;
    field?: AnalyticsFilter["field"];
    rows: { value: string; count: number }[];
    total: number;
    help?: string;
  }[] = Object.entries(report.dimensions).map(([dimension, rows]) => ({
    name: labels[dimension] ?? dimension,
    dimension,
    field: (pageviews
      ? analyticsWebFilterFields
      : analyticsHttpFilterFields
    ).find((field) => field === dimension),
    rows,
    total: report.total,
  }));
  if (!pageviews) {
    breakdowns.push({
      name: "Response times",
      dimension: "responseTime",
      field: "responseTime",
      rows: report.histogram
        .map((count, i) => ({ value: latencyLabels[i]!, count }))
        .filter((row) => row.count > 0),
      total: report.total,
    });
  } else {
    if (report.config?.visitorIdentity)
      breakdowns.push({
        name: "Exit pages",
        dimension: "path",
        field: "path",
        rows: report.exitPages ?? [],
        total: report.exits ?? 0,
        help: "The last page viewed in each finished visit. A visit finishes after 30 minutes without activity.",
      });
    breakdowns.push({
      name: "Outbound websites",
      dimension: "referrer",
      field: "destination",
      rows: report.outboundLinks ?? [],
      total: report.outboundClicks ?? 0,
      help: "Websites whose links visitors clicked, including links opened in a new tab. A click does not prove the visitor left your site.",
    });
  }
  const breakdownColumns: [typeof breakdowns, typeof breakdowns] = [[], []];
  const columnHeights: [number, number] = [0, 0];
  for (const breakdown of breakdowns) {
    const column = columnHeights[0] <= columnHeights[1] ? 0 : 1;
    breakdownColumns[column].push(breakdown);
    columnHeights[column] +=
      Math.max(1, Math.min(breakdown.rows.length, 10)) +
      1 +
      (breakdown.rows.length > 10 ? 1 : 0);
  }
  const hasTrend = report.total > 0 || (report.comparison?.total ?? 0) > 0;
  const comparisonLabel = `Prev. ${
    reportDuration < 86_400_000
      ? reportDuration < 3_600_000
        ? `${Math.round(reportDuration / 60_000)} mins`
        : `${Math.round(reportDuration / 3_600_000)} hours`
      : reportDays === 1
        ? "24 hours"
        : `${reportDays} days`
  }`;
  return (
    <div className="space-y-6" aria-busy={updating}>
      {updating ? (
        <span className="sr-only" role="status">
          Updating analytics
        </span>
      ) : null}
      {report.filters.some((filter) => filter.field === "responseTime") &&
      report.meanMs === null &&
      report.total > 0 ? (
        <p className="text-sm text-muted">
          Response time filters use recorded histogram ranges. An exact average
          is unavailable when a range selects part of an aggregate.
        </p>
      ) : null}
      {report.agentStatus !== "online" ? (
        <p role="status" className="text-sm text-warning">
          Scout Agent is {report.agentStatus}. Install or update Scout on the
          server to collect new analytics.
        </p>
      ) : null}
      {!report.collectionReady && report.agentStatus === "online" ? (
        <p role="status" className="text-sm text-warning">
          Scout cannot collect analytics yet. Update Scout on this service’s
          server and check the analytics setup guide.
        </p>
      ) : null}
      {report.droppedSamples > 0 ||
      report.collectionErrors > 0 ||
      report.droppedEvents > 0 ? (
        <p role="status" className="text-sm text-warning">
          Scout could not collect or send some activity. Counts may be
          incomplete.
        </p>
      ) : null}
      {hasTrend ? (
        <div
          className={`grid grid-cols-2 gap-4 ${pageviews ? "xl:grid-cols-4" : "sm:grid-cols-3"}`}
        >
          {metrics.map(
            ({ label, value, previous, lowerIsBetter, ...metric }) => (
              <Widget key={label} className="min-w-0">
                <Widget.Header>
                  <Widget.Title>
                    {label}
                    {"help" in metric && metric.help ? (
                      <HeadingHelp
                        title={label}
                        help={{
                          description: metric.help,
                          href: "/docs/analytics",
                        }}
                      />
                    ) : null}
                  </Widget.Title>
                </Widget.Header>
                <Widget.Content>
                  <p className="text-2xl font-medium whitespace-nowrap tabular-nums">
                    {value === null
                      ? "—"
                      : "unit" in metric
                        ? metric.unit === "percent"
                          ? `${value.toFixed(1)}%`
                          : metric.unit === "time"
                            ? formatPageTime(value)
                            : `${value.toFixed(1)} ms`
                        : format(value)}
                  </p>
                  <MetricChange
                    current={value}
                    previous={previous}
                    lowerIsBetter={lowerIsBetter}
                    label={comparisonLabel}
                  />
                </Widget.Content>
              </Widget>
            ),
          )}
        </div>
      ) : null}
      {!hasTrend ? (
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title>
              No {pageviews ? "pageviews" : "requests"} in this range
            </EmptyState.Title>
            <EmptyState.Description>
              {report.filters.length
                ? "Try different filters or a wider time range."
                : pageviews
                  ? "Add the script shown below to your site and visit a page. Data usually appears within a minute."
                  : "Visit this service. Data usually appears within a minute."}
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      ) : (
        <Widget>
          <Widget.Header
            endContent={
              <TooltipText
                className="inline-flex shrink-0"
                tabIndex={!report.comparison ? 0 : undefined}
                tooltip={
                  !report.comparison
                    ? "No prior period data to compare."
                    : undefined
                }
              >
                <Widget.Action
                  className="shrink-0"
                  aria-pressed={showComparison}
                  onPress={() => setCompareEnabled((value) => !value)}
                  isDisabled={!report.comparison}
                >
                  {showComparison ? "Disable compare" : "Enable compare"}
                </Widget.Action>
              </TooltipText>
            }
          >
            <Widget.Title>
              {pageviews ? "Trends" : "Request trend"}
            </Widget.Title>
          </Widget.Header>
          <Widget.Content>
            <LineChart
              data={trend}
              height={240}
              chartMargin={
                pageviews ? { top: 5, right: 0, bottom: 5, left: 5 } : undefined
              }
              aria-label={
                pageviews
                  ? "Page views, estimated visitors, and estimated sessions over time"
                  : "Requests over time"
              }
            >
              <LineChart.Grid vertical={false} />
              <LineChart.XAxis
                tick={axisTick}
                tickMargin={8}
                minTickGap={45}
                dataKey="at"
                type="number"
                scale="time"
                domain={
                  pageviews
                    ? ["dataMin", "dataMax"]
                    : [Date.parse(report.start), Date.parse(report.end)]
                }
                allowDataOverflow
                ticks={trend
                  .map((point) => point.at)
                  .filter(
                    (at) =>
                      at >= Date.parse(report.start) &&
                      at <= Date.parse(report.end),
                  )}
                tickFormatter={(value) =>
                  new Date(Number(value)).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    ...(reportDuration <= 86_400_000
                      ? { hour: "numeric" }
                      : {}),
                  })
                }
              />
              <LineChart.YAxis
                width="auto"
                tick={axisTick}
                tickMargin={4}
                allowDecimals={false}
              />
              <LineChart.Tooltip
                active={eventActive ? false : undefined}
                content={({ active, label, payload }) => {
                  const point = trend.find(
                    (point) => point.at === Number(label),
                  );
                  const orderedPayload = visibleSeries.flatMap(
                    ({ key, previousKey }) =>
                      [
                        payload.find((item) => item.dataKey === key),
                        payload.find((item) => item.dataKey === previousKey),
                      ].filter((item) => item !== undefined),
                  );
                  return (
                    <LineChart.TooltipContent
                      active={active}
                      payload={orderedPayload.map(
                        ({ color, dataKey, name, value }) => ({
                          color,
                          dataKey: String(dataKey),
                          name: String(name),
                          value: Number(value),
                        }),
                      )}
                      label={label}
                      labelFormatter={(value) =>
                        new Date(Number(value)).toLocaleString(undefined, {
                          dateStyle: "medium",
                          ...(reportDuration <= 86_400_000
                            ? { timeStyle: "short" }
                            : {}),
                        })
                      }
                      valueFormatter={(value, key) => {
                        const series = chartSeries.find(
                          (series) => series.key === key,
                        );
                        const previous =
                          series && point ? point[series.previousKey] : null;
                        return (
                          <span
                            className={`inline-flex items-center gap-2 whitespace-nowrap ${String(key).startsWith("previous") ? "text-muted" : ""}`}
                          >
                            {showComparison && series && previous != null ? (
                              <MetricChange
                                current={Number(value)}
                                previous={previous}
                                lowerIsBetter={series.key === "errors"}
                                label={comparisonLabel}
                                inline
                              />
                            ) : null}
                            {format(Number(value))}
                          </span>
                        );
                      }}
                    />
                  );
                }}
              />
              {!pageviews &&
                report.deployments.map((event) => (
                  <LineChart.ReferenceLine
                    key={event.id}
                    x={Date.parse(event.at)}
                    zIndex={600}
                    stroke={monitoringEventColor(event.type)}
                    strokeDasharray="4 4"
                    strokeOpacity={0.6}
                    label={
                      <MonitoringEventMarker
                        event={event}
                        onActiveChange={setEventActive}
                      />
                    }
                  />
                ))}
              {visibleSeries.map(({ key, label, color }) => (
                <LineChart.Line
                  key={key}
                  dataKey={key}
                  name={label}
                  stroke={color}
                  strokeWidth={1.8}
                  isAnimationActive={false}
                  dot={false}
                />
              ))}
              {showComparison
                ? visibleSeries.map(({ previousKey, label, color }) => (
                    <LineChart.Line
                      key={previousKey}
                      dataKey={previousKey}
                      name={`${label} (${comparisonLabel})`}
                      stroke={color}
                      strokeOpacity={0.25}
                      strokeDasharray="5 4"
                      strokeWidth={1.8}
                      isAnimationActive={false}
                      dot={false}
                    />
                  ))
                : null}
            </LineChart>
            <Widget.Legend className="mt-2 flex-wrap gap-1">
              {chartSeries.map(({ key, label, color }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={activeMetric === key}
                  className={`widget__legend-item cursor-pointer rounded-lg px-2 py-1 outline-none transition-colors duration-150 hover:bg-default focus-visible:bg-default focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-default motion-reduce:transition-none ${activeMetric !== null && activeMetric !== key ? "opacity-40" : ""}`}
                  onClick={() =>
                    setSelectedMetric((current) =>
                      current === key ? null : key,
                    )
                  }
                >
                  <span
                    className="widget__legend-item-dot"
                    style={{ backgroundColor: color }}
                    aria-hidden="true"
                  />
                  <span className="widget__legend-item-label">{label}</span>
                </button>
              ))}
            </Widget.Legend>
          </Widget.Content>
        </Widget>
      )}
      {report.total > 0 ? (
        <div
          key={`${report.kind}:${report.start}:${JSON.stringify(report.filters)}`}
          className="grid grid-cols-1 items-start gap-4 md:grid-cols-2"
        >
          {breakdownColumns.map((column, index) => (
            <div key={index} className="grid min-w-0 content-start gap-4">
              {column.map((breakdown) => (
                <AnalyticsRows
                  key={breakdown.name}
                  {...breakdown}
                  domain={domain}
                  onFilter={
                    breakdown.field && kind === report.kind
                      ? (value) => onFilter(breakdown.field!, value)
                      : undefined
                  }
                  filterField={breakdown.field}
                  filters={filters}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {pageviews ? (
        <section
          className="space-y-5 pt-4"
          aria-labelledby="pageview-setup-title"
        >
          <div className="space-y-1">
            <h4 id="pageview-setup-title" className="text-sm font-medium">
              Track pageviews
            </h4>
            <p className="text-sm text-muted">
              Add this script to your site’s shared HTML template to count
              pageviews, time spent on each page, and clicks to other websites.
            </p>
          </div>
          <CodePanel ariaLabel="Pageview script" language="html">
            {
              '<script defer src="/.well-known/towbar-analytics/script.js"></script>'
            }
          </CodePanel>
        </section>
      ) : null}
    </div>
  );
}
function AnalyticsRows({
  rows,
  total,
  name,
  dimension = "",
  help,
  domain,
  onFilter,
  filterField,
  filters = [],
}: {
  name: string;
  filters?: AnalyticsFilter[];
  dimension?: string;
  help?: string;
  domain?: string;
  onFilter?: (value: string) => void;
  filterField?: AnalyticsFilter["field"];
  rows: { value: string; count: number }[];
  total: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const tableId = useId();
  const country = dimension === "country";
  const location = country || dimension === "city";
  const numbered = [
    "path",
    "referrer",
    "country",
    "city",
    "browser",
    "device",
  ].includes(dimension);
  const sortedRows = numbered
    ? [...rows].sort(
        (left, right) =>
          right.count - left.count || left.value.localeCompare(right.value),
      )
    : rows;
  const orderedRows = sortedRows.slice(0, expanded ? 25 : 10);
  const maxCount = Math.max(0, ...rows.map((row) => row.count));
  return (
    <Table>
      <Table.ScrollContainer id={tableId}>
        <Table.Content
          aria-label={name}
          className={`w-full table-fixed ${styles.breakdown} ${numbered ? styles.numbered : ""} ${numbered && orderedRows.length > 9 ? styles.doubleDigitRanks : ""}`}
        >
          <Table.Header>
            {numbered ? (
              <Table.Column
                className={styles.rankColumn}
                textValue="Row number"
              >
                <span className="sr-only">Row number</span>
              </Table.Column>
            ) : null}
            <Table.Column isRowHeader textValue={name}>
              <span className="flex h-4 items-center gap-1">
                {name}
                {location || help ? (
                  <HeadingHelp
                    title={name}
                    help={{
                      description:
                        help ?? "IP Geolocation provided by DB-IP database.",
                      href: "/docs/analytics",
                    }}
                  />
                ) : null}
              </span>
            </Table.Column>
            <Table.Column className="text-right">Count</Table.Column>
            <Table.Column className="text-right">%</Table.Column>
          </Table.Header>
          <Table.Body
            renderEmptyState={() => (
              <div className="p-4 text-sm text-muted">No data yet.</div>
            )}
          >
            {orderedRows.map((row, index) => (
              <Table.Row id={row.value} key={row.value}>
                {numbered ? (
                  <Table.Cell className={styles.rankCell}>
                    {index + 1}
                  </Table.Cell>
                ) : null}
                <Table.Cell className="relative overflow-hidden">
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-y-1 left-1 ${styles.countBar}`}
                    style={{
                      width: `calc((100% - 0.5rem) * ${maxCount ? row.count / maxCount : 0})`,
                      opacity: maxCount
                        ? 0.04 + 0.24 * (row.count / maxCount)
                        : 0,
                    }}
                  />
                  <span className="relative flex min-w-0 items-center gap-2">
                    <AnalyticsRowIcon
                      key={`${dimension}:${row.value}`}
                      dimension={dimension}
                      value={row.value}
                    />
                    {location &&
                    /^[A-Z]{2}$/u.test(
                      locationCountry(dimension, row.value),
                    ) ? (
                      <span aria-hidden="true">
                        {String.fromCodePoint(
                          ...[...locationCountry(dimension, row.value)].map(
                            (letter) => 127397 + letter.charCodeAt(0),
                          ),
                        )}
                      </span>
                    ) : null}
                    <AnalyticsRowLabel
                      value={row.value}
                      label={
                        country && /^[A-Z]{2}$/u.test(row.value)
                          ? (countryNames.of(row.value) ?? row.value)
                          : dimension === "city"
                            ? cityLabel(row.value)
                            : row.value
                      }
                      dimension={dimension}
                      domain={domain}
                      onFilter={onFilter}
                      filterField={filterField}
                      filtered={Boolean(
                        filterField &&
                        filters.some((filter) =>
                          analyticsRowFilterMatches(
                            filter,
                            filterField,
                            row.value,
                          ),
                        ),
                      )}
                      filterDisabled={Boolean(
                        filterField &&
                        toggleAnalyticsRowFilter(
                          filters,
                          filterField,
                          row.value,
                        ) === filters,
                      )}
                    />
                  </span>
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums">
                  {format(row.count)}
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums text-muted">
                  {total ? ((row.count / total) * 100).toFixed(1) : "0"}%
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
      {sortedRows.length > 10 ? (
        <Table.Footer
          className={`flex items-center ${numbered ? (orderedRows.length > 9 ? "pl-10" : "pl-8") : ""}`}
        >
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={tableId}
            aria-label={`${expanded ? "Show fewer" : "Show more"} ${name.toLowerCase()}`}
            className="rounded-sm py-0 text-xs text-muted underline decoration-muted/30 decoration-dashed underline-offset-2 outline-none hover:decoration-muted focus-visible:ring-2 focus-visible:ring-focus"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show Less" : "Show More"}
          </button>
        </Table.Footer>
      ) : null}
    </Table>
  );
}

function locationCountry(dimension: string, value: string) {
  return dimension === "country"
    ? value
    : (/, ([A-Z]{2})$/u.exec(value)?.[1] ?? "");
}

function cityLabel(value: string) {
  const country = locationCountry("city", value);
  return country
    ? `${value.slice(0, -2)}${countryNames.of(country) ?? country}`
    : value;
}

function AnalyticsRowLabel({
  value,
  label,
  dimension,
  domain,
  onFilter,
  filterField,
  filterDisabled,
  filtered,
}: {
  value: string;
  filtered: boolean;
  label: string;
  dimension: string;
  domain?: string;
  onFilter?: (value: string) => void;
  filterField?: AnalyticsFilter["field"];
  filterDisabled: boolean;
}) {
  const href =
    dimension === "path" && domain && value.startsWith("/")
      ? `https://${domain}${value}`
      : dimension === "referrer" &&
          /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(value)
        ? `https://${value}`
        : undefined;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {href ? (
        <InlineExternalLink
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          tooltip={label}
        >
          {label}
        </InlineExternalLink>
      ) : (
        <TooltipText className="block truncate" tooltip={label} openOnPress>
          {label}
        </TooltipText>
      )}
      {onFilter && filterField ? (
        <Tooltip>
          <Button
            isIconOnly
            variant="ghost"
            aria-label={`${filtered ? "Remove filter for" : "Filter by"} ${filterField} ${value}`}
            className={`size-5 min-w-0 shrink-0 rounded-lg bg-transparent p-0 hover:bg-default focus-visible:bg-default ${styles.rowAction}`}
            isDisabled={filterDisabled}
            onPress={() => onFilter(value)}
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={filtered ? FilterRemoveIcon : FilterIcon}
              className={`size-3.5 ${filtered ? "text-danger" : ""}`}
            />
          </Button>
          <Tooltip.Content>
            {filtered ? "Remove this filter" : "Filter by this value"}
          </Tooltip.Content>
        </Tooltip>
      ) : null}
    </span>
  );
}

function MetricChange({
  current,
  previous,
  lowerIsBetter,
  label,
  inline = false,
}: {
  current: number | null;
  previous: number | null | undefined;
  lowerIsBetter: boolean;
  label: string;
  inline?: boolean;
}) {
  const layout = inline ? "inline" : "mt-1 block";
  if (current === null || previous === null || previous === undefined)
    return (
      <span className={`${layout} text-xs text-muted`}>
        No prior period data
      </span>
    );
  if (previous === 0 && current !== 0)
    return (
      <span
        className={`${layout} text-xs ${lowerIsBetter ? "text-danger-soft-foreground" : "text-success-soft-foreground"}`}
        title={`${label}: 0`}
      >
        New
      </span>
    );
  const change = previous === 0 ? 0 : ((current - previous) / previous) * 100;
  const improved = lowerIsBetter ? change < 0 : change > 0;
  return (
    <span
      className={`${layout} text-xs tabular-nums ${change === 0 ? "text-muted" : improved ? "text-success-soft-foreground" : "text-danger-soft-foreground"}`}
      title={`${label}: ${format(previous)}`}
    >
      {change !== 0 ? (
        <>
          <span aria-hidden="true">{change > 0 ? "↑" : "↓"} </span>
          <span className="sr-only">
            {change > 0 ? "Increase of " : "Decrease of "}
          </span>
        </>
      ) : null}
      {Math.abs(change).toFixed(1)}%
      <span className="sr-only"> compared with the previous period</span>
    </span>
  );
}

function formatPageTime(ms: number) {
  if (ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
