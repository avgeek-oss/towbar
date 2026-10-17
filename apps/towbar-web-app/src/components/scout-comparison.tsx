"use client";
import { usePageQuery } from "@/hooks/use-page-query";
import { queryInteger } from "@/lib/page-query-state";
import { deploymentComparisonQuerySchema } from "@workspace/towbar-contracts";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { ScoutIcon } from "./scout-icons";

import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent } from "react";
import type {
  ComparisonPoint,
  ComparisonMetricSummary,
  MonitoringAggregates,
} from "@workspace/towbar-web-client";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { LineChart } from "@avgeek-oss/design-system/charts/line-chart";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { scheduleChartUpdate } from "./monitoring-chart-slot";
import { ScoutSelect, ScoutNumber } from "./scout-controls";

import { formatMetric } from "./monitoring-metric-chart";
import { formatDate } from "./dashboard-overview";

type DeploymentChoice = {
  id: string;
  commitSha: string | null;
  finishedAt: string | null;
  serverId: string;
  kind: string;
};
type ComparisonMetric = {
  metric: keyof MonitoringAggregates;
  label: string;
  unit: "cores" | "bytes" | "bytesPerSecond";
  baseline: ComparisonMetricSummary;
  candidate: ComparisonMetricSummary;
  delta: number | null;
  deltaPercent: number | null;
  assessment:
    | "insufficient_data"
    | "increased"
    | "decreased"
    | "stable"
    | "informational";
};
type ComparisonSide = {
  deployment: DeploymentChoice & {
    configDigest: string | null;
    imageDigest: string | null;
  };
  startAt: string;
  endAt: string;
  windowComplete: boolean;
  historyExpired: boolean;
  restarts: number | null;
  restartCoveragePercent: number;
  points: ComparisonPoint[];
};
export type ScoutComparisonResponse = {
  workload: { id: string; name: string };
  query: {
    windowMinutes: number;
    warmupMinutes: number;
    statistic: "average" | "peak";
  };
  stepSeconds: number;
  baseline: ComparisonSide;
  candidate: ComparisonSide;
  metrics: ComparisonMetric[];
  warnings: string[];
};

