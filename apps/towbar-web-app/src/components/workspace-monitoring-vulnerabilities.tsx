"use client";

import {
  TableCellStack,
  TableCellDescription,
  tableCellDescriptionClassName,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import { SecondaryItems } from "./secondary-sidebar";
import { ScoutIcon } from "./scout-icons";
import { useState } from "react";
import { useQueryChoice } from "@/hooks/use-page-query";
import Image from "next/image";
import { SecurityCheckIcon } from "@hugeicons/core-free-icons";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { useApiQuery } from "@/hooks/use-api-query";
import { DashboardPage, InlineLink } from "./page-parts";
import { AppLogo, ServiceLogo } from "./deployable-identity";
import {
  hasNoAdvisories,
  severityVariant,
  severityTooltip,
  VulnerabilitySeverityWidgets,
} from "./vulnerability-severity-widgets";
import { RelativeTime } from "./last-synced-time";
import type {
  App,
  VulnerabilityFindingSummary,
  WorkspaceVulnerabilityFindings,
} from "@workspace/towbar-web-client";
import { VulnerabilityAdvisoryLink } from "./vulnerability-advisory-link";
import { deploymentHref } from "@/lib/deployment-route";

const severityOrder = ["critical", "high", "medium", "low", "unknown"] as const;

export function WorkspaceVulnerabilities() {
  const [severity, setSeverity] = useQueryChoice(
    "severity",
    ["all", ...severityOrder],
    "all",
  );
  const [page, setPage] = useState(1);
  const query = useApiQuery<WorkspaceVulnerabilityFindings>(
    `/v1/core/monitoring/vulnerabilities?severity=${severity}&page=${page}&limit=20`,
    30_000,
    { keepPreviousData: true },
  );
  const apps = useApiQuery<{ apps: App[] }>("/v1/core/apps", 30_000);
  const columns: ResourceTableColumn<VulnerabilityFindingSummary>[] = [
    {
      key: "advisory",
      header: "Advisory",
      cell: (finding) => (
        <VulnerabilityAdvisoryLink advisoryId={finding.advisoryId} />
      ),
      className: "whitespace-nowrap",
    },
    {
      key: "severity",
      header: "Severity",
      cell: (finding) => (
        <TooltipText
          className="inline-flex"
          tooltip={severityTooltip(finding.severity)}
        >
          <Chip color={severityVariant(finding.severity)}>
            <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
              {finding.severity}
            </Chip.Label>
          </Chip>
        </TooltipText>
      ),
      className: "whitespace-nowrap",
    },
    {
      key: "package",
      header: "Package",
      cell: (finding) => (
        <TableCellStack>
          <span>{finding.packageName}</span>
          <TooltipText
            className={`${tableCellDescriptionClassName} max-w-36 truncate 2xl:hidden`}
            tooltip={finding.target}
          >
            {finding.target}
          </TooltipText>
        </TableCellStack>
      ),
      className: "min-w-28 whitespace-nowrap",
    },
    {
      key: "installed",
      header: "Installed",
      cell: (finding) => (
        <TypographyCode>{finding.installedVersion}</TypographyCode>
      ),
      className: "whitespace-nowrap",
    },
    {
      key: "fixed",
      header: "Fixed in",
      cell: (finding) =>
        finding.fixedVersion ? (
          <TypographyCode>{finding.fixedVersion}</TypographyCode>
        ) : (
          "Not available"
        ),
      className: "whitespace-nowrap",
    },
    {
      key: "entity",
      header: "Entity",
      cell: (finding) => {
        const app = apps.data?.apps.find((app) => app.id === finding.appId);
        return (
          <span className="inline-flex min-w-0 items-center gap-3">
            {app ? <ServiceLogo app={app} /> : <AppLogo domain={undefined} />}
            <TableCellStack>
              <InlineLink
                className="text-foreground"
                href={deploymentHref(
                  {
                    appId: finding.appId,
                    deployableKind: "app",
                    id: finding.deploymentId,
                  },
                  "vulnerabilities",
                )}
              >
                {finding.appName}
              </InlineLink>
              <TableCellDescription>Service</TableCellDescription>
              {finding.scannedAt ? (
                <span className="2xl:hidden">
                  <RelativeTime label="Scanned" value={finding.scannedAt} />
                </span>
              ) : null}
            </TableCellStack>
          </span>
        );
      },
      className: "whitespace-nowrap",
    },
    {
      key: "target",
      header: "Target",
      cell: (finding) => (
        <TooltipText tooltip={finding.target}>{finding.target}</TooltipText>
      ),
      className: "whitespace-nowrap",
    },
    {
      key: "scanned",
      header: "Scanned",
      cell: (finding) =>
        finding.scannedAt ? (
          <RelativeTime label="Scanned" value={finding.scannedAt} />
        ) : (
          "—"
        ),
      className: "whitespace-nowrap",
    },
  ];
  return (
    <DashboardPage title="Vulnerabilities" icon={SecurityCheckIcon}>
      <SecondaryItems
        title="Severity"
        selected={severity}
        onSelect={(value) => {
          setSeverity(value);
          setPage(1);
        }}
        items={[
          {
            id: "all",
            label: "All severities",
            icon: <ScoutIcon name="all" />,
          },
          {
            id: "critical",
            label: "Critical",
            icon: <ScoutIcon name="critical" />,
          },
          { id: "high", label: "High", icon: <ScoutIcon name="warning" /> },
          { id: "medium", label: "Medium", icon: <ScoutIcon name="warning" /> },
          { id: "low", label: "Low", icon: <ScoutIcon name="below" /> },
          {
            id: "unknown",
            label: "Unknown",
            icon: <ScoutIcon name="unknown" />,
          },
        ]}
      />
      <div className="grid gap-5">
        {query.error ? <QueryError message={query.error} /> : null}
        {query.data ? (
          <>
            <VulnerabilitySeverityWidgets
              totals={query.data.summary}
              selectedSeverity={severity === "all" ? undefined : severity}
            />
            <ResourceTable
              ariaLabel="Workspace vulnerability findings"
              columns={columns}
              getRowKey={(finding) =>
                [
                  finding.id,
                  finding.deploymentId,
                  finding.advisoryId,
                  finding.packageName,
                  finding.target,
                ].join(":")
              }
              items={query.data.findings}
              emptyMedia={
                hasNoAdvisories(query.data.summary) ? (
                  <Image
                    src="/mascots/happy.png"
                    alt=""
                    width={160}
                    height={160}
                    className="size-32 object-contain"
                  />
                ) : undefined
              }
              emptyTitle="No advisories in this view"
              emptyDescription="Findings from the latest scan of each App's production image appear here ranked by severity. Resources are not image-scanned."
              tableClassName="min-w-[760px] 2xl:min-w-[1080px]"
            />
            <div className="flex items-center justify-end gap-3">
              <span className="text-sm text-muted">Page {page}</span>
              <Button
                variant="secondary"
                isDisabled={page === 1 || query.isPreviousData}
                onPress={() => setPage((old) => old - 1)}
              >
                <ScoutIcon name="previous" />
                Previous
              </Button>
              <Button
                variant="secondary"
                isDisabled={!query.data.nextPage || query.isPreviousData}
                onPress={() => setPage((old) => old + 1)}
              >
                <ScoutIcon name="next" />
                Next
              </Button>
            </div>
          </>
        ) : !query.error ? (
          <QueryLoading />
        ) : null}
      </div>
    </DashboardPage>
  );
}
