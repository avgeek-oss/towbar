"use client";

import {
  TableCellStack,
  TableCellDescription,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import { DeploymentEnvironmentChip } from "./deployment-environment-chip";

import { deploymentLogoDomain, deploymentSubtitle } from "@/lib/overview";
import Image from "next/image";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  App,
  DeploymentHistoryItem,
  DeploymentHistoryPage,
} from "@workspace/towbar-web-client";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { InlineLink } from "./page-parts";
import { RelativeTime } from "./last-synced-time";
import { useApiQuery } from "@/hooks/use-api-query";
import { getDeploymentDisplayStatus } from "@/lib/deployment-status";
import { DomainLink } from "./domain-link";
import { deploymentStatusTooltip } from "./deployment-table";
import { deploymentHref } from "@/lib/deployment-route";
import illustrationStyles from "./overview-illustration.module.css";
import { AppLogo, ResourceLogo } from "./deployable-identity";
import { resourceImageBrand } from "./resource-image-brand";

export function OverviewIncidents() {
  const query = useApiQuery<{ activeIncidents: number }>(
    "/v1/core/monitoring/summary",
    30_000,
  );
  const count = query.data?.activeIncidents;
  return (
    <Widget className="min-w-0">
      <Widget.Header>
        <Widget.Title>Active incidents</Widget.Title>
      </Widget.Header>
      <Widget.Content
        className={`${illustrationStyles.card} relative flex items-center overflow-hidden py-3 pr-[38%]`}
        style={
          !query.error && count !== undefined
            ? {
                border: "1px solid transparent",
                background:
                  count > 0
                    ? "linear-gradient(color-mix(in srgb, var(--danger) 5%, var(--surface)), color-mix(in srgb, var(--danger) 5%, var(--surface))) padding-box, linear-gradient(135deg, color-mix(in srgb, var(--warning) 40%, var(--surface)), color-mix(in srgb, var(--danger) 40%, var(--surface))) border-box"
                    : "linear-gradient(color-mix(in srgb, var(--success) 5%, var(--surface)), color-mix(in srgb, var(--success) 5%, var(--surface))) padding-box, linear-gradient(135deg, color-mix(in srgb, var(--success) 20%, var(--surface)), color-mix(in srgb, var(--success) 40%, var(--surface))) border-box",
                boxShadow: "none",
              }
            : undefined
        }
      >
        {query.error ? (
          <QueryError message={query.error} />
        ) : count === undefined ? (
          <QueryLoading />
        ) : (
          <>
            <div className="grid justify-items-start gap-3">
              <InlineLink
                href="/monitoring/incidents"
                className="inline-flex items-center text-2xl font-semibold tracking-tight font-mono tabular-nums"
                aria-label={`${count} active ${count === 1 ? "incident" : "incidents"} — view all`}
              >
                {count}
              </InlineLink>
              <StatusBadge
                icon={count ? <HugeiconsIcon icon={Alert02Icon} /> : undefined}
                status={count ? "critical" : "healthy"}
                label={count ? "Attention" : "All clear"}
                tooltip={
                  count
                    ? `${count} active ${count === 1 ? "incident needs" : "incidents need"} attention.`
                    : "No incidents are currently active."
                }
              />
            </div>
            <Image
              src={
                count
                  ? "/scout/overview-smoking-matched.png"
                  : "/scout/overview-healthy-matched.png"
              }
              alt=""
              width={512}
              height={512}
              className={`${illustrationStyles.illustration} pointer-events-none absolute right-0 bottom-0 h-auto w-[38%] max-w-28 object-contain object-right-bottom`}
              preload
              unoptimized
            />
          </>
        )}
      </Widget.Content>
    </Widget>
  );
}

function deploymentColumns(
  apps: App[],
): ResourceTableColumn<DeploymentHistoryItem>[] {
  return [
    {
      key: "deployment",
      header: "Recent deployments",
      className: "min-w-52",
      wrapRowLink: false,
      cell: (item) => {
        const appDomain = apps.find((app) => app.id === item.appId)?.config
          .domains?.primary;
        const detail = deploymentSubtitle(item, appDomain);
        return (
          <div className="flex min-w-0 items-center gap-2">
            {item.deployableKind === "app" ||
            item.deployableKind === "compose" ? (
              <AppLogo
                deploymentId={item.id}
                domain={deploymentLogoDomain(
                  item,
                  item.deployableDomain ?? appDomain,
                )}
              />
            ) : (
              <ResourceLogo
                brand={resourceImageBrand(
                  item.deployableKind,
                  item.deployableImage ?? "",
                )}
              />
            )}
            <TableCellStack as="div" className="min-w-0">
              <InlineLink href={deploymentHref(item)}>
                {item.deployableName}
              </InlineLink>
              {detail ? (
                item.deployableKind === "app" ? (
                  <TableCellDescription className="max-w-48 truncate">
                    <DomainLink className="max-w-full" domain={detail}>
                      {detail}
                    </DomainLink>
                  </TableCellDescription>
                ) : (
                  <TableCellDescription className="max-w-48 truncate">
                    <TooltipText tooltip={detail}>{detail}</TooltipText>
                  </TableCellDescription>
                )
              ) : null}
            </TableCellStack>
          </div>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      className: "whitespace-nowrap",
      cell: (item) => (
        <StatusBadge
          status={getDeploymentDisplayStatus(item)}
          tooltip={deploymentStatusTooltip(item)}
        />
      ),
    },
    {
      key: "id",
      header: "ID",
      className: "whitespace-nowrap",
      cell: (item) => (
        <TypographyCode title={item.id}>{item.id.slice(0, 8)}</TypographyCode>
      ),
    },
    {
      key: "environment",
      header: "Environment",
      className: "whitespace-nowrap",
      cell: (item) => <DeploymentEnvironmentChip deployment={item} />,
    },
    {
      key: "requested",
      header: "Requested",
      className: "whitespace-nowrap",
      cell: (item) => <RelativeTime label="Requested" value={item.createdAt} />,
    },
  ];
}

export function OverviewDeployments({ apps }: { apps: App[] }) {
  const query = useApiQuery<DeploymentHistoryPage>(
    "/v1/core/deployments/history?page=1&limit=6",
    5_000,
  );
  return (
    <section aria-label="Recent deployments" className="min-w-0">
      {query.error ? (
        <QueryError message={query.error} />
      ) : !query.data ? (
        <QueryLoading variant="table" />
      ) : (
        <ResourceTable
          ariaLabel="Recent deployments"
          columns={deploymentColumns(apps)}
          items={query.data.deployments}
          getRowKey={(item) => item.id}
          getRowHref={deploymentHref}
          emptyTitle="No deployments yet"
          emptyDescription="Your latest deployments will appear here."
        />
      )}
    </section>
  );
}
