"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, ReloadIcon } from "@hugeicons/core-free-icons";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";

import type { PreviewEnvironment } from "@workspace/towbar-web-client";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
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
import { DomainLink } from "./domain-link";

export function PreviewEnvironments({
  previews,
  error,
}: {
  previews?: PreviewEnvironment[];
  error?: string;
}) {
  if (error) return <QueryError message={error} />;
  if (!previews) return <QueryLoading variant="list" />;

  const columns: ResourceTableColumn<PreviewEnvironment>[] = [
    {
      key: "pull-request",
      header: "Pull request",
      className: "min-w-32",
      cell: (preview) => (
        <InlineExternalLink href={preview.pullRequestUrl}>
          PR #{preview.pullRequestNumber}
        </InlineExternalLink>
      ),
    },
    {
      key: "status",
      header: "Status",
      className: "min-w-32 whitespace-nowrap",
      cell: (preview) => (
        <StatusBadge
          status={preview.status}
          tooltip={previewCleanupTooltip(preview)}
        />
      ),
    },
    {
      key: "url",
      header: "URL",
      className: "w-56 max-w-56",
      cell: (preview) => (
        <DomainLink className="max-w-56" domain={preview.hostname}>
          {compactPreviewHostname(preview.hostname)}
        </DomainLink>
      ),
    },
    {
      key: "branch",
      header: "Branch",
      className: "w-48 max-w-48",
      cell: (preview) => (
        <TooltipText
          className="block max-w-48 truncate"
          tooltip={preview.branch}
        >
          <TypographyCode className="block truncate rounded-none bg-transparent p-0 text-xs/4">
            {preview.branch}
          </TypographyCode>
        </TooltipText>
      ),
    },
    {
      key: "deployment",
      header: "Deployment",
      className: "min-w-36 whitespace-nowrap",
      cell: (preview) =>
        preview.latestDeploymentId ? (
          <InlineLink
            href={deploymentHref({
              appId: preview.appId,
              deployableKind: "app",
              id: preview.latestDeploymentId,
            })}
            title={preview.latestDeploymentId}
          >
            <TypographyCode>
              {preview.latestDeploymentId.slice(0, 8)}
            </TypographyCode>
          </InlineLink>
        ) : (
          <span className="text-muted">—</span>
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
      key: "commit",
      header: "Commit",
      className: "whitespace-nowrap",
      cell: (preview) => (
        <TypographyCode title={preview.latestCommitSha}>
          {preview.latestCommitSha.slice(0, 12)}
        </TypographyCode>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      className: "whitespace-nowrap",
      cell: (preview) => (
        <div className="flex items-center gap-2">
          {preview.status === "cleanup_failed" ? (
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
              Retry
            </ActionButton>
          ) : (
            <ActionButton
              action={() =>
                api.post(`/v1/core/previews/${preview.id}/actions/delete`)
              }
              confirm={{
                actionLabel: "Delete Preview",
                description:
                  "Towbar will remove this pull request's container, image, route, and DNS record. A later commit can create it again while the pull request remains open and Preview is enabled.",
                title: `Delete Preview for PR #${preview.pullRequestNumber}?`,
              }}
              isDisabled={preview.status === "deleting"}
              pendingLabel="Queueing…"
              success="Preview cleanup queued"
              variant="danger"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={Delete02Icon}
                className="shrink-0"
              />
              Delete
            </ActionButton>
          )}
        </div>
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
      tableClassName="min-w-[1040px]"
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

function compactPreviewHostname(hostname: string) {
  const [label, ...suffix] = hostname.split(".");
  if (!label || label.length <= 18 || suffix.length === 0) return hostname;
  return `${label.slice(0, 15)}…${suffix.length ? `.${suffix.join(".")}` : ""}`;
}
