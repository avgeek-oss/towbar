"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, ReloadIcon } from "@hugeicons/core-free-icons";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";

import type { PreviewEnvironment } from "@workspace/towbar-web-client";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";

import { ActionButton, InlineLink } from "@/components/page-parts";
import { api } from "@/lib/api";
import { deploymentHref } from "@/lib/deployment-route";
import { RelativeTime } from "./last-synced-time";
import { formatDate } from "./dashboard-overview";
import { DeploymentRetryButton } from "./deployment-retry-button";
import { useAccess } from "./access-context";

export function PreviewEnvironments({
  previews,
  error,
}: {
  previews?: PreviewEnvironment[];
  error?: string;
}) {
  const { can } = useAccess();
  if (error) return <QueryError message={error} />;
  if (!previews) return <QueryLoading variant="list" />;

  const columns: ResourceTableColumn<PreviewEnvironment>[] = [
    {
      key: "pull-request",
      header: "Pull request",
      className: "min-w-32",
      cell: (preview) => (
        <div className="grid min-w-0 gap-1">
          <InlineExternalLink href={preview.pullRequestUrl}>
            PR #{preview.pullRequestNumber}
          </InlineExternalLink>
          <TooltipText
            className="block max-w-72 truncate text-xs font-normal text-muted"
            tooltip={preview.branch}
          >
            {preview.branch}
          </TooltipText>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      className: "min-w-32 whitespace-nowrap",
      cell: (preview) => {
        const badge = (
          <StatusBadge
            status={preview.status}
            tooltip={previewCleanupTooltip(preview)}
          />
        );
        return preview.latestDeploymentId ? (
          <InlineLink
            aria-label={`Open deployment for PR #${preview.pullRequestNumber}`}
            href={deploymentHref({
              appId: preview.appId,
              deployableKind: "app",
              id: preview.latestDeploymentId,
            })}
          >
            {badge}
          </InlineLink>
        ) : (
          badge
        );
      },
    },
    {
      key: "updated",
      header: "Last updated",
      className: "min-w-48 whitespace-nowrap",
      cell: (preview) => (
        <RelativeTime label="Last updated" value={preview.updatedAt} />
      ),
    },
    {
      key: "expires",
      header: "Expires",
      className: "min-w-48 whitespace-nowrap",
      cell: (preview) => (
        <RelativeTime label="Expires" value={preview.expiresAt} />
      ),
    },
    {
      key: "actions",
      header: "Actions",
      className: "whitespace-nowrap",
      cell: (preview) =>
        can("admin") || preview.status === "healthy" ? (
          <div className="flex items-center gap-2">
            {preview.status === "failed" && preview.latestDeploymentId ? (
              <DeploymentRetryButton
                deploymentId={preview.latestDeploymentId}
                preview
              />
            ) : null}
            {preview.status === "healthy" ? (
              <InlineExternalLink href={`https://${preview.hostname}`}>
                Open Preview
              </InlineExternalLink>
            ) : null}
            {!can("admin") ? null : preview.status === "cleanup_failed" ? (
              <ActionButton
                ariaLabel={`Retry cleanup for PR #${preview.pullRequestNumber}`}
                confirm={{
                  title: "Retry Preview cleanup?",
                  description:
                    "Retry removing this Preview\u2019s container, image, route, and DNS record.",
                  actionLabel: "Retry cleanup",
                }}
                action={() =>
                  api.post(`/v1/core/previews/${preview.id}/actions/delete`)
                }
                pendingLabel="Queueing…"
                success="Preview cleanup retry queued"
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={ReloadIcon}
                  className="shrink-0"
                />
                Retry cleanup
              </ActionButton>
            ) : (
              <ActionButton
                action={() =>
                  api.post(`/v1/core/previews/${preview.id}/actions/delete`)
                }
                confirm={{
                  actionLabel: "Remove Preview",
                  description:
                    "Towbar will remove this pull request's container, image, route, and DNS record. Deployment history is kept. A later commit can create it again while the pull request remains open and Preview is enabled.",
                  title: `Remove Preview for PR #${preview.pullRequestNumber}?`,
                  variant: "danger",
                }}
                isDisabled={preview.status === "deleting"}
                pendingLabel="Queueing…"
                success="Preview cleanup queued"
                variant="danger-soft"
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={Delete02Icon}
                  className="shrink-0"
                />
                Remove Preview
              </ActionButton>
            )}
          </div>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ];

  return (
    <ResourceTable
      ariaLabel="Preview deployments"
      columns={columns}
      emptyDescription="Enable Preview for a service, then open a same-repository pull request targeting the Repository branch."
      emptyTitle="No Preview deployments"
      getRowKey={(preview) => preview.id}
      items={previews}
      tableClassName="min-w-[760px]"
    />
  );
}

function previewCleanupTooltip(preview: PreviewEnvironment) {
  if (
    preview.status !== "cleanup_failed" ||
    (!preview.errorMessage && !preview.nextCleanupAttemptAt)
  ) {
    return undefined;
  }

  return (
    <span className="grid gap-1">
      <span>
        {preview.errorMessage ??
          "Cleanup stopped before every item could be removed."}
      </span>
      {preview.nextCleanupAttemptAt ? (
        <span>Retry scheduled {formatDate(preview.nextCleanupAttemptAt)}</span>
      ) : null}
    </span>
  );
}
