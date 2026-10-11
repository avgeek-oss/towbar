"use client";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { displayTime } from "@/lib/date-time-display";
import { useAccess } from "./access-context";
import { DeploymentEnvironmentChip } from "./deployment-environment-chip";
import {
  Activity01Icon,
  Alert02Icon,
  AlertCircleIcon,
  DashboardCircleIcon,
  CubeIcon,
  FileViewIcon,
  GitBranchIcon,
  GitMergeIcon,
  InformationSquareIcon,
  ReloadIcon,
  Rocket01Icon,
  SecurityCheckIcon,
  ServerStack01Icon,
  BanIcon,
} from "@hugeicons/core-free-icons";

import { DeploymentDuration } from "./elapsed-time";
import { DeploymentProgress } from "./deployment-progress";

import { DomainLink } from "./domain-link";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";

import { HugeiconsIcon } from "@hugeicons/react";
import { useParams, useRouter } from "next/navigation";
import type {
  Deployment,
  DeploymentPullRequest,
  Source,
} from "@workspace/towbar-web-client";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import type { BreadcrumbAncestors } from "@avgeek-oss/design-system/patterns/pages/page";
import { CodePanel } from "@workspace/towbar-web-ui/code-panel";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";

import {
  ActionButton,
  appsBreadcrumb,
  DashboardPage,
  InlineLink,
  PageTabs,
  resourcesBreadcrumb,
} from "@/components/page-parts";
import { useDeploymentStream } from "@/hooks/use-deployment-stream";
import { useDetailNavigation } from "@/hooks/use-detail-navigation";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { deploymentDetailTarget, deploymentHref } from "@/lib/deployment-route";
import { formatDate } from "./dashboard-overview";
import {
  DeploymentTriggerChip,
  deploymentStatusTooltip,
} from "./deployment-table";
import { DeploymentVulnerabilities } from "./deployment-vulnerability-scan";
import { getDeploymentDisplayStatus } from "@/lib/deployment-status";

