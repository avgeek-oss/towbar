"use client";
import { useAccess } from "./access-context";
import { DeploymentRetryButton } from "./deployment-retry-button";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { displayDateTime } from "@/lib/date-time-display";

import {
  GitBranchIcon,
  PlayIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Deployment } from "@workspace/towbar-web-client";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { useUrlTablePagination as useTablePagination } from "@/hooks/use-url-pagination";
import { Pagination } from "@avgeek-oss/design-system/navigation/pagination";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";

import { DeploymentDuration } from "./elapsed-time";
import { RelativeTime } from "./last-synced-time";
import { getDeploymentDisplayStatus } from "@/lib/deployment-status";
import { deploymentHref } from "@/lib/deployment-route";

const DEPLOYMENT_PAGE_SIZE = 10;

export function DeploymentTable({
  deployments,
  deployableName,
  emptyDescription,
}: {
  deployments: Deployment[];
  deployableName: string;
  emptyDescription: string;
}) {
  const { can } = useAccess();
  const orderedDeployments = [...deployments].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const pagination = useTablePagination({
    pageSize: DEPLOYMENT_PAGE_SIZE,
    total: orderedDeployments.length,
  });
  const visibleDeployments = orderedDeployments.slice(
    pagination.offset,
    pagination.offset + pagination.pageSize,
  );
  const columns: ResourceTableColumn<Deployment>[] = [
    {
      key: "id",
      header: "Deployment ID",
      cell: (deployment) => (
        <TypographyCode title={deployment.id}>
          {deployment.id.slice(0, 8)}
        </TypographyCode>
      ),
      className: "min-w-32",
    },
    {
      key: "status",
      header: "Status",
      cell: (deployment) => (
        <StatusBadge
          status={getDeploymentDisplayStatus(deployment)}
          tooltip={deploymentStatusTooltip(deployment)}
        />
      ),
      className: "whitespace-nowrap",
    },
    {
      key: "trigger",
      header: "Trigger",
      cell: (deployment) => (
        <DeploymentTriggerChip trigger={deployment.trigger} />
      ),
      className: "whitespace-nowrap",
    },
    {
      key: "requested",
      header: "Requested",
      cell: (deployment) => (
        <RelativeTime label="Requested" value={deployment.createdAt} />
      ),
      className: "whitespace-nowrap",
    },
    {
      key: "duration",
      header: "Duration",
      cell: (deployment) => <DeploymentDuration deployment={deployment} />,
    },
    {
      key: "commit",
      header: "Commit",
      cell: (deployment) => (
        <TypographyCode title={deployment.commitSha}>
          {deployment.commitSha.slice(0, 12)}
        </TypographyCode>
      ),
      className: "min-w-40",
    },
    ...(can("admin") &&
    deployments.some(
      (item) => item.state === "failed" || item.state === "cancelled",
    )
      ? [
          {
            key: "actions",
            header: "Actions",
            className: "whitespace-nowrap",
            cell: (deployment: Deployment) =>
              deployment.state === "failed" ||
              deployment.state === "cancelled" ? (
                <DeploymentRetryButton
                  deploymentId={deployment.id}
                  preview={deployment.environment === "preview"}
                />
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <div className="grid gap-4">
      <ResourceTable
        ariaLabel={`${deployableName} deployments`}
        columns={columns}
        emptyDescription={emptyDescription}
        emptyTitle="No deployments yet"
        getRowHref={deploymentHref}
        getRowKey={(deployment) => deployment.id}
        items={visibleDeployments}
      />
      {orderedDeployments.length > pagination.pageSize ? (
        <Pagination
          aria-label={`${deployableName} deployment pages`}
          page={pagination.page}
          size="sm"
          totalPages={pagination.totalPages ?? 1}
          onPageChange={pagination.setPage}
        />
      ) : null}
    </div>
  );
}

export function deploymentStatusTooltip(deployment: Deployment) {
  const status = getDeploymentDisplayStatus(deployment).split("_").join(" ");
  return (
    <div className="grid gap-0.5 text-left">
      <span>{`${status.charAt(0).toUpperCase()}${status.slice(1)}.`}</span>
      <span className="whitespace-nowrap">
        Requested {formatTooltipDate(deployment.createdAt)}.
      </span>
      {deployment.finishedAt ? (
        <span className="whitespace-nowrap">
          Finished {formatTooltipDate(deployment.finishedAt)}.
        </span>
      ) : null}
    </div>
  );
}

function formatTooltipDate(value: string) {
  return displayDateTime(value);
}

export function formatDeploymentTrigger(trigger: Deployment["trigger"]) {
  if (trigger === "auto_deploy") return "Auto-deploy";
  if (trigger === "rollback") return "Rollback";
  return "Manual";
}

export function DeploymentTriggerChip({
  trigger,
}: {
  trigger: Deployment["trigger"];
}) {
  return (
    <TooltipText
      className="inline-flex"
      tooltip={
        trigger === "auto_deploy"
          ? "Queued automatically after a repository change."
          : trigger === "rollback"
            ? "Restores a previously deployed revision."
            : "Queued manually by a user or API client."
      }
    >
      <Chip
        size="sm"
        color={
          trigger === "auto_deploy"
            ? "success"
            : trigger === "manual"
              ? "warning"
              : "default"
        }
      >
        <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
          {
            <HugeiconsIcon
              aria-hidden="true"
              icon={
                trigger === "auto_deploy"
                  ? GitBranchIcon
                  : trigger === "rollback"
                    ? RefreshIcon
                    : PlayIcon
              }
            />
          }
          {formatDeploymentTrigger(trigger)}
        </Chip.Label>
      </Chip>
    </TooltipText>
  );
}