export function ScoutComparison({ deployableId }: { deployableId: string }) {
  const endpoint = `/v1/core/workloads/${deployableId}`;
  const deployments = useApiQuery<{ deployments: DeploymentChoice[] }>(
    `${endpoint}/comparison-deployments`,
  );
  const { search, update } = usePageQuery();
  const urlValues = useMemo(
    () => ({
      baseline: search.get("baselineId") ?? "",
      candidate: search.get("candidateId") ?? "",
      windowMinutes: queryInteger(search.get("windowMinutes"), 30, 5, 1440),
      warmupMinutes: queryInteger(search.get("warmupMinutes"), 2, 0, 60),
      statistic: search.get("statistic") === "peak" ? "peak" : "average",
    }),
    [search],
  );
  const urlKey = JSON.stringify(urlValues);
  const [draft, setDraft] = useState({ urlKey, values: urlValues });
  useEffect(() => setDraft({ urlKey, values: urlValues }), [urlKey, urlValues]);
  const values = draft.urlKey === urlKey ? draft.values : urlValues;
  const { baseline, candidate, windowMinutes, warmupMinutes, statistic } =
    values;
  const change = <K extends keyof typeof values>(
    key: K,
    value: (typeof values)[K],
  ) => setDraft({ urlKey, values: { ...values, [key]: value } });
  const setBaseline = (value: string) => change("baseline", value);
  const setCandidate = (value: string) =>
    setDraft({ urlKey, values: { ...values, candidate: value, baseline: "" } });
  const setWindow = (value: number) => change("windowMinutes", value);
  const setWarmup = (value: number) => change("warmupMinutes", value);
  const setStatistic = (value: string) => change("statistic", value);
  const requested = deploymentComparisonQuerySchema.safeParse({
    baselineId: urlValues.baseline,
    candidateId: urlValues.candidate,
    windowMinutes: urlValues.windowMinutes,
    warmupMinutes: urlValues.warmupMinutes,
    statistic: urlValues.statistic,
  });
  const allowed =
    requested.success &&
    [requested.data.baselineId, requested.data.candidateId].every((id) =>
      deployments.data?.deployments.some((row) => row.id === id),
    );
  const applied = allowed
    ? new URLSearchParams({
        baselineId: urlValues.baseline,
        candidateId: urlValues.candidate,
        windowMinutes: String(urlValues.windowMinutes),
        warmupMinutes: String(urlValues.warmupMinutes),
        statistic: urlValues.statistic,
      }).toString()
    : "";
  const setApplied = (next: string) =>
    update(Object.fromEntries(new URLSearchParams(next)));
  const comparison = useApiQuery<ScoutComparisonResponse>(
    applied ? `${endpoint}/deployment-comparison?${applied}` : null,
    undefined,
    { keepPreviousData: true },
  );
  const result = useDeferredValue(comparison.data);
  const rows = deployments.data?.deployments ?? [];
  const selectedCandidate = rows.find((d) => d.id === candidate) ?? rows[0];
  const compatible = rows.filter((d) => d.id !== selectedCandidate?.id);
  const selectedBaseline =
    compatible.find((d) => d.id === baseline) ??
    compatible.find(
      (d) =>
        d.finishedAt &&
        selectedCandidate?.finishedAt &&
        d.finishedAt < selectedCandidate.finishedAt,
    ) ??
    compatible[0];
  const choice = (d: DeploymentChoice) => ({
    id: d.id,
    label: d.commitSha?.slice(0, 7) ?? d.id.slice(0, 8),
    detail: d.finishedAt ? formatDate(d.finishedAt) : "Unknown time",
  });
  function compare(event: FormEvent) {
    event.preventDefault();
    if (!selectedBaseline || !selectedCandidate) return;
    const next = new URLSearchParams({
      baselineId: selectedBaseline.id,
      candidateId: selectedCandidate.id,
      windowMinutes: String(windowMinutes),
      warmupMinutes: String(warmupMinutes),
      statistic,
    }).toString();
    if (next === applied) comparison.refresh();
    else setApplied(next);
  }
  return (
    <div className="grid min-w-0 gap-6">
      {deployments.error ? <QueryError message={deployments.error} /> : null}
      {!deployments.data ? (
        <QueryLoading />
      ) : rows.length < 2 ? (
        <Widget>
          <Widget.Content className="grid gap-2 py-10 text-center">
            <h3 className="font-medium">Two successful deployments needed</h3>
            <p className="text-sm text-muted">
              Deploy this workload again, then compare two deployments in this
              environment.
            </p>
          </Widget.Content>
        </Widget>
      ) : (
        <form onSubmit={compare} className="grid gap-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <ScoutSelect
              label="Baseline"
              required
              value={selectedBaseline?.id ?? ""}
              onChange={setBaseline}
              options={compatible.map(choice)}
            />
            <ScoutSelect
              label="Compare with"
              required
              value={selectedCandidate?.id ?? ""}
              onChange={(id) => {
                setCandidate(id);
              }}
              options={rows.map(choice)}
            />
          </div>
          {!selectedBaseline ? (
            <p role="status" className="text-sm text-muted">
              There is no other successful deployment in this environment.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <ScoutNumber
              label="Compare for (minutes)"
              description="Use the same length of time for both deployments."
              value={windowMinutes}
              onChange={setWindow}
              min={5}
              max={1440}
              step={1}
            />
            <ScoutNumber
              label="Ignore startup (minutes)"
              description="Skip initial activity after each deployment is ready."
              value={warmupMinutes}
              onChange={setWarmup}
              min={0}
              max={60}
              step={1}
            />
            <ScoutSelect
              label="Compare"
              required
              value={statistic}
              onChange={setStatistic}
              options={[
                { id: "average", label: "Average usage" },
                { id: "peak", label: "Peak usage" },
              ]}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              isDisabled={!selectedBaseline || comparison.isRefreshing}
            >
              <ScoutIcon name="compare" />
              Compare deployments
            </Button>
            <span
              role="status"
              aria-live="polite"
              className="text-sm text-muted"
            >
              {comparison.isPreviousData ? "Updating comparison…" : ""}
            </span>
          </div>
        </form>
      )}
      {(urlValues.baseline || urlValues.candidate) &&
      deployments.data &&
      !allowed ? (
        <p role="status" className="text-sm text-warning">
          Choose two successful deployments from this environment to compare.
        </p>
      ) : null}
      {comparison.error ? <QueryError message={comparison.error} /> : null}
      {applied && !comparison.data && !comparison.error ? (
        <QueryLoading />
      ) : null}
      {result ? (
        <ComparisonResults
          data={result}
          updating={comparison.isPreviousData || result !== comparison.data}
        />
      ) : null}
    </div>
  );
}

const ComparisonResults = memo(function ComparisonResults({
  data,
  updating,
}: {
  data: ScoutComparisonResponse;
  updating: boolean;
}) {
  return (
    <section
      aria-label="Deployment comparison results"
      aria-busy={updating}
      className="min-w-0"
    >
      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        {data.metrics.map((metric) => (
          <ComparisonChartSlot
            key={metric.metric}
            metric={metric}
            data={data}
          />
        ))}
      </div>
    </section>
  );
});

const assessmentLabel = {
  insufficient_data: "Insufficient data",
  increased: "Higher usage",
  decreased: "Lower usage",
  stable: "No change",
  informational: "Activity comparison",
};

function assessmentVariant(assessment: ComparisonMetric["assessment"]) {
  if (assessment === "decreased") return "success";
  if (assessment === "increased") return "danger";
  return "warning";
}

function comparisonAssessmentTooltip(metric: ComparisonMetric) {
  if (metric.assessment === "insufficient_data")
    return "There are not enough measurements in both windows to compare this metric.";
  if (metric.assessment === "informational")
    return "This metric is shown for context and is not classified as a regression.";
  if (metric.deltaPercent === null)
    return "The baseline value is zero, so a percentage change cannot be calculated.";
  const direction = metric.deltaPercent > 0 ? "higher" : "lower";
  return `Compared usage is ${Math.abs(metric.deltaPercent).toFixed(1)}% ${direction} than the baseline window.`;
}
const ComparisonChartSlot = memo(function ComparisonChartSlot(props: {
  metric: ComparisonMetric;
  data: ScoutComparisonResponse;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [snapshot, setSnapshot] = useState<typeof props>();
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { rootMargin: "100px" },
    );
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    return scheduleChartUpdate(() => setSnapshot(props));
  }, [props, visible]);
  return (
    <div ref={element} className="min-w-0" aria-busy={snapshot !== props}>
      {snapshot ? (
        <ComparisonChart {...snapshot} />
      ) : (
        <Widget>
          <Widget.Header>
            <Widget.Title>{props.metric.label}</Widget.Title>
          </Widget.Header>
          <Widget.Content>
            <div className="h-[322px]" aria-label="Loading comparison chart" />
          </Widget.Content>
        </Widget>
      )}
    </div>
  );
});
function ComparisonChart({
  metric,
  data,
}: {
  metric: ComparisonMetric;
  data: ScoutComparisonResponse;
}) {
  const unit =
    metric.unit === "cores"
      ? "number"
      : metric.unit === "bytes"
        ? "bytes"
        : "rate";
  const format = (value: number | null) =>
    value === null
      ? "No data"
      : `${formatMetric(value, unit)}${metric.unit === "cores" ? " cores" : ""}`;
  const points = useMemo(() => {
    const rows = new Map<
      number,
      { offset: number; baseline: number | null; candidate: number | null }
    >();
    for (
      let offset = 0;
      offset < data.query.windowMinutes * 60;
      offset += data.stepSeconds
    )
      rows.set(offset, { offset, baseline: null, candidate: null });
    for (const side of ["baseline", "candidate"] as const)
      for (const point of data[side].points) {
        const value = point.metrics[metric.metric];
        const row = rows.get(point.offsetSeconds);
        if (row && value?.count)
          row[side] =
            data.query.statistic === "peak"
              ? value.max
              : value.sum / value.count;
      }
    return [...rows.values()];
  }, [data, metric.metric]);
  return (
    <Widget className="min-w-0">
      <Widget.Header
        endContent={
          <TooltipText
            className="inline-flex"
            tooltip={comparisonAssessmentTooltip(metric)}
          >
            <Chip size="sm" color={assessmentVariant(metric.assessment)}>
              <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                {assessmentLabel[metric.assessment]}
              </Chip.Label>
            </Chip>
          </TooltipText>
        }
      >
        <Widget.Title>{metric.label}</Widget.Title>
      </Widget.Header>
      <Widget.Content className="grid min-w-0 gap-4">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted">Baseline</p>
            <p className="tabular-nums">
              {format(metric.baseline[data.query.statistic])}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Compared</p>
            <p className="tabular-nums">
              {format(metric.candidate[data.query.statistic])}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Change</p>
            <p className="tabular-nums">
              {metric.deltaPercent === null
                ? "—"
                : `${metric.deltaPercent > 0 ? "+" : ""}${metric.deltaPercent.toFixed(1)}%`}
            </p>
          </div>
        </div>
        <LineChart
          data={points}
          height={200}
          aria-label={`${metric.label}, baseline and compared deployment`}
        >
          <LineChart.Grid vertical={false} />
          <LineChart.XAxis
            dataKey="offset"
            type="number"
            domain={[0, data.query.windowMinutes * 60]}
            tickFormatter={(value) => `${Math.round(value / 60)}m`}
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            minTickGap={35}
          />
          <LineChart.YAxis
            width="auto"
            tickMargin={4}
            tickFormatter={(value) => formatMetric(value, unit)}
            tick={{ fill: "var(--muted)", fontSize: 10 }}
          />
          <LineChart.Line
            dataKey="baseline"
            name="Baseline"
            stroke="var(--muted)"
            strokeDasharray="5 3"
            strokeWidth={1.8}
            dot={false}
            type="linear"
            connectNulls={false}
            isAnimationActive={false}
          />
          <LineChart.Line
            dataKey="candidate"
            name="Compared"
            stroke="var(--chart-accent)"
            strokeWidth={1.8}
            dot={false}
            type="linear"
            connectNulls={false}
            isAnimationActive={false}
          />
          <LineChart.Tooltip
            content={
              <LineChart.TooltipContent
                labelFormatter={(value) =>
                  `${Math.round(Number(value) / 60)} minutes into observation`
                }
                valueFormatter={(value) => format(Number(value))}
              />
            }
          />
        </LineChart>
        <div className="flex gap-4 text-xs text-muted">
          <span>┄ Baseline</span>
          <span className="text-accent">━ Compared</span>
        </div>
        <p className="text-xs text-muted">
          Coverage: baseline {metric.baseline.coveragePercent.toFixed(0)}% ·
          compared {metric.candidate.coveragePercent.toFixed(0)}%.
        </p>
      </Widget.Content>
    </Widget>
  );
}