const terminal = new Set([
  "cancelled",
  "failed",
  "skipped",
  "succeeded",
  "succeeded_with_warnings",
]);
export function DeploymentDetail() {
  const { can } = useAccess();
  const { appId, deploymentId, resourceId } = useParams<{
    appId?: string;
    deploymentId: string;
    resourceId?: string;
  }>();
  const router = useRouter();
  const detail = useDetailNavigation();
  const stream = useDeploymentStream(deploymentId);
  const source = useApiQuery<{ source: Source }>(
    stream.deployment ? `/v1/core/sources/${stream.deployment.sourceId}` : null,
  );
  const revision = useApiQuery<{ pullRequest: DeploymentPullRequest | null }>(
    stream.deployment
      ? `/v1/core/deployments/${deploymentId}/source-revision`
      : null,
  );
  const detailTarget = stream.deployment
    ? deploymentDetailTarget(stream.deployment, { appId, resourceId })
    : null;
  const deployable = useApiQuery<{
    app?: { name: string; serverIp: string };
    resource?: { name: string; serverIp: string };
  }>(detailTarget?.queryPath ?? null);
  const routeDeployableKind = appId
    ? "app"
    : resourceId
      ? "resource"
      : undefined;
  const deploymentDeployableKind = detailTarget?.kind ?? routeDeployableKind;
  const deployableSection =
    deploymentDeployableKind === "resource" ? "datastores" : "services";
  const deployableBreadcrumb =
    deploymentDeployableKind === "resource"
      ? resourcesBreadcrumb
      : appsBreadcrumb;
  const deployableName =
    deployable.data?.app?.name ?? deployable.data?.resource?.name;
  const serverIp =
    deployable.data?.app?.serverIp ?? deployable.data?.resource?.serverIp;
  const breadcrumbAncestors = (
    stream.deployment && deployableName
      ? [
          ...deployableBreadcrumb,
          {
            href: `/${deployableSection}/${stream.deployment.appId}`,
            label: deployableName,
          },
          {
            href: `/${deployableSection}/${stream.deployment.appId}/deployments`,
            label: "Deployments",
          },
        ]
      : deployableBreadcrumb
  ) as BreadcrumbAncestors;
  if (stream.error && !stream.deployment)
    return (
      <DashboardPage
        icon={Rocket01Icon}
        breadcrumbAncestors={deployableBreadcrumb}
        title={deploymentId.slice(0, 8)}
      >
        <QueryError message={stream.error} />
      </DashboardPage>
    );
  if (!stream.deployment || !stream.steps || !stream.logs)
    return (
      <DashboardPage
        icon={Rocket01Icon}
        breadcrumbAncestors={deployableBreadcrumb}
        title={deploymentId.slice(0, 8)}
      >
        <QueryLoading variant="detail" />
      </DashboardPage>
    );

  const item = stream.deployment;
  const repository = source.data?.source;
  const commitUrl =
    repository?.repositoryOwner && repository.repositoryName && item.commitSha
      ? `https://github.com/${encodeURIComponent(repository.repositoryOwner)}/${encodeURIComponent(repository.repositoryName)}/commit/${encodeURIComponent(item.commitSha)}`
      : undefined;
  const displayStatus = getDeploymentDisplayStatus(item);
  if (!detailTarget?.belongsToRoute) {
    return (
      <DashboardPage
        icon={Rocket01Icon}
        breadcrumbAncestors={deployableBreadcrumb}
        title={deploymentId.slice(0, 8)}
      >
        <QueryError
          message={`This Deployment does not belong to the selected ${routeDeployableKind === "resource" ? "Datastore" : "Service"}.`}
          retryable={false}
        />
      </DashboardPage>
    );
  }
  const actions = !can("deployment.create") ? undefined : !terminal.has(
      item.state,
    ) ? (
    <ActionButton
      action={() =>
        api.post(`/v1/core/deployments/${deploymentId}/actions/cancel`)
      }
      confirm={{
        actionLabel: "Request cancellation",
        description:
          "The worker will stop at the next safe boundary. A release that has already been promoted will not be reverted.",
        title: "Cancel this deployment?",
      }}
      pendingLabel="Cancelling…"
      success="Cancellation requested"
      variant="danger"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={BanIcon}
        className="size-4 shrink-0"
      />
      Cancel
    </ActionButton>
  ) : item.environment === "production" &&
    (item.state === "failed" || item.state === "cancelled") ? (
    <ActionButton
      confirm={{
        title: "Retry this deployment?",
        description:
          "Queue another deployment attempt. A successful attempt may replace the running release.",
        actionLabel: "Retry deployment",
      }}
      action={() =>
        api.post<{ deployment: Deployment }>(
          `/v1/core/deployments/${deploymentId}/actions/retry`,
          undefined,
          { "Idempotency-Key": crypto.randomUUID() },
        )
      }
      onSuccess={(result) => router.push(deploymentHref(result.deployment))}
      pendingLabel="Queueing…"
      success="Retry queued"
      variant="primary"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={ReloadIcon}
        className="size-4 shrink-0"
      />
      Retry
    </ActionButton>
  ) : undefined;

  const progressSteps = stream.steps.filter(
    (step) => !terminal.has(step.state),
  );
  const sectionTitles: Record<string, string> = {
    logs: "Logs",
    overview: "Overview",
    progress: "Progress",
    vulnerabilities: "Vulnerabilities",
  };
  const activeSectionTitle =
    (detail.section && sectionTitles[detail.section]) ??
    (terminal.has(item.state) ? "Overview" : "Progress");
  const criticalVulnerabilities =
    (item.vulnerabilityScan?.severityTotals.critical ?? 0) +
    (item.vulnerabilityScan?.severityTotals.high ?? 0);

  return (
    <DashboardPage
      icon={Rocket01Icon}
      actions={actions}
      badge={
        (detail.section ??
          (terminal.has(item.state) ? "overview" : "progress")) ===
        "overview" ? (
          <StatusBadge
            status={displayStatus}
            tooltip={deploymentStatusTooltip(item)}
          />
        ) : undefined
      }
      breadcrumbAncestors={breadcrumbAncestors}
      breadcrumbLabel={activeSectionTitle}
      title={item.id.slice(0, 8)}
    >
      {item.errorMessage ? (
        <Widget className="min-w-0" role="alert">
          <Widget.Header>
            <Widget.Title
              help={false}
              icon={
                <HugeiconsIcon
                  icon={
                    item.state === "succeeded_with_warnings"
                      ? Alert02Icon
                      : item.state === "skipped"
                        ? InformationSquareIcon
                        : item.state === "cancelled"
                          ? BanIcon
                          : AlertCircleIcon
                  }
                />
              }
              className={
                item.state === "succeeded_with_warnings"
                  ? "text-warning-soft-foreground"
                  : item.state === "skipped" || item.state === "cancelled"
                    ? "text-muted"
                    : "text-danger-soft-foreground"
              }
            >
              {item.state === "succeeded_with_warnings"
                ? "Deployment warning"
                : item.state === "skipped"
                  ? "Deployment superseded"
                  : item.state === "cancelled"
                    ? "Deployment cancelled"
                    : "Deployment failed"}
            </Widget.Title>
          </Widget.Header>
          <Widget.Content>
            <p className="text-sm break-words text-foreground">
              {item.errorMessage}
            </p>
          </Widget.Content>
          {item.errorCode ||
          (stream.logs.length > 0 && activeSectionTitle !== "Logs") ? (
            <Widget.Footer>
              {item.errorCode ? (
                <Widget.FooterDescription>
                  <span className="font-medium">Error code:</span>{" "}
                  <code className="break-all">{item.errorCode}</code>
                </Widget.FooterDescription>
              ) : null}
              {stream.logs.length > 0 && activeSectionTitle !== "Logs" ? (
                <InlineLink
                  href={deploymentHref(item, "logs")}
                  className="group/log-link shrink-0 rounded-sm text-xs opacity-75"
                >
                  <span className="text-muted underline decoration-dashed decoration-muted/20 underline-offset-2 group-hover/log-link:decoration-muted group-focus-visible/log-link:decoration-muted">
                    View logs
                  </span>
                </InlineLink>
              ) : null}
            </Widget.Footer>
          ) : null}
        </Widget>
      ) : stream.connection === "reconnecting" ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Live updates interrupted</Alert.Title>
            <Alert.Description>
              Towbar is reconnecting automatically. The deployment continues on
              the worker.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <PageTabs
        canonicalizeDefault={false}
        defaultValue={terminal.has(item.state) ? "overview" : "progress"}
        tabs={[
          {
            value: "overview",
            label: "Overview",
            icon: <HugeiconsIcon icon={InformationSquareIcon} />,
            content: (
              <div className="content-grid">
                <div className="content-grid lg:grid-cols-2">
                  <Attributes columns={2} title="Deployment" variant="card">
                    <Attributes.Item label="Status">
                      <StatusBadge
                        status={displayStatus}
                        tooltip={deploymentStatusTooltip(item)}
                      />
                    </Attributes.Item>
                    <Attributes.Item label="Action">
                      {item.kind === "rollback" ? "Rollback" : "Deploy"}
                    </Attributes.Item>
                    <Attributes.Item label="Environment">
                      <DeploymentEnvironmentChip deployment={item} />
                    </Attributes.Item>
                    <Attributes.Item label="Trigger">
                      <DeploymentTriggerChip trigger={item.trigger} />
                    </Attributes.Item>
                    <Attributes.Item label="Requested">
                      {formatDate(item.createdAt)}
                    </Attributes.Item>
                    <Attributes.Item label="Started">
                      {item.startedAt ? formatDate(item.startedAt) : "Waiting"}
                    </Attributes.Item>
                    <Attributes.Item label="Duration">
                      <DeploymentDuration deployment={item} />
                    </Attributes.Item>
                    <Attributes.Item label="Finished">
                      {item.finishedAt
                        ? formatDate(item.finishedAt)
                        : "Not finished"}
                    </Attributes.Item>
                  </Attributes>
                  <Attributes columns={2} title="Target" variant="card">
                    <Attributes.Item
                      icon={
                        <HugeiconsIcon
                          icon={
                            item.deployableKind === "app" ||
                            item.deployableKind === "compose"
                              ? DashboardCircleIcon
                              : CubeIcon
                          }
                        />
                      }
                      label={
                        item.deployableKind === "app" ||
                        item.deployableKind === "compose"
                          ? "Service"
                          : "Datastore"
                      }
                    >
                      <InlineLink
                        href={
                          item.deployableKind === "app" ||
                          item.deployableKind === "compose"
                            ? `/services/${item.appId}`
                            : `/datastores/${item.appId}`
                        }
                      >
                        {deployableName ?? (
                          <TypographyCode>{item.appId}</TypographyCode>
                        )}
                      </InlineLink>
                    </Attributes.Item>
                    <Attributes.Item
                      icon={<HugeiconsIcon icon={ServerStack01Icon} />}
                      label="Server"
                    >
                      <InlineLink href={`/servers/${item.serverId}`}>
                        {serverIp ?? (
                          <TypographyCode>{item.serverId}</TypographyCode>
                        )}
                      </InlineLink>
                    </Attributes.Item>
                    <Attributes.Item label="Commit">
                      {commitUrl ? (
                        <InlineExternalLink
                          href={commitUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`View commit ${item.commitSha} on GitHub (opens in a new tab)`}
                        >
                          <TypographyCode title={item.commitSha}>
                            {item.commitSha.slice(0, 12)}
                          </TypographyCode>
                        </InlineExternalLink>
                      ) : (
                        <TypographyCode title={item.commitSha}>
                          {item.commitSha.slice(0, 12)}
                        </TypographyCode>
                      )}
                    </Attributes.Item>
                    {item.gitRef ? (
                      <Attributes.Item label="Git ref">
                        <TypographyCode>{item.gitRef}</TypographyCode>
                      </Attributes.Item>
                    ) : null}
                    {item.hostname ? (
                      <Attributes.Item label="URL">
                        <DomainLink domain={item.hostname}>
                          {item.hostname}
                        </DomainLink>
                      </Attributes.Item>
                    ) : null}
                    <Attributes.Item label="Manifest digest">
                      <TypographyCode title={item.manifestDigest}>
                        {item.manifestDigest.slice(0, 12)}
                      </TypographyCode>
                    </Attributes.Item>
                    <Attributes.Item label="Image digest">
                      {item.imageDigest ? (
                        <TypographyCode title={item.imageDigest}>
                          {item.imageDigest.slice(7, 19)}
                        </TypographyCode>
                      ) : (
                        "Not recorded"
                      )}
                    </Attributes.Item>
                    <Attributes.Item label="Image platform">
                      {item.imagePlatform ?? "Not recorded"}
                    </Attributes.Item>
                    <Attributes.Item label="Repository inputs">
                      {item.sourceInputDigest ? (
                        <TypographyCode title={item.sourceInputDigest}>
                          {item.sourceInputDigest.slice(0, 12)}
                        </TypographyCode>
                      ) : (
                        "Commit-sensitive"
                      )}
                    </Attributes.Item>
                    <Attributes.Item label="Deployment ID">
                      <TypographyCode title={item.id}>
                        {item.id.slice(0, 8)}
                      </TypographyCode>
                    </Attributes.Item>
                  </Attributes>
                </div>
                {revision.data?.pullRequest ? (
                  <Attributes columns={3} title="Pull request" variant="card">
                    <Attributes.Item label="Pull request">
                      <InlineExternalLink
                        aria-label={`Open pull request ${revision.data.pullRequest.number} on GitHub (opens in a new tab)`}
                        href={revision.data.pullRequest.url}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        PR #{revision.data.pullRequest.number}
                      </InlineExternalLink>
                    </Attributes.Item>
                    <Attributes.Item label="Title">
                      {revision.data.pullRequest.title}
                    </Attributes.Item>
                    <Attributes.Item label="Status">
                      <TooltipText
                        className="inline-flex"
                        tooltip={pullRequestStateTooltip(
                          revision.data.pullRequest,
                        )}
                      >
                        <Chip
                          size="sm"
                          color={
                            revision.data.pullRequest.merged
                              ? "accent"
                              : revision.data.pullRequest.state === "open" &&
                                  !revision.data.pullRequest.draft
                                ? "success"
                                : "default"
                          }
                        >
                          <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                            {revision.data.pullRequest.merged ? (
                              <HugeiconsIcon icon={GitMergeIcon} />
                            ) : undefined}
                            {revision.data.pullRequest.merged
                              ? "Merged"
                              : revision.data.pullRequest.draft
                                ? "Draft"
                                : revision.data.pullRequest.state === "open"
                                  ? "Open"
                                  : "Closed"}
                          </Chip.Label>
                        </Chip>
                      </TooltipText>
                    </Attributes.Item>
                    <Attributes.Item
                      icon={<HugeiconsIcon icon={GitBranchIcon} />}
                      label="Branches"
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <TypographyCode className="truncate">
                          {revision.data.pullRequest.headBranch}
                        </TypographyCode>
                        <span aria-hidden="true" className="text-muted">
                          →
                        </span>
                        <TypographyCode className="truncate">
                          {revision.data.pullRequest.baseBranch}
                        </TypographyCode>
                      </span>
                    </Attributes.Item>
                    <Attributes.Item label="Author">
                      {revision.data.pullRequest.author
                        ? `@${revision.data.pullRequest.author}`
                        : "Unknown"}
                    </Attributes.Item>
                    <Attributes.Item label="Changes">
                      {revision.data.pullRequest.changedFileCount}{" "}
                      {revision.data.pullRequest.changedFileCount === 1
                        ? "file"
                        : "files"}
                    </Attributes.Item>
                  </Attributes>
                ) : null}
              </div>
            ),
          },
          {
            value: "progress",
            label: "Progress",
            icon: <HugeiconsIcon icon={Activity01Icon} />,
            content: (
              <div className="content-grid min-w-0">
                {terminal.has(item.state) && progressSteps.length < 2 ? (
                  <Widget>
                    <Widget.Header>
                      <Widget.Title help={false}>
                        Limited Progress History
                      </Widget.Title>
                    </Widget.Header>
                    <Widget.Content>
                      <p className="text-sm text-foreground">
                        This deployment completed without recording its full
                        execution timeline. The final status and available logs
                        remain authoritative.
                      </p>
                    </Widget.Content>
                  </Widget>
                ) : null}
                <Widget className="min-w-0">
                  <Widget.Content className="p-2">
                    <DeploymentProgress
                      deployment={item}
                      steps={progressSteps}
                      hasLogs={stream.logs.length > 0}
                    />
                  </Widget.Content>
                </Widget>
              </div>
            ),
          },
          {
            value: "logs",
            label: "Logs",
            icon: <HugeiconsIcon icon={FileViewIcon} />,
            content: stream.logs.length ? (
              <CodePanel ariaLabel="Deployment logs" language="text">
                {stream.logs
                  .map(
                    (log) =>
                      `${formatTime(log.createdAt)} ${log.stream === "stderr" ? "ERR" : "OUT"} ${log.content}`,
                  )
                  .join("\n")}
              </CodePanel>
            ) : (
              <EmptyState>
                <EmptyState.Header>
                  <EmptyState.Title>
                    {terminal.has(item.state)
                      ? "No deployment output"
                      : "Waiting for deployment output"}
                  </EmptyState.Title>
                  <EmptyState.Description>
                    {terminal.has(item.state)
                      ? "The worker completed without producing any log output."
                      : "Worker output will appear here as the deployment progresses."}
                  </EmptyState.Description>
                </EmptyState.Header>
              </EmptyState>
            ),
          },
          ...(item.vulnerabilityScanningEnabled || item.vulnerabilityScan
            ? [
                {
                  value: "vulnerabilities",
                  label: "Vulnerabilities",
                  icon: (
                    <HugeiconsIcon
                      icon={SecurityCheckIcon}
                      className="size-4"
                    />
                  ),
                  indicator: criticalVulnerabilities
                    ? {
                        label: String(criticalVulnerabilities),
                        ariaLabel: `${criticalVulnerabilities} critical or high vulnerabilit${criticalVulnerabilities === 1 ? "y" : "ies"}`,
                      }
                    : undefined,
                  content: <DeploymentVulnerabilities deployment={item} />,
                },
              ]
            : []),
        ]}
      />
    </DashboardPage>
  );
}

function formatTime(value: string) {
  return displayTime(value);
}

function pullRequestStateTooltip(pullRequest: DeploymentPullRequest) {
  if (pullRequest.merged)
    return `Merged from ${pullRequest.headBranch} into ${pullRequest.baseBranch}.`;
  if (pullRequest.draft)
    return `Draft pull request from ${pullRequest.headBranch} into ${pullRequest.baseBranch}.`;
  if (pullRequest.state === "open")
    return `Open pull request from ${pullRequest.headBranch} into ${pullRequest.baseBranch}.`;
  return `Closed without merging into ${pullRequest.baseBranch}.`;
}
