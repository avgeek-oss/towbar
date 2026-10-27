"use client";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { RelativeTime as SharedRelativeTime } from "./last-synced-time";

import { DatabaseIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";

import type {
  BackupAssurance,
  Resource,
  ResourceOperation,
  SourceBackup,
} from "@workspace/towbar-web-client";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { Tabs } from "@avgeek-oss/design-system/navigation/tabs";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";

import { ActionButton } from "@/components/page-parts";
import { CloudProviderLogo } from "@/components/cloud-provider-logo";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { getBackupHealth } from "@/lib/backup-health";
import { formatDate } from "./dashboard-overview";

type ProviderKey = "s3" | "gcs";

type ConfiguredProvider = {
  id: ProviderKey;
  label: string;
  providerName: string;
  locationUri: string;
  credentialsConfigured: boolean;
};

export function ResourceBackupConfiguration({
  active,
  resource,
}: {
  active: boolean;
  resource: Resource;
}) {
  const backup = resource.config.backup;

  const backups = useApiQuery<{ backups: SourceBackup[] }>(
    `/v1/core/sources/${resource.sourceId}/backups`,
    10_000,
  );
  const assurances = useApiQuery<{
    assurances: BackupAssurance[];
    awsConfigured: boolean;
    canRestore: boolean;
    gcpConfigured?: boolean;
    missingCredentialMessage?: string;
  }>(`/v1/core/resources/${resource.id}/backup-assurance`, 10_000);
  const operations = useApiQuery<{ operations: ResourceOperation[] }>(
    `/v1/core/resources/${resource.id}/operations`,
    5_000,
  );

  if (!backup) {
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>No managed backups configured</EmptyState.Title>
          <EmptyState.Description>
            Backups are disabled in the resource manifest. Configure backup
            storage to enable managed backups.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  }

  const error = backups.error ?? assurances.error ?? operations.error;
  if (error) return <QueryError message={error} />;
  if (!backups.data || !assurances.data || !operations.data) {
    return <QueryLoading />;
  }

  const retainedBackups = backups.data.backups.filter(
    (candidate) => candidate.resourceId === resource.id,
  );
  const assuranceData = assurances.data;
  const assuranceByBackup = new Map(
    assuranceData.assurances.map((item) => [item.backupOperationId, item]),
  );
  const latestBackup = retainedBackups[0];
  const latestAssurance = latestBackup
    ? assuranceByBackup.get(latestBackup.id)
    : undefined;
  const latestBackupOperation = operations.data.operations.find(
    (operation) => operation.type === "backup",
  );
  const backupHealth = getBackupHealth({
    assurance: latestAssurance,
    latestBackup,
    latestOperation: latestBackupOperation,
  });

  const missingProviders: string[] = [];
  if (backup.s3 && !assuranceData.awsConfigured)
    missingProviders.push("AWS S3");
  if (backup.gcs && !assuranceData.gcpConfigured)
    missingProviders.push("Google Cloud Storage");
  const credentialsConfigured = missingProviders.length === 0;

  const configuredProviders: ConfiguredProvider[] = [];
  if (backup.s3) {
    configuredProviders.push({
      id: "s3",
      label: "AWS S3",
      providerName: "AWS",
      locationUri: `s3://${backup.s3.bucket}/${backup.s3.prefix || "towbar"}`,
      credentialsConfigured: Boolean(assuranceData.awsConfigured),
    });
  }
  if (backup.gcs) {
    configuredProviders.push({
      id: "gcs",
      label: "Google Cloud Storage",
      providerName: "Google Cloud",
      locationUri: `gs://${backup.gcs.bucket}/${backup.gcs.prefix || "towbar"}`,
      credentialsConfigured: Boolean(assuranceData.gcpConfigured),
    });
  }

  return (
    <ResourceBackupContent
      active={active}
      backup={backup}
      backupHealth={backupHealth}
      configuredProviders={configuredProviders}
      credentialsConfigured={credentialsConfigured}
      latestAssurance={latestAssurance}
      latestBackup={latestBackup}
      latestBackupOperation={latestBackupOperation}
      missingProviders={missingProviders}
      retainedBackups={retainedBackups}
      resource={resource}
    />
  );
}

function ResourceBackupContent({
  active,
  backup,
  backupHealth,
  configuredProviders,
  credentialsConfigured,
  latestAssurance: _latestAssurance,
  latestBackup,
  latestBackupOperation,
  missingProviders,
  retainedBackups,
  resource,
}: {
  active: boolean;
  backup: NonNullable<Resource["config"]["backup"]>;
  backupHealth: ReturnType<typeof getBackupHealth>;
  configuredProviders: ConfiguredProvider[];
  credentialsConfigured: boolean;
  latestAssurance?: BackupAssurance;
  latestBackup?: SourceBackup;
  latestBackupOperation?: ResourceOperation;
  missingProviders: string[];
  retainedBackups: SourceBackup[];
  resource: Resource;
}) {
  const [selectedProvider, setSelectedProvider] = useState<ProviderKey>(
    configuredProviders[0]?.id ?? "s3",
  );
  return (
    <div className="content-grid min-w-0">
      <div className="content-grid min-w-0">
        {credentialsConfigured ? (
          <Widget className="min-w-0">
            <Widget.Header
              endContent={
                <TooltipText
                  className="inline-flex"
                  tooltip={backupHealth.description}
                >
                  <Chip
                    className="shrink-0"

                    color={backupHealth.tone}
                  >
                    <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                      {["In progress", "Checking"].includes(
                        backupHealth.label,
                      ) ? (
                        <Spinner
                          aria-hidden="true"
                          color="current"
                          size="sm"
                          className="size-3.5"
                        />
                      ) : null}
                      {backupHealth.label}
                    </Chip.Label>
                  </Chip>
                </TooltipText>
              }
            >
              <Widget.Title>{backupHealth.title}</Widget.Title>
            </Widget.Header>
            <Widget.Content className="grid min-w-0 gap-3">
              <ol className="grid overflow-hidden rounded-lg border border-separator divide-y divide-separator md:grid-cols-3 md:divide-x md:divide-y-0">
                {backupHealth.stages.map((stage) => (
                  <li
                    className="grid content-start gap-2 p-4"
                    key={stage.label}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium typography--body-sm">
                        {stage.label}
                      </span>
                      <Chip size="sm" color={stage.tone}>
                        <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                          {stage.status === "In progress" ? (
                            <Spinner
                              aria-hidden="true"
                              color="current"
                              size="sm"
                              className="size-3.5"
                            />
                          ) : null}
                          {stage.status}
                        </Chip.Label>
                      </Chip>
                    </div>
                    <p className="text-muted typography--body-sm">
                      {stage.description}
                    </p>
                  </li>
                ))}
              </ol>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p
                  className={
                    latestBackup ? "text-xs text-muted" : "text-sm text-muted"
                  }
                >
                  {latestBackup ? (
                    <>
                      Last retained snapshot:{" "}
                      <span className="font-medium text-foreground">
                        {formatDate(
                          latestBackup.finishedAt ?? latestBackup.createdAt,
                        )}
                      </span>
                    </>
                  ) : (
                    "No retained backups yet. Use Back up now to trigger the initial snapshot."
                  )}
                </p>
                <ActionButton
                  permission="resource.backup"
                  action={() =>
                    api.post(
                      `/v1/core/resources/${resource.id}/actions/backup`,
                      undefined,
                      { "Idempotency-Key": crypto.randomUUID() },
                    )
                  }
                  isDisabled={
                    !active ||
                    !credentialsConfigured ||
                    (latestBackupOperation &&
                      ["queued", "running"].includes(
                        latestBackupOperation.state,
                      ))
                  }
                  pendingLabel="Queueing backup…"
                  success="Datastore backup queued"
                  variant="secondary"
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={DatabaseIcon}
                    className="size-4 shrink-0"
                  />
                  Back up now
                </ActionButton>
              </div>
            </Widget.Content>
          </Widget>
        ) : (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Backups paused</Alert.Title>
              <Alert.Description>
                Enable {formatList(missingProviders)} in the Towbar API
                environment, then restart Towbar. See the{" "}
                <InlineLink href="https://www.towbar.dev/docs/self-hosting/configuration">
                  environment variable reference
                </InlineLink>{" "}
                before backups can run.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </div>

      {configuredProviders.length > 0 ? (
        <Tabs
          selectedKey={selectedProvider}
          onSelectionChange={(key) => setSelectedProvider(key as ProviderKey)}
          className="content-grid min-w-0"
        >
          <Tabs.ListContainer className="w-fit max-w-full overflow-x-auto">
            <Tabs.List aria-label="Backup provider destinations">
              {configuredProviders.map((provider) => (
                <Tabs.Tab
                  id={provider.id}
                  key={provider.id}
                  className="min-w-max gap-2 whitespace-nowrap"
                >
                  <CloudProviderLogo
                    provider={provider.id}
                    className="size-4 shrink-0"
                  />
                  <span>{provider.label}</span>
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>

          {configuredProviders.map((provider) => (
            <Tabs.Panel
              id={provider.id}
              key={provider.id}
              className="content-grid m-0 min-w-0 p-0 outline-none"
            >
              <ProviderDestinationCard backup={backup} provider={provider} />

              <ProviderBackupsTable
                backups={retainedBackups}
                provider={provider}
              />
            </Tabs.Panel>
          ))}
        </Tabs>
      ) : null}
    </div>
  );
}

function ProviderDestinationCard({
  backup,
  provider,
}: {
  backup: NonNullable<Resource["config"]["backup"]>;
  provider: ConfiguredProvider;
}) {
  return (
    <Attributes
      icon={
        <CloudProviderLogo provider={provider.id} className="size-5 shrink-0" />
      }
      title={`${provider.label} configuration`}
      variant="card"
    >
      <Attributes.Item label="Location">
        <TypographyCode
          className="inline-block max-w-full truncate align-middle"
          title={provider.locationUri}
        >
          {provider.locationUri}
        </TypographyCode>
      </Attributes.Item>
      {provider.id === "s3" && backup.s3 ? (
        <>
          <Attributes.Item label="Encryption">
            {backup.s3.encryption ?? "AES256"}
            {backup.s3.kmsKeyId ? ` (KMS: ${backup.s3.kmsKeyId})` : ""}
          </Attributes.Item>
          <Attributes.Item label="Region">
            {backup.s3.region ?? "Default (from credentials)"}
          </Attributes.Item>
        </>
      ) : null}
      {provider.id === "gcs" && backup.gcs ? (
        <>
          <Attributes.Item label="Encryption">Google-managed</Attributes.Item>
          <Attributes.Item label="Region">
            {backup.gcs.region ?? "Default"}
          </Attributes.Item>
        </>
      ) : null}
      <Attributes.Item label="Schedule">
        {backup.schedule ? (
          <TypographyCode
            className="inline-block max-w-full truncate align-middle"
            title={formatBackupSchedule(backup.schedule.cron)}
          >
            {backup.schedule.cron}
          </TypographyCode>
        ) : (
          "Manual only"
        )}
      </Attributes.Item>
      <Attributes.Item label="Retention">
        Keep {backup.retention.keepLast}
      </Attributes.Item>
      <Attributes.Item label="Credentials status">
        <StatusBadge
          status={provider.credentialsConfigured ? "healthy" : "critical"}
          label={provider.credentialsConfigured ? "Available" : "Not enabled"}
        />
      </Attributes.Item>
    </Attributes>
  );
}

function formatList(items: string[]) {
  if (items.length < 2) return items[0] ?? "a backup provider";
  if (items.length === 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function formatBackupSchedule(cron: string) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/);
  if (
    /^\d{1,2}$/.test(minute ?? "") &&
    /^\d{1,2}$/.test(hour ?? "") &&
    dayOfMonth === "*" &&
    month === "*"
  ) {
    const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
    if (dayOfWeek === "*") return `Daily at ${time} UTC`;
    const weekday = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ][Number(dayOfWeek)];
    if (weekday) return `Every ${weekday} at ${time} UTC`;
  }
  return "Custom schedule";
}

function ProviderBackupsTable({
  backups,
  provider,
}: {
  backups: SourceBackup[];
  provider: ConfiguredProvider;
}) {
  const destinationBackups = backups.filter((item) =>
    Boolean(getDestinationInfo(item, provider.id)),
  );

  const columns: ResourceTableColumn<SourceBackup>[] = [
    {
      key: "created",
      header: "Created",
      cell: (item) => (
        <RelativeTime
          label="Created"
          value={item.finishedAt ?? item.createdAt}
        />
      ),
      className: "min-w-48 whitespace-nowrap tabular-nums",
    },
    {
      key: "size",
      header: "Size",
      cell: (item) => formatBytes(item.result.sizeBytes),
      className: "whitespace-nowrap tabular-nums",
      headerClassName: "whitespace-nowrap",
    },
    {
      key: "engine",
      header: "Engine",
      cell: (item) =>
        item.result.engine && item.result.engineMajorVersion
          ? `${formatEngine(item.result.engine)} ${item.result.engineMajorVersion}`
          : "Metadata missing",
    },
    {
      key: "format",
      header: "Format",
      cell: (item) => formatBackupFormat(item.result.format),
    },
    {
      key: "object-key",
      header: "Object key",
      cell: (item) => {
        const info = getDestinationInfo(item, provider.id);
        if (!info?.key) return <span className="text-muted">—</span>;
        return (
          <TypographyCode
            className="inline-block max-w-64 truncate align-middle"
            title={info.key}
          >
            {info.key}
          </TypographyCode>
        );
      },
      className: "min-w-64",
    },
  ];

  return (
    <ResourceTable
      ariaLabel={`Retained backups for ${provider.label}`}
      columns={columns}
      emptyDescription={`Backups uploaded to ${provider.label} will appear here.`}
      emptyTitle="No backups in this destination"
      getRowKey={(item) => item.id}
      items={destinationBackups}
    />
  );
}

function getDestinationInfo(
  backupItem: SourceBackup,
  providerId: ProviderKey,
): {
  bucket?: string;
  encryption?: string;
  key?: string;
  region?: string;
} | null {
  const dest = backupItem.result.destinations?.find(
    (d) => d.provider === providerId,
  );
  if (dest) {
    return {
      bucket: dest.bucket,
      encryption: dest.encryption,
      key: dest.key,
      region: dest.region,
    };
  }
  // Fallback for legacy records created before multi-destination fan-out
  if (providerId === "s3" && backupItem.result.key) {
    return {
      bucket: backupItem.result.bucket,
      encryption: backupItem.result.encryption,
      key: backupItem.result.key,
      region: backupItem.result.region,
    };
  }
  return null;
}

export function RelativeTime({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return value ? <SharedRelativeTime label={label} value={value} /> : "—";
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatEngine(engine: SourceBackup["result"]["engine"]) {
  return engine
    ? {
        clickhouse: "ClickHouse",
        dragonfly: "Dragonfly",
        keydb: "KeyDB",
        mariadb: "MariaDB",
        mongodb: "MongoDB",
        mysql: "MySQL",
        postgres: "PostgreSQL",
        redis: "Redis",
      }[engine]
    : "Unknown";
}

export function formatBackupFormat(format: SourceBackup["result"]["format"]) {
  return format
    ? {
        "clickhouse-backup": "ClickHouse backup",
        "dragonfly-rdb": "Dragonfly RDB",
        "keydb-rdb": "KeyDB RDB",
        "mariadb-sql": "MariaDB SQL",
        "mongodb-archive": "MongoDB archive",
        "mysql-sql": "MySQL SQL",
        "postgres-custom": "PostgreSQL custom",
        "redis-rdb": "Redis RDB",
      }[format]
    : "Metadata missing";
}

export function InlineLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  if (/^https?:\/\//u.test(href)) {
    return (
      <InlineExternalLink className="font-medium" href={href}>
        {children}
      </InlineExternalLink>
    );
  }

  return (
    <Link
      className="focus-visible:ring-focus inline-flex items-center rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2"
      href={href}
    >
      {children}
    </Link>
  );
}
