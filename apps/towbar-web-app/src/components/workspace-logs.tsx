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
  FilterHorizontalIcon,
  Settings02Icon,
  ServerStack01Icon,
  Layers01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Button,
  buttonVariants,
} from "@avgeek-oss/design-system/buttons/button";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Field, FieldLabel } from "@avgeek-oss/design-system/forms/field";
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
import {
  useLocalizedTimestamps,
  useLocalizedChartTicks,
} from "@/hooks/use-localized-timestamps";
import { api } from "@/lib/api";
import {
  displayTime,
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
  logLevels,
  logRangeLabel,
  type LogCondition,
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
      className="h-4 w-1 shrink-0 rounded-full"
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
    <DashboardPage title="Logs" icon={AlignLeftIcon} fullWidth>
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
    const now = Date.now();
    const parsed = logFilterSchema.safeParse({
      from:
        customRange?.startAt ??
        new Date(now - Number(range) * 60000).toISOString(),
      to: customRange?.endAt ?? new Date(now + 1000).toISOString(),
      search,
      workloadIds: selection.workload.startsWith("workload:")
        ? [selection.workload.slice(9)]
        : [],
      ...conditionFilters(conditions),
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
  }, [range, search, selection, customRange, conditions, load]);
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
  const { error: localizationError } = useLocalizedTimestamps(
    filters ? [filters.from, filters.to] : [],
  );
  const { ticks } = useLocalizedChartTicks(
    filters ? Date.parse(filters.from) : NaN,
    filters ? Date.parse(filters.to) : NaN,
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
    const buckets = new Map<string, number>();
    for (const bucket of summary?.buckets ?? [])
      buckets.set(bucket.at, (buckets.get(bucket.at) ?? 0) + bucket.count);
    return [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([at, count]) => ({ at: Date.parse(at), count }));
  }, [summary]);
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
    })),
    ...attributeKeys.map((key) => ({
      id: `attribute:${key}`,
      label: key,
      group: "Parsed attributes",
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
          onApply={setConditions}
          onClose={() => setFilterOpen(false)}
        />
      ) : null}
      {columnsOpen ? (
        <LogColumnsDrawer
          columns={availableColumns}
          selected={visibleColumns}
          onApply={setVisibleColumns}
          onClose={() => setColumnsOpen(false)}
        />
      ) : null}
      <div className="grid gap-3 px-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            searchLogs();
          }}
        >
          <Field className="min-w-48 flex-1">
            <FieldLabel htmlFor="log-search">Search logs</FieldLabel>
            <Input
              id="log-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search messages or trace IDs"
              variant="secondary"
              maxLength={512}
            />
          </Field>
          <div className="w-48">
            <LogSelect
              label="Time range"
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
          </div>
          <Button type="submit" variant="secondary" isDisabled={busy}>
            <HugeiconsIcon icon={Search01Icon} size={18} />
            Search
          </Button>
          <Button
            type="button"
            variant="secondary"
            isDisabled={!page || busy || loadingMore}
            onPress={() => setFollowing((value) => !value)}
          >
            <HugeiconsIcon icon={following ? PauseIcon : PlayIcon} size={18} />
            {following ? "Pause live trail" : "Live trail"}
          </Button>
        </form>
        <div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <LogSelect
            label="Workload"
            searchable
            value={selection.workload}
            options={workloadOptions}
            onChange={(workload) =>
              setSelection((current) => ({ ...current, workload }))
            }
          />
          <LogSelect
            label="Environment"
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
            value={selection.severity}
            options={[
              ...any,
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
          <div>
            <Button variant="secondary" onPress={() => setFilterOpen(true)}>
              <HugeiconsIcon icon={FilterHorizontalIcon} size={18} />
              Filters{conditions.length ? ` (${conditions.length})` : ""}
            </Button>
          </div>
        </div>
        {error || localizationError ? (
          <QueryError message={error ?? localizationError!} />
        ) : null}
      </div>
      <div
        className="mt-3 flex items-center justify-between gap-3 px-4 text-xs text-muted"
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
          height={100}
          aria-label="Log volume over time"
          chartMargin={{ top: 4, bottom: 4, right: 16, left: 16 }}
        >
          <LineChart.XAxis
            dataKey="at"
            type="number"
            scale="time"
            domain={[Date.parse(filters.from), Date.parse(filters.to)]}
            ticks={ticks}
            tickFormatter={(value) => displayTime(Number(value))}
          />
          <LineChart.YAxis allowDecimals={false} />
          <LineChart.Area
            dataKey="count"
            stroke="var(--accent)"
            fill="var(--accent)"
            fillOpacity={0.15}
            isAnimationActive={false}
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
        onEndReached={() => {
          void loadMore();
        }}
        onRowActivated={(index) => setSelected(page?.records[index] ?? null)}
        headerActions={
          <Tooltip>
            <Tooltip.Trigger<"button">
              aria-label="Edit columns"
              className={buttonVariants({
                isIconOnly: true,
                variant: "secondary",
              })}
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
            Results reached the query budget. Narrow the time range or filters.
          </p>
        ) : null}
      </div>
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
  const [context, setContext] = useState<LogRecord[] | null>(null),
    [error, setError] = useState<string | null>(null);
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
            <div className="content-grid">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                {Object.entries({
                  Workload: record.workloadName,
                  Time: logDateTime(record.timestamp),
                  Level: record.severity,
                  Environment: record.environment,
                  Container: record.containerId,
                  "Output stream": record.stream,
                  Deployment: record.deploymentId ?? "—",
                  "Trace ID": record.traceId ?? "—",
                }).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-muted">{label}</dt>
                    <dd className="break-all">{value}</dd>
                  </div>
                ))}
              </dl>
              <pre className="max-h-[45svh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-secondary p-4 text-sm">
                {record.body}
              </pre>
              {record.truncated ? (
                <p className="text-sm text-warning">
                  This log record was truncated during collection.
                </p>
              ) : null}
              {Object.keys(record.attributes).length ? (
                <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(record.attributes, null, 2)}
                </pre>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onPress={() => {
                    void navigator.clipboard
                      .writeText(record.body)
                      .catch(() =>
                        setError(
                          "Could not copy the message. Check clipboard access.",
                        ),
                      );
                  }}
                >
                  Copy message
                </Button>
                <Button
                  variant="secondary"
                  onPress={async () => {
                    try {
                      const result = await api.post<{ records: LogRecord[] }>(
                        "/v1/core/logs/context",
                        {
                          eventId: record.eventId,
                          workloadId: record.workloadId,
                          timestamp: record.timestamp,
                          limit: 10,
                        },
                      );
                      setContext(result.records);
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not read surrounding logs.",
                      );
                    }
                  }}
                >
                  Surrounding logs
                </Button>
              </div>
              {error ? <QueryError message={error} /> : null}
              {context ? (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {context
                    .map((entry) => `${entry.timestamp} ${entry.body}`)
                    .join("\n")}
                </pre>
              ) : null}
            </div>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
