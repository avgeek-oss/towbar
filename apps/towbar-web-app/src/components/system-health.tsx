"use client";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { useState } from "react";
import { HostUpgrade } from "./host-upgrade";
import { upgradeIsActive, upgradeNeedsRecovery } from "./host-upgrade-state";
import {
  AlertCircleIcon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  HealthIcon,
  InformationCircleIcon,
  ReloadIcon,
} from "@hugeicons/core-free-icons";

import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { LineChart } from "@avgeek-oss/design-system/charts/line-chart";

import { HugeiconsIcon } from "@hugeicons/react";

import type {
  LogStorageStatus,
  SystemHealth,
  SystemHealthCheck,
  SystemHealthStatus,
  TowbarUpdateInfo,
  TowbarUpgradeJob,
} from "@workspace/towbar-web-client";
import { ButtonLink } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { cn } from "@avgeek-oss/design-system/lib/utils";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";

import { ActionButton, DashboardPage } from "@/components/page-parts";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { displayChartDate, displayDateTime } from "@/lib/date-time-display";
import {
  useLocalizedChartTicks,
  useLocalizedTimestamps,
} from "@/hooks/use-localized-timestamps";
import { formatDate } from "./dashboard-overview";

const statusPresentation = {
  attention: {
    icon: AlertCircleIcon,
    label: "Attention",
    text: "text-warning",
    variant: "warning" as const,
  },
  critical: {
    icon: AlertCircleIcon,
    label: "Critical",
    text: "text-danger",
    variant: "danger" as const,
  },
  healthy: {
    icon: CheckmarkCircle02Icon,
    label: "Healthy",
    text: "text-success-soft-foreground",
    variant: "success" as const,
  },
  unknown: {
    icon: InformationCircleIcon,
    label: "Not checked",
    text: "text-muted",
    variant: "default" as const,
  },
};

export function SystemHealthPage() {
  const query = useApiQuery<SystemHealth>("/v1/core/system-health", 15_000);
  const logs = useApiQuery<LogStorageStatus>(
    "/v1/core/observability/logs/status",
    15_000,
  );
  const updateQuery = useApiQuery<TowbarUpdateInfo>(
    "/v1/core/version",
    15 * 60_000,
  );
  if (query.error && !query.data) {
    return (
      <DashboardPage icon={HealthIcon} title="System health">
        <QueryError message={query.error} />
        <HostUpgrade />
      </DashboardPage>
    );
  }
  if (!query.data) {
    return (
      <DashboardPage icon={HealthIcon} title="System health">
        <QueryLoading variant="dashboard" />
      </DashboardPage>
    );
  }
  const health = query.data;
  return (
    <DashboardPage
      icon={HealthIcon}
      actions={
        <ActionButton<SystemHealth>
          confirm={{
            title: "Run system checks?",
            description:
              "Verify that the API and database are responding and Temporal can accept maintenance work, then refresh the latest worker health status on this page.",
            actionLabel: "Run checks",
          }}
          action={() => api.post("/v1/core/system-health/actions/check")}
          onSuccess={() => query.refresh()}
          pendingLabel="Running checks…"
          success="System checks completed"
          variant="primary"
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={ReloadIcon}
            className="size-4 shrink-0"
          />
          Run checks
        </ActionButton>
      }
      title="System health"
    >
      <HealthChecks
        checks={health.checks}
        title="Control plane"
        version={health.version}
        updates={updateQuery.data}
        updateError={Boolean(updateQuery.error)}
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <StorageUsage kind="data" storage={health.databaseStorage} />
        <StorageUsage
          kind="logs"
          storage={health.databaseStorage}
          logStatus={logs.data}
          logError={logs.error}
        />
      </div>
    </DashboardPage>
  );
}

