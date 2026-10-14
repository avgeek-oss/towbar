"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeftIcon,
  PauseIcon,
  PlayIcon,
  ReloadIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { LineChart } from "@avgeek-oss/design-system/charts/line-chart";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  logFilterSchema,
  type LogFilter,
  type LogQueryResult,
  type LogRecord,
  type LogStorageStatus,
  type LogSummary,
} from "@workspace/towbar-web-client";
import { DashboardPage } from "./page-parts";
import { ScoutSelect } from "./scout-controls";
import { MonitoringRangePicker } from "./monitoring-range-picker";
import type { CustomMonitoringRange } from "./monitoring-range";
import { useApiQuery } from "@/hooks/use-api-query";
import { useLogFollow } from "@/hooks/use-log-follow";
import { api } from "@/lib/api";
import { displayDateTime, displayTime } from "@/lib/date-time-display";
import { useAccess } from "./access-context";

const LogGrid = dynamic(
  () =>
    import("@workspace/towbar-web-ui/read-only-data-grid").then(
      (module) => module.ReadOnlyDataGrid,
    ),
  { ssr: false },
);
const columns = [
  { id: "time", title: "Time", width: 190 },
  { id: "severity", title: "Level", width: 90 },
  { id: "workload", title: "Workload", width: 190 },
  { id: "environment", title: "Environment", width: 110 },
  { id: "message", title: "Message", width: 800 },
];
const ranges = [
  { id: "15", label: "Last 15 minutes" },
  { id: "60", label: "Last hour" },
  { id: "360", label: "Last 6 hours" },
  { id: "1440", label: "Last 24 hours" },
  { id: "10080", label: "Last 7 days" },
  { id: "custom", label: "Custom range" },
];
const any = [{ id: "all", label: "All" }];

