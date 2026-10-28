"use client";
import { usePageQuery, useQueryChoice } from "@/hooks/use-page-query";
import { HugeiconsIcon } from "@hugeicons/react";
import { Activity01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { ScoutOptionIcon } from "./scout-icons";

import { useCallback, useDeferredValue, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { MonitoringHistory as History } from "@workspace/towbar-web-client";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { ListBox, Select } from "@avgeek-oss/design-system/forms/select";
import { ButtonLink } from "@avgeek-oss/design-system/buttons/button";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { ScoutMascot } from "./scout-mascot";
import { MonitoringDocumentation } from "./monitoring-documentation";
import { MonitoringEvents } from "./monitoring-events";
import { type ChartMetric } from "./monitoring-metric-chart";
import { MonitoringChartSlot } from "./monitoring-chart-slot";
import { MonitoringStatus } from "./monitoring-agent-settings";
import { PageSelectionTitle } from "./page-selection-title";

import { MonitoringRangePicker } from "./monitoring-range-picker";
import {
  monitoringRanges,
  type CustomMonitoringRange,
} from "./monitoring-range";

const hostMetrics: ChartMetric[][] = [
  [{ key: "cpuPercent", label: "CPU usage", unit: "percent" }],
  [{ key: "memoryPercent", label: "Memory usage", unit: "percent" }],
  [{ key: "diskPercent", label: "Disk usage", unit: "percent" }],
  [
    { key: "networkRxBytesPerSecond", label: "Network received", unit: "rate" },
    { key: "networkTxBytesPerSecond", label: "Network sent", unit: "rate" },
  ],
  [
    { key: "diskReadBytesPerSecond", label: "Disk read", unit: "rate" },
    { key: "diskWriteBytesPerSecond", label: "Disk written", unit: "rate" },
  ],
  [{ key: "load1", label: "Load average (1 min)", unit: "number" }],
];
const workloadMetrics: ChartMetric[][] = [
  [{ key: "cpuPercent", label: "CPU usage", unit: "percent" }],
  [{ key: "memoryUsedBytes", label: "Memory usage", unit: "bytes" }],
  [
    { key: "networkRxBytesPerSecond", label: "Network received", unit: "rate" },
    { key: "networkTxBytesPerSecond", label: "Network sent", unit: "rate" },
  ],
  [
    { key: "diskReadBytesPerSecond", label: "Block read", unit: "rate" },
    { key: "diskWriteBytesPerSecond", label: "Block written", unit: "rate" },
  ],
];

export function MonitoringHistory({
  path,
  serverId,
  workload = false,
}: {
  path: string;
  serverId?: string;
  workload?: boolean;
}) {
  const { search, update } = usePageQuery();
  const requestedRange = search.get("range");
  const range =
    monitoringRanges.some((row) => row.id === requestedRange) &&
    requestedRange !== "custom"
      ? requestedRange!
      : "15m";
  const startAt = search.get("startAt");
  const endAt = search.get("endAt");
  const custom =
    requestedRange === "custom" &&
    startAt &&
    endAt &&
    Number.isFinite(Date.parse(startAt)) &&
    Number.isFinite(Date.parse(endAt)) &&
    Date.parse(endAt) > Date.parse(startAt)
      ? { startAt, endAt }
      : undefined;
  const [pickerOpen, setPickerOpen] = useState(false);
  const applyCustom = useCallback(
    (value: CustomMonitoringRange) =>
      update({ range: "custom", startAt: value.startAt, endAt: value.endAt }),
    [update],
  );
  const selectRange = useCallback(
    (start: number, end: number) => {
      const to = Math.min(end, Date.now());
      if (to - start < 30_000) return;
      applyCustom({
        startAt: new Date(Math.ceil(start)).toISOString(),
        endAt: new Date(Math.floor(to)).toISOString(),
      });
    },
    [applyCustom],
  );
  const [view, setView] = useQueryChoice(
    "metricView",
    ["average", "peak"],
    "average",
  );
  const instance = search.get("instance") ?? "all";
  const setInstance = (value: string) =>
    update({ instance: value === "all" ? null : value });
  const syncId = useId();
  const query = useApiQuery<History>(
    `${path}?${new URLSearchParams({ range: custom ? "custom" : range, ...custom })}`,
    30_000,
    { keepPreviousData: true },
  );
  const history = useDeferredValue(query.data);
  const chartView = useDeferredValue(view);
  const chartInstance = useDeferredValue(instance);
  const updating =
    (!query.error && query.isPreviousData) ||
    history !== query.data ||
    chartView !== view ||
    chartInstance !== instance;
  const series = useMemo(
    () =>
      history?.series.filter(
        (row) => chartInstance === "all" || row.id === chartInstance,
      ) ?? [],
    [history, chartInstance],
  );
  if (!history)
    return (
      <>
        <PerformancePageTitle />
        <Widget>
          <Widget.Content className="min-h-64">
            {query.error ? (
              <QueryError message={query.error} />
            ) : (
              <QueryLoading />
            )}
          </Widget.Content>
        </Widget>
      </>
    );
  const hasPoints = history.series.some((row) => row.points.length > 0);
  const hasSelectedPoints = series.some((row) => row.points.length > 0);
  const agent = history.agent;
  const selectedServer = serverId ?? history.serverId;
  return (
    <section className="grid min-w-0 gap-4" aria-label="Performance history">
      <PerformancePageTitle
        agent={agent}
        actions={
          <div className="grid w-full min-w-0 grid-cols-2 items-center gap-2 sm:flex sm:w-auto sm:max-w-full sm:flex-wrap">
            {workload && history.series.length > 1 ? (
              <HistorySelect
                label="Instance"
                mobileFullWidth
                value={instance}
                onChange={setInstance}
                options={[
                  { id: "all", label: "All instances" },
                  ...history.series.map((row) => ({
                    id: row.id,
                    label: `Container · ${row.id.slice(0, 8)}`,
                  })),
                ]}
              />
            ) : null}
            <HistorySelect
              label="Aggregation"
              value={view}
              onChange={setView}
              options={[
                { id: "average", label: "Avg" },
                { id: "peak", label: "Peak" },
              ]}
            />
            <HistorySelect
              label="Time range"
              value={custom ? "custom" : range}
              onChange={(value) => {
                if (value === "custom") {
                  setPickerOpen(true);
                  return;
                }
                update({
                  range: value === "15m" ? null : value,
                  startAt: null,
                  endAt: null,
                });
              }}
              onReselect={(value) => {
                if (value === "custom") setPickerOpen(true);
              }}
              options={monitoringRanges.filter(
                (row) => row.days <= agent.retentionDays,
              )}
            />
          </div>
        }
      />
      <span role="status" className="sr-only">
        {updating ? "Updating charts…" : ""}
      </span>
      {pickerOpen ? (
        <MonitoringRangePicker
          initial={custom ?? { startAt: history.startAt, endAt: history.endAt }}
          retentionDays={agent.retentionDays}
          onApply={applyCustom}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {query.error ? <QueryError message={query.error} /> : null}
      {agent.desiredState !== "enabled" && hasPoints ? (
        <MonitoringEmptyState serverId={selectedServer} disabled historical />
      ) : null}
      {!hasSelectedPoints ? (
        <MonitoringEmptyState
          serverId={selectedServer}
          disabled={agent.desiredState !== "enabled"}
          filtered={hasPoints}
        />
      ) : (
        <>
          <div
            className="grid min-w-0 gap-4 xl:grid-cols-2"
            aria-busy={updating}
          >
            {(workload ? workloadMetrics : hostMetrics).map((metrics) => (
              <MonitoringChartSlot
                key={metrics[0]!.key}
                metrics={metrics}
                series={series}
                history={history}
                view={chartView}
                syncId={syncId}
                onRangeSelect={selectRange}
              />
            ))}
          </div>
          {history.seriesLimited ? (
            <p className="text-sm text-muted">
              Showing the 32 most recent instances. Choose a shorter range to
              inspect more detail.
            </p>
          ) : null}
          <MonitoringEvents
            key={`${path}:${custom ? `${custom.startAt}:${custom.endAt}` : range}:${instance}`}
            events={history.events}
            limited={history.eventsLimited}
          />
        </>
      )}
    </section>
  );
}
function PerformancePageTitle({
  actions,
  agent,
}: {
  actions?: ReactNode;
  agent?: History["agent"];
}) {
  return (
    <PageSelectionTitle
      actions={actions}
      badge={agent ? <MonitoringStatus agent={agent} /> : undefined}
      icon={<HugeiconsIcon aria-hidden="true" icon={Activity01Icon} />}
      keepEntityName
      label="Performance"
    />
  );
}
function MonitoringEmptyState({
  serverId,
  disabled,
  historical = false,
  filtered = false,
}: {
  serverId: string;
  disabled: boolean;
  historical?: boolean;
  filtered?: boolean;
}) {
  return (
    <Widget>
      <Widget.Content
        className={`grid place-content-center justify-items-center gap-3 text-center ${historical ? "" : "min-h-64"}`}
      >
        <ScoutMascot size={64} />
        <h3 className="font-medium">
          {disabled
            ? "Scout Agent is not enabled"
            : filtered
              ? "No measurements for this instance"
              : "No measurements in this range"}
        </h3>
        <p className="max-w-lg text-sm text-muted">
          {disabled
            ? "Install Scout Agent on this server to see how your apps and resources perform over time."
            : filtered
              ? "Choose another instance or time range to inspect available measurements."
              : "Metrics appear after Scout Agent reports. Try another time range or check Scout Agent’s connection."}
          {historical ? " Previously collected history is shown below." : ""}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <ButtonLink
            href={`/servers/${serverId}?section=settings&settings=monitoring`}
            variant="secondary"
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={Settings01Icon}
              className="size-4 shrink-0"
            />
            Scout Agent settings
          </ButtonLink>
          <MonitoringDocumentation />
        </div>
      </Widget.Content>
    </Widget>
  );
}
function HistorySelect({
  label,
  mobileFullWidth = false,
  value,
  onChange,
  onReselect,
  options,
}: {
  label: string;
  mobileFullWidth?: boolean;
  value: string;
  onChange: (value: string) => void;
  onReselect?: (value: string) => void;
  options: Array<{ id: string; label: string }>;
}) {
  return (
    <Select
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key) onChange(String(key));
      }}
      variant="secondary"
      className={`${mobileFullWidth ? "col-span-2" : ""} w-full min-w-0 ${label === "Time range" ? "sm:w-56" : "sm:w-44"} sm:max-w-full sm:shrink-0`}
    >
      <Label className="sr-only">{label}</Label>
      <Select.Trigger>
        <Select.Value className="flex min-w-0 items-center" />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item
              key={option.id}
              id={option.id}
              textValue={option.label}
              onPress={() => {
                if (option.id === value) onReselect?.(value);
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ScoutOptionIcon value={option.id} label={label} />
                {option.label}
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
