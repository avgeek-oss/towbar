"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeftIcon,
  PauseIcon,
  PlayIcon,
  Search01Icon,
  FunnelIcon,
  Settings02Icon,
  ServerStack01Icon,
  Layers01Icon,
  Package01Icon,
  Rocket01Icon,
  GitPullRequestIcon,
  CommandLineIcon,
  CodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { SearchField } from "@avgeek-oss/design-system/pickers/autocomplete";
import { Bar } from "recharts";
import { logBucketSeconds } from "@workspace/towbar-contracts";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { CodePanel } from "@workspace/towbar-web-ui/code-panel";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { LineChart } from "@avgeek-oss/design-system/charts/line-chart";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  logFilterSchema,
  type App,
  type Resource,
  type Server,
  type LogFilter,
  type LogQueryResult,
  type LogRecord,
  type LogStorageStatus,
  type LogSummary,
} from "@workspace/towbar-web-client";
import { DashboardPage } from "./page-parts";
import { MonitoringRangePicker } from "./monitoring-range-picker";
import type { CustomMonitoringRange } from "./monitoring-range";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  useLogWorkloadIcons,
  fallbackLogWorkloadIcon,
} from "@/hooks/use-log-workload-icons";
import { useLogFollow } from "@/hooks/use-log-follow";
import { useLocalizedTimestamps } from "@/hooks/use-localized-timestamps";
import { api } from "@/lib/api";
import {
  localizationRevision,
  subscribeLocalization,
  serverLocalizationRevision,
} from "@/lib/date-time-display";
import { useSyncExternalStore } from "react";
import { useAccess } from "./access-context";
import { EnvironmentIcon } from "./environment-icon";
import { ServiceLogo, ResourceLogo } from "./deployable-identity";
import { CloudProviderLogo } from "./cloud-provider-logo";
import { resourceImageBrand } from "./resource-image-brand";
import { LogSelect, type LogOption } from "./log-select";
import { LogFilterDialog } from "./log-filter-dialog";
import { LogColumnsDrawer } from "./log-columns-drawer";
import {
  builtInLogFields,
  conditionFilters,
  defaultLogColumns,
  logColumns,
  logDateTime,
  logLevelColors,
  logLevelBackgrounds,
  logLevels,
  logRangeLabel,
  type LogCondition,
  type CustomLogColumn,
  logColumnValue,
  logTimeWithSeconds,
} from "./log-explorer-model";