function StorageUsage({
  kind,
  storage,
  logStatus,
  logError,
}: {
  kind: "data" | "logs";
  storage: SystemHealth["databaseStorage"];
  logStatus?: LogStorageStatus;
  logError?: string | null;
}) {
  const data = storage.map((sample) => ({
    at: new Date(sample.sampledAt).getTime(),
    towbarBytes: sample.towbarBytes,
    monitoringBytes: sample.monitoringBytes,
    analyticsBytes: sample.analyticsBytes,
    logsBytes: sample.logsBytes ?? null,
  }));
  const series =
    kind === "data"
      ? [
          {
            key: "towbarBytes",
            name: "Towbar Data",
            color: "var(--chart-requested)",
          },
          {
            key: "monitoringBytes",
            name: "Monitoring Data",
            color: "var(--warning)",
          },
          {
            key: "analyticsBytes",
            name: "Analytics Data",
            color: "var(--chart-succeeded)",
          },
        ]
      : [
          {
            key: "logsBytes",
            name: "ClickHouse Logs",
            color: "var(--chart-requested)",
          },
        ];
  const first = data[0];
  const latest = data.at(-1);
  const total = latest
    ? kind === "logs"
      ? latest.logsBytes
      : latest.towbarBytes +
        latest.monitoringBytes +
        (latest.analyticsBytes ?? 0)
    : null;
  const hasReadings =
    kind === "data"
      ? data.length > 0
      : data.some((sample) => sample.logsBytes !== null);
  const issue =
    kind === "logs"
      ? (logError ?? logStatus?.reason ?? storage.at(-1)?.logsError)
      : null;
  const start = first?.at ?? Date.now() - 90 * 24 * 60 * 60_000;
  const end = latest?.at ?? Date.now();
  const { ticks, error: dateLabelError } = useLocalizedChartTicks(start, end);
  useLocalizedTimestamps(storage.map((sample) => sample.sampledAt));
  return (
    <Widget className="min-w-0">
      <Widget.Header
        endContent={
          total !== null ? (
            <span className="text-xs tabular-nums text-muted">
              Total {formatBytes(total)}
            </span>
          ) : null
        }
      >
        <Widget.Title>
          {kind === "data" ? "Data Storage" : "Log Storage"}
        </Widget.Title>
      </Widget.Header>
      <Widget.Content className="grid min-w-0 gap-3">
        {dateLabelError ? <QueryError message={dateLabelError} /> : null}
        {issue ? <QueryError message={issue} /> : null}
        {kind === "logs" && logStatus?.state === "not_configured" ? (
          <p className="text-sm text-muted">
            Connect ClickHouse to track log storage usage.{" "}
            <InlineExternalLink href={logStatus.documentationUrl}>
              Setup and requirements
            </InlineExternalLink>
          </p>
        ) : null}
        {hasReadings ? (
          <>
            <LineChart
              aria-label={
                kind === "data"
                  ? "Towbar, monitoring, and analytics database storage over the last 90 days"
                  : "ClickHouse log storage over the last 90 days"
              }
              data={data}
              height={240}
            >
              <LineChart.Grid vertical={false} />
              <LineChart.XAxis
                dataKey="at"
                type="number"
                scale="time"
                domain={[start, Math.max(start + 1, end)]}
                ticks={ticks}
                tickFormatter={displayChartDate}
                minTickGap={45}
                tick={{ fontSize: 11 }}
              />
              <LineChart.YAxis
                width={65}
                domain={[0, "auto"]}
                tickFormatter={(value) =>
                  formatBytes(Number(value)).replace(" ", "\u00a0")
                }
                tick={{ fontSize: 11 }}
              />
              {series.map((series) => (
                <LineChart.Area
                  key={series.key}
                  dataKey={series.key}
                  name={series.name}
                  stroke={series.color}
                  fill={series.color}
                  fillOpacity={0.4}
                  stackId="storage"
                  strokeWidth={2}
                  dot={data.length === 1 ? { r: 3 } : false}
                  isAnimationActive={false}
                  type="monotone"
                  connectNulls={false}
                />
              ))}
              <LineChart.Tooltip
                content={
                  <LineChart.TooltipContent
                    labelFormatter={(value) => displayDateTime(Number(value))}
                    valueFormatter={(value) => formatBytes(Number(value))}
                  />
                }
              />
            </LineChart>
            <Widget.Legend className="flex-wrap">
              {series.map((series) => (
                <Widget.LegendItem key={series.key} color={series.color}>
                  {series.name}
                </Widget.LegendItem>
              ))}
            </Widget.Legend>
          </>
        ) : !issue &&
          !(kind === "logs" && logStatus?.state === "not_configured") ? (
          <p className="text-sm text-muted">
            {kind === "data"
              ? "Waiting for the first database storage reading."
              : "Waiting for the first ClickHouse storage reading. Storage is sampled every two hours."}
          </p>
        ) : null}
      </Widget.Content>
    </Widget>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length,
  );
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** exponent)} ${units[exponent - 1]}`;
}

function HealthChecks({
  checks,
  version,
  title,
  updates,
  updateError,
}: {
  checks: SystemHealthCheck[];
  version?: string;
  title: string;
  updates?: TowbarUpdateInfo;
  updateError: boolean;
}) {
  return (
    <Widget>
      <Widget.Header>
        <Widget.Title>{title}</Widget.Title>
      </Widget.Header>
      <Widget.Content className="grid p-0">
        {checks.map((check) => {
          const stale = isCheckStale(check);
          const presentation =
            statusPresentation[stale ? "attention" : check.status];
          return (
            <div
              className="grid gap-3 border-b border-separator px-5 py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              key={check.id}
            >
              <div className="flex min-w-0 items-start gap-3">
                <HugeiconsIcon
                  aria-hidden="true"
                  className={cn("mt-0.5 size-5 shrink-0", presentation.text)}
                  icon={presentation.icon}
                />
                <div className="grid min-w-0 gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">{check.title}</h3>
                    <HealthStatusChip
                      checkedAt={check.checkedAt}
                      stale={stale}
                      status={check.status}
                    />
                  </div>
                  <p className="text-sm text-muted">{check.description}</p>
                  {check.checkedAt ? (
                    <p className="text-xs text-muted">
                      Checked {formatDate(check.checkedAt)}
                    </p>
                  ) : null}
                </div>
              </div>
              {check.remediationHref && check.remediationLabel ? (
                <ButtonLink href={check.remediationHref} variant="secondary">
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={ArrowRight01Icon}
                    className="size-4 shrink-0"
                  />
                  {check.remediationLabel}
                </ButtonLink>
              ) : null}
            </div>
          );
        })}
        <TowbarUpdates updates={updates} error={updateError} />
      </Widget.Content>
      {version ? (
        <Widget.Footer>
          <Widget.FooterDescription>
            Version{" "}
            <TooltipText className="font-mono" tooltip={version}>
              {shortVersion(version)}
            </TooltipText>
          </Widget.FooterDescription>
        </Widget.Footer>
      ) : null}
    </Widget>
  );
}

function TowbarUpdates({
  updates,
  error,
}: {
  updates?: TowbarUpdateInfo;
  error: boolean;
}) {
  const [job, setJob] = useState<TowbarUpgradeJob>();
  const active = upgradeIsActive(job?.state);
  const recovery = upgradeNeedsRecovery(job?.state);
  const status = error ? "unavailable" : updates?.status;
  const current = status === "current" && !active && !recovery;
  const description =
    active && job
      ? `Towbar is upgrading from ${job.currentVersion} to ${job.targetVersion}.`
      : status === "unavailable"
        ? "The latest release could not be checked. Try again later."
        : !updates
          ? "Checking the latest published stable release."
          : status === "available"
            ? `You’re running Towbar v${updates.installedVersion}. An upgrade to v${updates.latestVersion} is available.`
            : status === "current"
              ? `This installation runs the latest stable release, v${updates.installedVersion}.`
              : `This installation runs v${updates.installedVersion}, ahead of the latest stable release v${updates.latestVersion}.`;
  return (
    <div className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <HugeiconsIcon
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-5 shrink-0",
            recovery
              ? "text-danger-soft-foreground"
              : current
                ? "text-success-soft-foreground"
                : "text-muted",
          )}
          icon={current ? CheckmarkCircle02Icon : ReloadIcon}
        />
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Towbar version</h3>
            {recovery ? (
              <Chip color="danger">
                <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                  Recovery required
                </Chip.Label>
              </Chip>
            ) : active ? (
              <Chip color="warning">
                <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                  <Spinner size="sm" color="current" />
                  Upgrade in progress
                </Chip.Label>
              </Chip>
            ) : status === "available" ? (
              <Chip color="warning">
                <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                  Update available
                </Chip.Label>
              </Chip>
            ) : current ? (
              <Chip color="success">
                <Chip.Label className="whitespace-nowrap">Latest</Chip.Label>
              </Chip>
            ) : null}
          </div>
          <p className="text-sm text-muted">{description}</p>
          {updates?.checkedAt ? (
            <p className="text-xs text-muted">
              Checked {formatDate(updates.checkedAt)}
            </p>
          ) : null}
        </div>
      </div>
      <HostUpgrade
        targetVersion={status === "available" ? updates?.latestVersion : null}
        onJobChange={setJob}
      />
    </div>
  );
}

function HealthStatusChip({
  checkedAt,
  stale = false,
  status,
  tooltip,
}: {
  checkedAt?: string | null;
  stale?: boolean;
  status: SystemHealthStatus;
  tooltip?: string;
}) {
  const presentation = statusPresentation[stale ? "attention" : status];
  return (
    <TooltipText
      className="inline-flex"
      tooltip={
        tooltip ??
        (checkedAt
          ? `${stale ? "This result is stale. Last checked" : "Last checked"} ${formatDate(checkedAt)}.`
          : "This check has not run yet.")
      }
    >
      <Chip color={presentation.variant}>
        <Chip.Label className="whitespace-nowrap">
          {stale ? "Checks stale" : presentation.label}
        </Chip.Label>
      </Chip>
    </TooltipText>
  );
}

function isCheckStale(check: SystemHealthCheck) {
  if (!check.checkedAt) return true;
  return Date.now() - new Date(check.checkedAt).getTime() > 15 * 60 * 1000;
}

function shortVersion(version: string) {
  return /^[a-f0-9]{40}$/u.test(version) ? version.slice(0, 12) : version;
}