export function WorkspaceLogs() {
  const storage = useApiQuery<LogStorageStatus>(
    "/v1/core/observability/logs/status",
    15000,
  );
  return (
    <DashboardPage title="Logs" icon={AlignLeftIcon}>
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
  const [range, setRange] = useState("60"),
    [search, setSearch] = useState("");
  const [customRange, setCustomRange] = useState<CustomMonitoringRange | null>(
    null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<LogFilter | null>(null),
    [page, setPage] = useState<LogQueryResult | null>(null);
  const [summary, setSummary] = useState<LogSummary | null>(null),
    [selected, setSelected] = useState<LogRecord | null>(null);
  const [following, setFollowing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const revision = useRef(0);
  const load = useCallback(async (query: LogFilter, cursor?: string) => {
    const generation = ++revision.current;
    setBusy(true);
    setError(null);
    try {
      const [result, counts] = await Promise.all([
        api.post<LogQueryResult>("/v1/core/logs/query", {
          filters: query,
          cursor,
          limit: 200,
        }),
        api.post<LogSummary>("/v1/core/logs/summary", query),
      ]);
      if (revision.current !== generation) return;
      setPage(result);
      setSummary(counts);
    } catch (cause) {
      if (revision.current === generation)
        setError(
          cause instanceof Error ? cause.message : "Could not search logs.",
        );
    } finally {
      if (revision.current === generation) setBusy(false);
    }
  }, []);
  const searchLogs = useCallback(() => {
    const now = Date.now();
    const selectedId = (key: string) =>
      selection[key] && selection[key] !== "all" ? [selection[key]!] : [];
    const parsed = logFilterSchema.safeParse({
      from:
        customRange?.startAt ??
        new Date(now - Number(range) * 60000).toISOString(),
      to: customRange?.endAt ?? new Date(now + 1000).toISOString(),
      search,
      workloadIds: selectedId("workloadId"),
      serverIds: selectedId("serverId"),
      deploymentIds: selectedId("deploymentId"),
      previewIds: selectedId("previewId"),
      containerIds: selectedId("containerId"),
      services: selectedId("service"),
      environments: selectedId("environment"),
      severities: selectedId("severity"),
      stream:
        selection.stream && selection.stream !== "all"
          ? selection.stream
          : undefined,
      traceId: selection.traceId || undefined,
      attributes: selection.attributeKey
        ? [
            {
              key: selection.attributeKey,
              value: selection.attributeValue ?? "",
              operator: selection.attributeOperator ?? "equals",
            },
          ]
        : [],
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the log filters.");
      return;
    }
    const next = parsed.data;
    setFollowing(false);
    setCursors([undefined]);
    setSelected(null);
    setFilters(next);
    void load(next);
  }, [range, search, selection, customRange, load]);
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
      setSelected(null);
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
        setError(
          "Log access changed. Refresh the search before following again.",
        );
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
  const rows = useMemo(
    () =>
      page?.records.map((record) => ({
        time: displayDateTime(record.timestamp),
        severity: record.severity,
        workload: record.workloadName,
        environment: record.environment,
        message: record.body,
      })) ?? [],
    [page],
  );
  const chart = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const bucket of summary?.buckets ?? [])
      buckets.set(bucket.at, (buckets.get(bucket.at) ?? 0) + bucket.count);
    return [...buckets].map(([at, count]) => ({ at: Date.parse(at), count }));
  }, [summary]);
  const choose = (key: string, value: string) =>
    setSelection((current) => ({ ...current, [key]: value }));
  const facet = (key: string) => [
    ...any,
    ...(summary?.facets[key] ?? []).map((item) => ({
      id: item.id,
      label:
        key === "workloadId" || key === "service"
          ? item.name
          : item.id.slice(0, 12),
    })),
  ];
  return (
    <div className="content-grid min-w-0">
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
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          searchLogs();
        }}
      >
        <div className="grid min-w-48 flex-1 gap-2">
          <Label htmlFor="log-search">Search logs</Label>
          <Input
            id="log-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search messages"
            variant="secondary"
          />
        </div>
        <div className="w-48">
          <ScoutSelect
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
          isDisabled={busy || !filters}
          onPress={() => {
            if (filters) void load(filters, cursors.at(-1));
          }}
        >
          <HugeiconsIcon icon={ReloadIcon} size={18} />
          Refresh
        </Button>
        <Button
          type="button"
          variant="secondary"
          isDisabled={!page}
          onPress={() => setFollowing((value) => !value)}
        >
          <HugeiconsIcon icon={following ? PauseIcon : PlayIcon} size={18} />
          {following ? "Pause" : "Follow"}
        </Button>
      </form>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ScoutSelect
          label="Workload"
          value={selection.workloadId ?? "all"}
          options={facet("workloadId")}
          onChange={(value) => choose("workloadId", value)}
        />
        <ScoutSelect
          label="Environment"
          value={selection.environment ?? "all"}
          options={[
            ...any,
            { id: "production", label: "Production" },
            { id: "preview", label: "Preview" },
          ]}
          onChange={(value) => choose("environment", value)}
        />
        <ScoutSelect
          label="Level"
          value={selection.severity ?? "all"}
          options={[
            ...any,
            ...[
              "trace",
              "debug",
              "info",
              "warn",
              "error",
              "fatal",
              "unknown",
            ].map((id) => ({ id, label: id })),
          ]}
          onChange={(value) => choose("severity", value)}
        />
        <ScoutSelect
          label="Stream"
          value={selection.stream ?? "all"}
          options={[
            ...any,
            { id: "stdout", label: "stdout" },
            { id: "stderr", label: "stderr" },
          ]}
          onChange={(value) => choose("stream", value)}
        />
      </div>
      <details>
        <summary className="w-fit cursor-pointer text-sm text-muted">
          More filters
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(
            [
              ["serverId", "Server"],
              ["deploymentId", "Deployment"],
              ["previewId", "Preview"],
              ["containerId", "Container"],
              ["service", "Compose service"],
            ] as const
          ).map(([key, label]) => (
            <ScoutSelect
              key={key}
              label={label}
              value={selection[key] ?? "all"}
              options={facet(key)}
              onChange={(value) => choose(key, value)}
            />
          ))}
          <div className="grid gap-2">
            <Label htmlFor="log-trace">Trace ID</Label>
            <Input
              id="log-trace"
              variant="secondary"
              value={selection.traceId ?? ""}
              onChange={(event) => choose("traceId", event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="log-attribute-key">Attribute name</Label>
            <Input
              id="log-attribute-key"
              variant="secondary"
              value={selection.attributeKey ?? ""}
              onChange={(event) => choose("attributeKey", event.target.value)}
              maxLength={128}
            />
          </div>
          <ScoutSelect
            label="Attribute match"
            value={selection.attributeOperator ?? "equals"}
            options={[
              { id: "equals", label: "Equals" },
              { id: "contains", label: "Contains" },
            ]}
            onChange={(value) => choose("attributeOperator", value)}
          />
          <div className="grid gap-2">
            <Label htmlFor="log-attribute-value">Attribute value</Label>
            <Input
              id="log-attribute-value"
              variant="secondary"
              value={selection.attributeValue ?? ""}
              onChange={(event) => choose("attributeValue", event.target.value)}
              maxLength={512}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            onPress={() => setPickerOpen(true)}
          >
            Choose dates
          </Button>
        </div>
      </details>
      {error ? <QueryError message={error} /> : null}
      <div
        className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted"
        role="status"
      >
        <span>
          {busy ? "Searching…" : `${page?.records.length ?? 0} records shown`}
          {following ? " · Following" : ""}
        </span>
        <span>Retained for {retentionDays} days</span>
      </div>
      {chart.length ? (
        <LineChart data={chart} height={120} aria-label="Log volume over time">
          <LineChart.XAxis
            dataKey="at"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
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
        </LineChart>
      ) : null}
      <LogGrid
        label="Centralized log records"
        columns={columns}
        rows={rows}
        onRowActivated={(index) => setSelected(page?.records[index] ?? null)}
      />
      {page?.records.length ? (
        <p className="text-xs text-muted">
          <span className="hidden sm:inline">
            Double-click a record or press Enter to read its details.
          </span>
          <span className="sm:hidden">Tap a record to read its details.</span>
        </p>
      ) : null}
      {!busy && page && !page.records.length ? (
        <p className="text-sm text-muted" role="status">
          No matching logs. Check the filters or{" "}
          <Link href="/servers" className="underline underline-offset-4">
            enable collection on a server
          </Link>
          .
        </p>
      ) : null}
      {page?.partial || summary?.partial ? (
        <p className="text-sm text-warning" role="status">
          Results reached the query budget. Narrow the time range or filters.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted">Page {cursors.length}</span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            isDisabled={busy || following || cursors.length === 1}
            onPress={() => {
              const next = cursors.slice(0, -1);
              setCursors(next);
              if (filters) void load(filters, next.at(-1));
            }}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            isDisabled={
              busy || following || !page?.nextCursor || cursors.length >= 100
            }
            onPress={() => {
              if (filters && page?.nextCursor) {
                setCursors((current) => [...current, page.nextCursor!]);
                void load(filters, page.nextCursor);
              }
            }}
          >
            Next
          </Button>
        </div>
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
                  Time: displayDateTime(record.timestamp),
                  Level: record.severity,
                  Environment: record.environment,
                  Container: record.containerId,
                  Stream: record.stream,
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