const LogGrid = dynamic(
  () =>
    import("@workspace/towbar-web-ui/read-only-data-grid").then(
      (module) => module.ReadOnlyDataGrid,
    ),
  { ssr: false },
);
const ranges = [
  { id: "15", label: "Last 15 minutes" },
  { id: "60", label: "Last hour" },
  { id: "360", label: "Last 6 hours" },
  { id: "1440", label: "Last 24 hours" },
  { id: "10080", label: "Last 7 days" },
  { id: "custom", label: "Custom range" },
];
const any = [{ id: "all", label: "All" }];
const maximumRecords = 10000;
function LevelMarker({ level }: { level: LogRecord["severity"] }) {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-1 shrink-0 rounded-[1px]"
      style={{
        backgroundColor: logLevelColors[level],
        opacity: level === "fatal" ? 1 : 0.8,
      }}
    />
  );
}
export function WorkspaceLogs() {
  const storage = useApiQuery<LogStorageStatus>(
    "/v1/core/observability/logs/status",
    15000,
  );
  return (
    <DashboardPage title="Logs" icon={AlignLeftIcon} fullWidth contentOwnsTitle>
      {storage.error ? (
        <QueryError message={storage.error} />
      ) : !storage.data ? (
        <QueryLoading />
      ) : storage.data.state === "ready" ? (
        <LogExplorer retentionDays={storage.data.retentionDays ?? 7} />
      ) : (
        <LogStorageEmpty status={storage.data} />
      )}
    </DashboardPage>
  );
}
function LogStorageEmpty({ status }: { status: LogStorageStatus }) {
  return (
    <div
      className="flex flex-col items-center gap-4 py-12 text-center"
      role="status"
    >
      <Image
        src="/mascots/clickhouse-logs.png"
        width={220}
        height={220}
        alt="Towbar mascot holding the ClickHouse logo"
        className="size-52 object-contain"
      />
      <p className="text-lg font-medium">
        {status.state === "not_configured"
          ? "Connect ClickHouse to enable log collection."
          : "Couldn't connect to ClickHouse."}
      </p>
      {status.reason ? (
        <p className="max-w-xl text-sm text-muted">{status.reason}</p>
      ) : null}
      <InlineExternalLink href={status.documentationUrl}>
        ClickHouse setup and requirements
      </InlineExternalLink>
    </div>
  );
}
function LogExplorer({ retentionDays }: { retentionDays: number }) {
  const { user } = useAccess();
  const apps = useApiQuery<{ apps: App[] }>("/v1/core/apps", 60000);
  const resources = useApiQuery<{ resources: Resource[] }>(
    "/v1/core/resources",
    60000,
  );
  const servers = useApiQuery<{ servers: Server[] }>("/v1/core/servers", 60000);
  const workloadIcons = useLogWorkloadIcons(
    apps.data?.apps,
    resources.data?.resources,
  );
  const [range, setRange] = useState("60"),
    [search, setSearch] = useState("");
  const [customRange, setCustomRange] = useState<CustomMonitoringRange | null>(
    null,
  );
  const [pickerOpen, setPickerOpen] = useState(false),
    [filterOpen, setFilterOpen] = useState(false),
    [columnsOpen, setColumnsOpen] = useState(false);
  const [conditions, setConditions] = useState<LogCondition[]>([]);
  const [match, setMatch] = useState<"and" | "or">("and");
  const [customColumns, setCustomColumns] = useState<CustomLogColumn[]>([]);
  const [selection, setSelection] = useState({
    workload: "all",
    environment: "production",
    severity: "all",
  });
  const [filters, setFilters] = useState<LogFilter | null>(null),
    [page, setPage] = useState<LogQueryResult | null>(null);
  const [summary, setSummary] = useState<LogSummary | null>(null),
    [selected, setSelected] = useState<LogRecord | null>(null);
  const [following, setFollowing] = useState(false),
    [busy, setBusy] = useState(false),
    [loadingMore, setLoadingMore] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] = useState(defaultLogColumns);
  const [catalogueKeys, setCatalogueKeys] = useState<string[]>([]);
  const historyFull = useMemo(
    () =>
      (page?.records.length ?? 0) >= maximumRecords ||
      (page?.records.reduce(
        (size, record) =>
          size + record.body.length + JSON.stringify(record.attributes).length,
        0,
      ) ?? 0) >=
        8 * 1024 * 1024,
    [page],
  );
  const revision = useRef(0),
    requestedCursor = useRef<string | null>(null);
  const load = useCallback(async (query: LogFilter) => {
    const generation = ++revision.current;
    requestedCursor.current = null;
    setLoadingMore(false);
    setBusy(true);
    setError(null);
    try {
      const [result, counts] = await Promise.all([
        api.post<LogQueryResult>("/v1/core/logs/query", {
          filters: query,
          limit: 200,
        }),
        api.post<LogSummary>("/v1/core/logs/summary", query),
      ]);
      if (revision.current !== generation) return;
      setPage(result);
      setSummary(counts);
      setCatalogueKeys((current) => [
        ...new Set([...current, ...(counts.attributeKeys ?? [])]),
      ]);
    } catch (cause) {
      if (revision.current === generation)
        setError(
          cause instanceof Error ? cause.message : "Could not search logs.",
        );
    } finally {
      if (revision.current === generation) setBusy(false);
    }
  }, []);
  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    if (
      !filters ||
      !cursor ||
      busy ||
      loadingMore ||
      following ||
      requestedCursor.current === cursor ||
      historyFull
    )
      return;
    const generation = revision.current;
    requestedCursor.current = cursor;
    setLoadingMore(true);
    try {
      const result = await api.post<LogQueryResult>("/v1/core/logs/query", {
        filters,
        cursor,
        limit: 200,
      });
      if (revision.current !== generation) return;
      if (page?.accessRevision !== result.accessRevision) {
        window.dispatchEvent(new Event("towbar:clear-private-data"));
        setError("Log access changed. Search again to reload logs.");
        return;
      }
      setPage((current) => {
        if (!current) return current;
        return {
          ...result,
          followCursor: current.followCursor,
          records: [
            ...new Map(
              [...current.records, ...result.records].map((record) => [
                record.eventId,
                record,
              ]),
            ).values(),
          ],
          partial: current.partial || result.partial,
        };
      });
    } catch (cause) {
      if (revision.current === generation)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load more logs. Search again to retry.",
        );
    } finally {
      if (revision.current === generation) setLoadingMore(false);
    }
  }, [page, filters, busy, loadingMore, following, historyFull]);
  const searchLogs = useCallback(() => {
    const now = Date.now() + 1000;
    const parsed = logFilterSchema.safeParse({
      from:
        customRange?.startAt ??
        new Date(now - Number(range) * 60000).toISOString(),
      to: customRange?.endAt ?? new Date(now).toISOString(),
      search,
      workloadIds: selection.workload.startsWith("workload:")
        ? [selection.workload.slice(9)]
        : [],
      ...conditionFilters(conditions, match),
      ...(selection.workload.startsWith("server:")
        ? { serverIds: [selection.workload.slice(7)] }
        : {}),
      environments:
        selection.environment === "all" ? [] : [selection.environment],
      severities: selection.severity === "all" ? [] : [selection.severity],
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the log filters.");
      return;
    }
    setFollowing(false);
    setSelected(null);
    setFilters(parsed.data);
    void load(parsed.data);
  }, [range, search, selection, customRange, conditions, match, load]);
  useEffect(() => {
    const timer = setTimeout(searchLogs, 350);
    return () => clearTimeout(timer);
  }, [searchLogs, user?.workspaceRole]);
  useEffect(() => {
    const clear = () => {
      revision.current++;
      setFollowing(false);
      setPage(null);
      setSummary(null);
      setCatalogueKeys([]);
      setConditions([]);
      setMatch("and");
      setCustomColumns([]);
      setVisibleColumns(defaultLogColumns);
      setSelected(null);
      setFilterOpen(false);
      setColumnsOpen(false);
    };
    clear();
    window.addEventListener("towbar:clear-private-data", clear);
    return () => {
      clear();
      window.removeEventListener("towbar:clear-private-data", clear);
    };
  }, [user?.workspaceRole]);
  useLogFollow({
    enabled: following,
    cursor: page?.followCursor,
    filters,
    onRecords: (records, accessRevision) => {
      if (page && page.accessRevision !== accessRevision) {
        window.dispatchEvent(new Event("towbar:clear-private-data"));
        setError("Log access changed. Search again to resume the live trail.");
        return;
      }
      setPage((current) =>
        current
          ? {
              ...current,
              records: [
                ...new Map(
                  [...records, ...current.records].map((record) => [
                    record.eventId,
                    record,
                  ]),
                ).values(),
              ]
                .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
                .slice(0, 2000),
            }
          : current,
      );
    },
    onError: (message) => {
      setFollowing(false);
      setError(message);
    },
  });
  useSyncExternalStore(
    subscribeLocalization,
    localizationRevision,
    serverLocalizationRevision,
  );
  const ticks = useMemo(() => {
    if (!filters) return [];
    const start = Date.parse(filters.from),
      end = Date.parse(filters.to);
    return Array.from({ length: 9 }, (_, index) =>
      Math.round(start + ((end - start) * index) / 8),
    );
  }, [filters]);
  const bucketRanges = useMemo(() => {
    if (!filters) return new Map<number, { from: number; to: number }>();
    const width = logBucketSeconds(filters.from, filters.to) * 1000;
    const start = Date.parse(filters.from),
      end = Date.parse(filters.to);
    const ranges = new Map<number, { from: number; to: number }>();
    for (let at = Math.floor(start / width) * width; at < end; at += width) {
      ranges.set(at, {
        from: Math.max(at, start),
        to: Math.min(at + width, end),
      });
    }
    return ranges;
  }, [filters]);
  const { error: localizationError } = useLocalizedTimestamps(
    filters
      ? [
          filters.from,
          filters.to,
          ...ticks,
          ...[...bucketRanges.values()].flatMap(({ from, to }) => [from, to]),
        ]
      : [],
  );
  const attributeKeys = [
    ...new Set([
      ...catalogueKeys,
      ...conditions
        .filter((condition) => condition.field.startsWith("attribute:"))
        .map((condition) => condition.field.slice(10)),
      ...visibleColumns
        .filter((id) => id.startsWith("attribute:"))
        .map((id) => id.slice(10)),
      ...(page?.records.flatMap((record) => Object.keys(record.attributes)) ??
        []),
    ]),
  ].sort();
  const availableColumns = [
    ...logColumns,
    ...customColumns,
    ...attributeKeys.map((key) => ({
      id: `attribute:${key}`,
      title: key,
      width: 180,
    })),
  ];
  const columns = visibleColumns.map(
    (id) =>
      availableColumns.find((column) => column.id === id) ?? {
        id,
        title: id.slice(10),
        width: 180,
      },
  );
  const rows =
    page?.records.map((record) => ({
      ...Object.fromEntries(
        Object.entries(record).filter(([, value]) => typeof value === "string"),
      ),
      ...Object.fromEntries(
        customColumns.map((column) => [
          column.id,
          logColumnValue(record, column.path),
        ]),
      ),
      timestamp: logDateTime(record.timestamp),
      serverId:
        servers.data?.servers.find((server) => server.id === record.serverId)
          ?.name ?? record.serverId,
      ...Object.fromEntries(
        Object.entries(record.attributes).map(([key, value]) => [
          `attribute:${key}`,
          value,
        ]),
      ),
    })) ?? [];
  const chart = useMemo(() => {
    if (!summary?.buckets.length) return [];
    const buckets = new Map(
      [...bucketRanges.keys()].map((at) => [
        at,
        {
          at,
          trace: 0,
          debug: 0,
          info: 0,
          warn: 0,
          error: 0,
          fatal: 0,
          unknown: 0,
        },
      ]),
    );
    for (const bucket of summary.buckets) {
      const entry = buckets.get(Date.parse(bucket.at));
      if (!entry) continue;
      const level =
        logLevels.find((level) => level === bucket.severity) ?? "unknown";
      entry[level] += bucket.count;
    }
    return [...buckets.values()];
  }, [summary, bucketRanges]);
  const icon = (value: typeof Layers01Icon) => (
    <HugeiconsIcon icon={value} size={18} aria-hidden="true" />
  );
  const workloadOptions: LogOption[] = [
    { id: "all", label: "All workloads and servers", icon: icon(Layers01Icon) },
    ...(apps.data?.apps ?? []).map((app) => ({
      id: `workload:${app.id}`,
      label: app.name,
      group: "Services",
      icon: <ServiceLogo app={app} size="compact" />,
    })),
    ...(resources.data?.resources ?? []).map((resource) => ({
      id: `workload:${resource.id}`,
      label: resource.name,
      group: "Datastores",
      icon: (
        <ResourceLogo
          brand={resourceImageBrand(resource.kind, resource.config.image)}
          size="compact"
        />
      ),
    })),
    ...(summary?.facets.workloadId ?? [])
      .filter(
        (item) =>
          !(
            apps.data?.apps.some((app) => app.id === item.id) ||
            resources.data?.resources.some(
              (resource) => resource.id === item.id,
            )
          ),
      )
      .map((item) => ({
        id: `workload:${item.id}`,
        label: item.name,
        group: "Retained workloads",
        icon: icon(Layers01Icon),
      })),
    ...(servers.data?.servers ?? []).map((server) => ({
      id: `server:${server.id}`,
      label: server.name ?? server.canonicalIp,
      searchText: `${server.name ?? ""} ${server.canonicalIp}`,
      group: "Servers",
      icon: server.hardware?.instance ? (
        <CloudProviderLogo
          provider={server.hardware.instance.provider}
          size={16}
        />
      ) : (
        icon(ServerStack01Icon)
      ),
    })),
  ];
  const filterFields: LogOption[] = [
    ...builtInLogFields.map((column) => ({
      id: column.id,
      label: column.title,
      group: "Log fields",
      icon: icon(
        (
          {
            service: Layers01Icon,
            deploymentId: Rocket01Icon,
            previewId: GitPullRequestIcon,
            containerId: Package01Icon,
            stream: CommandLineIcon,
          } as Record<string, typeof Layers01Icon>
        )[column.id] ?? CodeIcon,
      ),
    })),
    ...attributeKeys.map((key) => ({
      id: `attribute:${key}`,
      label: key,
      group: "Parsed attributes",
      icon: icon(CodeIcon),
    })),
  ];
  const filterValues: Record<string, LogOption[]> = Object.fromEntries(
    Object.entries(summary?.facets ?? {}).map(([key, items]) => [
      key,
      items.map((item) => ({ id: item.id, label: item.name })),
    ]),
  );
  filterValues.serverId = (servers.data?.servers ?? []).map((server) => ({
    id: server.id,
    label: server.name ?? server.canonicalIp,
    icon: icon(ServerStack01Icon),
  }));
  filterValues.stream = [
    { id: "stdout", label: "Standard output (stdout)" },
    { id: "stderr", label: "Error output (stderr)" },
  ];
  return (
    <div className="min-w-0">
      {pickerOpen ? (
        <MonitoringRangePicker
          initial={
            customRange ?? {
              startAt:
                filters?.from ?? new Date(Date.now() - 3600000).toISOString(),
              endAt: filters?.to ?? new Date().toISOString(),
            }
          }
          retentionDays={retentionDays}
          onApply={(value) => {
            setCustomRange(value);
            setRange("custom");
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {filterOpen ? (
        <LogFilterDialog
          conditions={conditions}
          fields={filterFields}
          values={filterValues}
          match={match}
          onApply={(next, combination) => {
            setConditions(next);
            setMatch(combination);
          }}
          onClose={() => setFilterOpen(false)}
        />
      ) : null}
      {columnsOpen ? (
        <LogColumnsDrawer
          columns={availableColumns}
          selected={visibleColumns}
          customColumns={customColumns}
          onApply={(next, custom) => {
            setVisibleColumns(next);
            setCustomColumns(custom);
          }}
          onClose={() => setColumnsOpen(false)}
        />
      ) : null}
      <div className="px-4 pt-3">
        <form
          className="grid grid-cols-2 items-center gap-2 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            searchLogs();
          }}
        >
          <SearchField
            className="col-span-2 min-w-0 lg:col-span-1"
            aria-label="Search logs"
            value={search}
            onChange={setSearch}
            variant="secondary"
          >
            <SearchField.Group>
              <SearchField.Input
                placeholder="Search logs…"
                maxLength={512}
                autoComplete="off"
                spellCheck={false}
                className="text-base sm:text-sm"
              />
              <SearchField.ClearButton aria-label="Clear search" />
            </SearchField.Group>
          </SearchField>
          <LogSelect
            label="Workload"
            hideLabel
            searchable
            value={selection.workload}
            options={workloadOptions}
            onChange={(workload) =>
              setSelection((current) => ({ ...current, workload }))
            }
          />
          <LogSelect
            label="Environment"
            hideLabel
            value={selection.environment}
            options={[
              ...any,
              {
                id: "production",
                label: "Production",
                icon: <EnvironmentIcon name="production" />,
              },
              {
                id: "preview",
                label: "Preview",
                icon: <EnvironmentIcon name="preview" />,
              },
            ]}
            onChange={(environment) =>
              setSelection((current) => ({ ...current, environment }))
            }
          />
          <LogSelect
            label="Level"
            hideLabel
            value={selection.severity}
            options={[
              { id: "all", label: "All levels" },
              ...logLevels.map((level) => ({
                id: level,
                label: level,
                icon: <LevelMarker level={level} />,
              })),
            ]}
            onChange={(severity) =>
              setSelection((current) => ({ ...current, severity }))
            }
          />
          <LogSelect
            label="Time range"
            hideLabel
            value={range}
            options={ranges}
            onChange={(value) => {
              if (value === "custom") {
                setPickerOpen(true);
                return;
              }
              setCustomRange(null);
              setRange(value);
            }}
          />
          <div className="col-span-2 flex items-center gap-2 lg:col-span-1">
            <Button
              isIconOnly
              className="relative size-11 lg:size-9"
              aria-label={
                conditions.length ? `Filters (${conditions.length})` : "Filters"
              }
              variant="secondary"
              onPress={() => setFilterOpen(true)}
            >
              <HugeiconsIcon icon={FunnelIcon} size={18} />
              {conditions.length ? (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 grid min-w-4 rounded-full bg-accent px-1 text-[10px] leading-4 text-accent-foreground"
                >
                  {conditions.length}
                </span>
              ) : null}
            </Button>
            <Button
              type="submit"
              className="size-11 lg:size-9"
              isIconOnly
              aria-label="Search"
              variant="primary"
              isDisabled={busy}
            >
              <HugeiconsIcon icon={Search01Icon} size={18} />
            </Button>
            <Button
              type="button"
              className="hidden size-9 lg:inline-flex"
              isIconOnly
              aria-label={following ? "Pause live trail" : "Live trail"}
              variant="primary"
              isDisabled={!page || busy || loadingMore}
              onPress={() => setFollowing((value) => !value)}
            >
              <HugeiconsIcon
                icon={following ? PauseIcon : PlayIcon}
                size={18}
              />
            </Button>
          </div>
        </form>
        {error || localizationError ? (
          <div className="mt-2">
            <QueryError message={error ?? localizationError!} />
          </div>
        ) : null}
      </div>
      <div
        className="mt-5 mb-3 flex items-center justify-between gap-3 px-4 text-xs text-muted"
        role="status"
      >
        <span>
          {busy
            ? "Searching…"
            : `${page?.records.length ?? 0} ${page?.records.length === 1 ? "record" : "records"} shown`}
          {following ? " · Live trail" : ""}
        </span>
        {filters ? (
          <span className="hidden tabular-nums sm:inline">
            {logRangeLabel(filters.from, filters.to)}
          </span>
        ) : null}
      </div>
      {chart.length && filters ? (
        <LineChart
          data-range-chart=""
          className="select-none touch-pan-y cursor-crosshair"
          data={chart}
          height={160}
          aria-label="Log volume over time"
          chartMargin={{ top: 8, bottom: 8, right: 16, left: 16 }}
        >
          <LineChart.XAxis
            dataKey="at"
            type="number"
            scale="time"
            allowDataOverflow
            domain={[Date.parse(filters.from), Date.parse(filters.to)]}
            ticks={ticks}
            minTickGap={16}
            interval="preserveStartEnd"
            tickFormatter={(value) =>
              filters &&
              Date.parse(filters.to) - Date.parse(filters.from) > 86400000
                ? logDateTime(Number(value))
                : logTimeWithSeconds(Number(value))
            }
          />
          <LineChart.YAxis allowDecimals={false} />
          {logLevels.map((level) => (
            <Bar
              key={level}
              name={level}
              dataKey={level}
              stackId="logs"
              fill={logLevelColors[level]}
              maxBarSize={24}
              isAnimationActive={false}
            />
          ))}
          <LineChart.Tooltip
            content={
              <LineChart.TooltipContent
                labelFormatter={(value) => {
                  const range = bucketRanges.get(Number(value));
                  return range
                    ? `${logTimeWithSeconds(range.from)} – ${logTimeWithSeconds(range.to)}`
                    : logTimeWithSeconds(Number(value));
                }}
              />
            }
          />
          <LineChart.Selection
            domain={[Date.parse(filters.from), Date.parse(filters.to)]}
            onSelect={(start, end) => {
              setCustomRange({
                startAt: new Date(start).toISOString(),
                endAt: new Date(end).toISOString(),
              });
              setRange("custom");
            }}
          />
        </LineChart>
      ) : (
        <div className="h-3" />
      )}
      <LogGrid
        label="Centralized log records"
        columns={columns}
        rows={rows}
        square
        cellIcons={{
          workloadName:
            page?.records.map(
              (record) =>
                workloadIcons[record.workloadId] ?? fallbackLogWorkloadIcon,
            ) ?? [],
        }}
        severityColors={logLevelColors}
        severityBackgrounds={logLevelBackgrounds}
        onEndReached={() => {
          void loadMore();
        }}
        onRowActivated={(index) => setSelected(page?.records[index] ?? null)}
        leadingHeader={
          <Tooltip>
            <Tooltip.Trigger<"button">
              aria-label="Edit columns"
              className="inline-flex h-full w-11 shrink-0 items-center justify-center bg-transparent p-0 text-muted hover:text-foreground focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-focus"
              render={(props) => (
                <button
                  {...props}
                  type="button"
                  onClick={() => setColumnsOpen(true)}
                />
              )}
            >
              <HugeiconsIcon icon={Settings02Icon} size={16} />
            </Tooltip.Trigger>
            <Tooltip.Content placement="top">Edit columns</Tooltip.Content>
          </Tooltip>
        }
      />
      {loadingMore ||
      (!busy && page && !page.records.length) ||
      historyFull ||
      page?.partial ||
      summary?.partial ? (
        <div className="px-4 py-2 text-xs text-muted" role="status">
          {loadingMore ? "Loading more logs…" : null}
          {!busy && page && !page.records.length ? (
            <>
              No matching logs. Check the filters or{" "}
              <Link href="/servers" className="underline underline-offset-4">
                enable collection on a server
              </Link>
              .
            </>
          ) : null}
          {historyFull
            ? "Loaded results reached the browser limit. Narrow the time range or filters to explore more."
            : null}
          {page?.partial || summary?.partial ? (
            <p className="text-warning">
              Results reached the query budget. Narrow the time range or
              filters.
            </p>
          ) : null}
        </div>
      ) : null}
      {selected ? (
        <LogDetails
          key={selected.eventId}
          record={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
function LogDetails({
  record,
  onClose,
}: {
  record: LogRecord;
  onClose: () => void;
}) {
  const common = {
    Workload: record.workloadName,
    Time: logDateTime(record.timestamp),
    Level: record.severity,
    Environment: record.environment,
    Server: record.serverId,
    Container: record.containerId,
    "Compose service": record.service || "—",
    "Output stream": record.stream,
    Deployment: record.deploymentId ?? "—",
    Preview: record.previewId ?? "—",
    "Trace ID": record.traceId ?? "—",
    "Span ID": record.spanId ?? "—",
  };
  return (
    <Drawer.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Drawer.Content placement="right">
        <Drawer.Dialog className="w-full max-w-3xl">
          <Drawer.Header>
            <Drawer.Heading>Log details</Drawer.Heading>
            <Drawer.CloseTrigger aria-label="Close log details" />
          </Drawer.Header>
          <Drawer.Body>
            <div className="grid min-w-0 gap-4">
              <Attributes title="Attributes" variant="card" columns={2}>
                {Object.entries(common).map(([label, value]) => (
                  <Attributes.Item key={label} label={label}>
                    <span className="break-all">{value}</span>
                  </Attributes.Item>
                ))}
              </Attributes>
              <CodePanel ariaLabel="Message">{record.body}</CodePanel>
              {record.truncated ? (
                <p className="text-sm text-warning">
                  This log record was truncated during collection.
                </p>
              ) : null}
              <CodePanel ariaLabel="Full log JSON" language="json">
                {JSON.stringify(record, null, 2)}
              </CodePanel>
            </div>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
