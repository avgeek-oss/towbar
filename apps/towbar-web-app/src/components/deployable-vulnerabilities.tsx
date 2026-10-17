"use client";
import { useUrlTablePagination } from "@/hooks/use-url-pagination";
import Image from "next/image";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { ScoutIcon } from "./scout-icons";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";

import { useApiQuery } from "@/hooks/use-api-query";
import { RelativeTime } from "./last-synced-time";
import {
  hasNoAdvisories,
  severityVariant,
  severityTooltip,
  VulnerabilitySeverityWidgets,
} from "./vulnerability-severity-widgets";
import type {
  VulnerabilityFindingSummary,
  WorkspaceVulnerabilityFindings,
} from "@workspace/towbar-web-client";
import { VulnerabilityAdvisoryLink } from "./vulnerability-advisory-link";

export function DeployableVulnerabilities({
  appId,
  kind,
}: {
  appId: string;
  kind: "app" | "resource";
}) {
  const { page, setPage } = useUrlTablePagination();
  const query = useApiQuery<WorkspaceVulnerabilityFindings>(
    kind === "app"
      ? `/v1/core/monitoring/vulnerabilities?appId=${appId}&limit=50&page=${page}`
      : null,
  );
  if (kind === "resource") {
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>Resources are not image-scanned</EmptyState.Title>
          <EmptyState.Description>
            Towbar scans container images for Apps. Database and image Resources
            do not receive vulnerability scans.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  }
  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;

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
      cell: (finding) => finding.packageName,
      className: "whitespace-nowrap",
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
    <div className="grid min-w-0 gap-5">
      <VulnerabilitySeverityWidgets totals={query.data.summary} />
      <ResourceTable
        ariaLabel="Service vulnerability findings"
        columns={columns}
        getRowKey={(finding) => finding.id}
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
        emptyTitle="No advisories"
        emptyDescription="Findings from the latest scan of this App's production image appear here ranked by severity."
      />
      <div className="flex items-center justify-end gap-3">
        <span className="text-sm text-muted">Page {page}</span>
        <Button
          variant="secondary"
          isDisabled={page === 1}
          onPress={() => setPage(page - 1)}
        >
          <ScoutIcon name="previous" />
          Previous
        </Button>
        <Button
          variant="secondary"
          isDisabled={!query.data.nextPage}
          onPress={() => setPage(page + 1)}
        >
          <ScoutIcon name="next" />
          Next
        </Button>
      </div>
    </div>
  );
}
