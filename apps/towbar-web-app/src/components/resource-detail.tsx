"use client";
import { resolveInventoryStatus } from "@/lib/inventory-status";
import { SourceEnvironmentManifest } from "./source-environment-manifest";
import { ContainerRuntimeDetails } from "./container-runtime-details";
import { useAccess } from "./access-context";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { useDetailNavigation } from "@/hooks/use-detail-navigation";
import { DeployableVulnerabilities } from "./deployable-vulnerabilities";
import { InstanceEnvironmentChoice } from "./instance-environment-choice";
import {
  ScoutAlertRules,
  ScoutCompareDeployments,
  ScoutIncidents,
  ScoutPerformance,
} from "./scout-panel";

import {
  SquareActivityIcon,
  Alert02Icon,
  AlertCircleIcon,
  SecurityCheckIcon,
  CubeIcon,
  FileViewIcon,
  GitBranchIcon,
  GitCompareIcon,
  ReloadIcon,
  Rocket01Icon,
  ServerStack01Icon,
  Settings01Icon,
  SourceCodeIcon,
  Key01Icon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import type {
  Deployment,
  Release,
  Resource,
  RuntimeState,
  Source,
} from "@workspace/towbar-web-client";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { getDeploymentDisplayStatus } from "@/lib/deployment-status";
import { deploymentHref } from "@/lib/deployment-route";

import {
  ActionButton,
  DashboardPage,
  InlineLink,
  PageTabs,
  resourcesBreadcrumb,
} from "@/components/page-parts";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { formatDate } from "./dashboard-overview";
import {
  DeploymentTable,
  deploymentStatusTooltip,
  formatDeploymentTrigger,
} from "./deployment-table";
import { ResourceBackupConfiguration } from "./resource-backup-configuration";
import { ResourceRestoreConfiguration } from "./resource-restore-configuration";
import { ResponsiveSubtabs } from "./responsive-subtabs";
import { ResourceSecrets } from "./app-secrets";
import { DeployableActionsMenu, RuntimeLogs } from "./runtime-operations";
import { AutoDeployControlEditor } from "./auto-deploy-control";
import { DomainLink } from "./domain-link";
import { DeployableReadiness } from "./deployable-readiness";
import { ResourceLogo } from "./deployable-identity";
import { resourceImageBrand } from "./resource-image-brand";
import { FirstDeployment } from "./first-deployment";
import { EnvironmentChip } from "./environment-chip";
import { CloudProviderLogo } from "./cloud-provider-logo";
import { DeployableNotifications } from "./deployable-notifications";

type ResourceRecord = Resource & {
  serverId: string;
  serverSsh: {
    port: number;
    username: string;
  };
};

function tunnelStatusTooltip(runtime: RuntimeState) {
  const details = [
    runtime.ingressContainerName
      ? `Runtime ${runtime.ingressContainerName}.`
      : null,
    runtime.ingressImage ? `Image ${runtime.ingressImage}.` : null,
    runtime.ingressRestartCount !== null
      ? `${runtime.ingressRestartCount} restart${runtime.ingressRestartCount === 1 ? "" : "s"} observed.`
      : null,
  ].filter(Boolean);
  return details.length
    ? details.join(" ")
    : "Run a server check to inspect the managed Cloudflare Tunnel runtime.";
}

export function ResourceDetail() {
  const detailNavigation = useDetailNavigation();
  const resourceId = usePathname().split("/")[2]!;
  const router = useRouter();
  const { can } = useAccess();
  const resource = useApiQuery<{
    resource: ResourceRecord;
  }>(`/v1/core/resources/${resourceId}`);
  const source = useApiQuery<{ source: Source }>(
    resource.data?.resource.sourceId
      ? `/v1/core/sources/${resource.data.resource.sourceId}`
      : null,
  );
  const deployments = useApiQuery<{ deployments: Deployment[] }>(
    `/v1/core/resources/${resourceId}/deployments`,
    5_000,
  );
  const releases = useApiQuery<{ releases: Release[] }>(
    `/v1/core/resources/${resourceId}/releases`,
  );
  const assurances = useApiQuery<{
    awsConfigured: boolean;
    canRestore: boolean;
    gcpConfigured?: boolean;
    missingCredentialMessage?: string;
  }>(
    resource.data?.resource && resource.data.resource.config.backup
      ? `/v1/core/resources/${resourceId}/backup-assurance`
      : null,
    10_000,
  );
  const error =
    resource.error ?? deployments.error ?? releases.error ?? source.error;

  if (error) {
    return (
      <DashboardPage
        icon={CubeIcon}
        breadcrumbAncestors={resourcesBreadcrumb}
        title="Datastore"
      >
        <QueryError message={error} />
      </DashboardPage>
    );
  }
  if (!resource.data || !deployments.data || !releases.data || !source.data) {
    return <QueryLoading variant="detail" />;
  }

  const item = resource.data.resource;
  const usesCloudflareTunnel =
    item.config.ingress?.type === "cloudflare-tunnel";
  const previous = releases.data.releases.find(
    (release) => release.status === "previous",
  );
  const orderedDeployments = [...deployments.data.deployments].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const latestDeployment = orderedDeployments[0];
  const lifecycleStatus = getResourceLifecycleStatus(item);
  const backup = item.config.backup;
  const assuranceData = assurances.data;
  const missingBackupCredentials = Boolean(
    backup &&
    assuranceData &&
    ((backup.s3 && !assuranceData.awsConfigured) ||
      (backup.gcs && !assuranceData.gcpConfigured) ||
      false),
  );
  const restoreProvider =
    backup?.restoreFrom ?? (backup?.s3 ? "s3" : backup?.gcs ? "gcs" : "s3");
  const missingRestoreCredentials = Boolean(
    backup &&
    assuranceData &&
    ((restoreProvider === "s3" && !assuranceData.awsConfigured) ||
      (restoreProvider === "gcs" && !assuranceData.gcpConfigured)),
  );
  const tabs = [
    {
      value: "overview",
      label: "Overview",
      icon: <HugeiconsIcon icon={CubeIcon} />,
      content: (
        <div
          className={
            latestDeployment ? "content-grid lg:grid-cols-2" : "content-grid"
          }
        >
          {!latestDeployment && item.serverReady ? (
            <FirstDeployment
              canDeploy={can("deployment.create")}
              deployableId={resourceId}
              type="resource"
            />
          ) : null}
          <Attributes columns={2} title="Current state" variant="card">
            <Attributes.Item label="Lifecycle">
              <StatusBadge
                status={lifecycleStatus}
                label={item.serverReady ? undefined : "Setup pending"}
              />
            </Attributes.Item>
            <Attributes.Item label="Type">
              {formatResourceKind(item.kind)}
            </Attributes.Item>
            <Attributes.Item label="Health">
              {item.serverReady ? (
                <StatusBadge
                  status={resolveInventoryStatus({
                    archived: Boolean(item.archivedAt),
                    healthStatus: item.runtimeState.healthStatus,
                    hasDeployment: Boolean(latestDeployment),
                    serverReady: item.serverReady,
                  })}
                />
              ) : (
                <StatusBadge status="not_checked" />
              )}
            </Attributes.Item>
            <Attributes.Item label="Runtime">
              <StatusBadge
                context="runtime"
                status={item.runtimeState.observedState}
              />
            </Attributes.Item>
            <Attributes.Item label="Configuration">
              <StatusBadge status={item.runtimeState.driftStatus} />
            </Attributes.Item>
            {usesCloudflareTunnel ? (
              <Attributes.Item label="Cloudflare Tunnel">
                <StatusBadge
                  status={item.runtimeState.ingressStatus}
                  tooltip={tunnelStatusTooltip(item.runtimeState)}
                />
              </Attributes.Item>
            ) : null}
            <Attributes.Item label="Environment">
              {item.environment ? (
                <EnvironmentChip name={item.environment.name} />
              ) : (
                "Unmapped"
              )}
            </Attributes.Item>
            <Attributes.Item
              icon={<HugeiconsIcon icon={ServerStack01Icon} />}
              label="Server"
            >
              {item.serverIp}
            </Attributes.Item>
            <Attributes.Item label="Last checked">
              {item.runtimeState.checkedAt
                ? formatDate(item.runtimeState.checkedAt)
                : "Not checked yet"}
            </Attributes.Item>
            <Attributes.Item
              icon={<IntegrationProviderLogo provider="github" />}
              label="Repository"
            >
              <InlineLink href={`/repositories/${item.sourceId}`}>
                {source.data.source.repositoryName}
              </InlineLink>
            </Attributes.Item>
            <Attributes.Item
              icon={<HugeiconsIcon icon={GitBranchIcon} />}
              label="Branch"
            >
              <span className="break-words font-mono">
                {item.config.sourceBranch ?? "main"}
              </span>
            </Attributes.Item>
          </Attributes>
          {latestDeployment ? (
            <Attributes
              columns={2}
              title="Last deployment attempt"
              variant="card"
            >
              <Attributes.Item label="Status">
                <StatusBadge
                  status={getDeploymentDisplayStatus(latestDeployment)}
                  tooltip={deploymentStatusTooltip(latestDeployment)}
                />
              </Attributes.Item>
              <Attributes.Item label="Commit">
                <TypographyCode title={latestDeployment.commitSha}>
                  {latestDeployment.commitSha.slice(0, 12)}
                </TypographyCode>
              </Attributes.Item>
              <Attributes.Item label="Requested">
                {formatDate(latestDeployment.createdAt)}
              </Attributes.Item>
              <Attributes.Item label="Trigger">
                {formatDeploymentTrigger(latestDeployment.trigger)}
              </Attributes.Item>
            </Attributes>
          ) : null}
        </div>
      ),
    },
    {
      value: "logs",
      label: "Runtime Logs",
      group: "Monitor",
      icon: <HugeiconsIcon icon={FileViewIcon} />,
      content: (
        <RuntimeLogs
          active={!item.archivedAt && item.serverReady}
          deployableId={resourceId}
          hasIngress={usesCloudflareTunnel}
          type="resource"
        />
      ),
    },
    {
      value: "performance",
      label: "Performance",
      contentOwnsTitle: true,
      group: "Monitor",
      icon: <HugeiconsIcon icon={SquareActivityIcon} />,
      content: (
        <ScoutPerformance
          path={`/v1/core/resources/${resourceId}/metrics`}
          serverId={item.serverId}
          workload
        />
      ),
    },
    {
      value: "alerts",
      label: "Alerts",
      contentOwnsTitle: true,
      group: "Monitor",
      icon: <HugeiconsIcon icon={Alert02Icon} />,
      content: (
        <ScoutAlertRules serverId={item.serverId} deployableId={resourceId} />
      ),
    },
    {
      value: "incidents",
      label: "Incidents",
      contentOwnsTitle: true,
      group: "Monitor",
      icon: <HugeiconsIcon icon={AlertCircleIcon} />,
      content: (
        <ScoutIncidents serverId={item.serverId} deployableId={resourceId} />
      ),
    },
    {
      value: "vulnerabilities",
      label: "Vulnerabilities",
      group: "Monitor",
      icon: <HugeiconsIcon icon={SecurityCheckIcon} className="size-4" />,
      content: <DeployableVulnerabilities appId={resourceId} kind="resource" />,
    },
    {
      value: "deployments",
      label: "Deployments",
      group: "Ship",
      icon: <HugeiconsIcon icon={Rocket01Icon} />,
      indicator: {
        label: String(orderedDeployments.length),
        variant: "secondary" as const,
      },
      content: (
        <DeploymentTable
          deployableName={item.name}
          deployments={orderedDeployments}
          emptyDescription="Use Deploy when this datastore is ready."
        />
      ),
    },
    {
      value: "compare-deployments",
      label: "Compare deployments",
      sidebarLabel: "Compare",
      group: "Ship",
      icon: <HugeiconsIcon icon={GitCompareIcon} />,
      content: <ScoutCompareDeployments deployableId={resourceId} />,
    },
    ...[
      {
        value: "backup",
        label: "Backup",
        group: "Operate",
        icon: <HugeiconsIcon icon={ReloadIcon} />,
        indicator: missingBackupCredentials
          ? { dot: true, ariaLabel: "Needs credentials" }
          : undefined,
        content: (
          <ResourceBackupConfiguration
            active={!item.archivedAt && item.serverReady}
            resource={item}
          />
        ),
      },
      ...(can("resource.restore")
        ? [
            {
              value: "restore",
              label: "Restore",
              group: "Operate",
              icon: <HugeiconsIcon icon={Undo02Icon} />,
              indicator: missingRestoreCredentials
                ? { dot: true, ariaLabel: "Needs credentials" }
                : undefined,
              content: (
                <ResourceRestoreConfiguration
                  active={!item.archivedAt && item.serverReady}
                  resource={item}
                />
              ),
            },
          ]
        : []),
    ],
    {
      value: "manifest",
      label: "Manifest",
      group: "Operate",
      icon: <HugeiconsIcon icon={SourceCodeIcon} />,
      content: (
        <SourceEnvironmentManifest sourceId={item.sourceId} deployable={item} />
      ),
    },
    {
      value: "settings",
      label: "Settings",
      icon: <HugeiconsIcon icon={Settings01Icon} />,
      content: <ResourceSettings item={item} resourceId={resourceId} />,
    },
  ];

  return (
    <DashboardPage
      icon={CubeIcon}
      titleIcon={
        <ResourceLogo
          brand={resourceImageBrand(item.kind, item.config.image)}
        />
      }
      actions={
        detailNavigation.section === "overview" &&
        Boolean(latestDeployment) &&
        !item.archivedAt &&
        can("deployment.create") ? (
          <div className="flex flex-wrap justify-end gap-2">
            {Object.keys(item.config.externalSecrets ?? {}).length > 0 ? (
              <ActionButton
                confirm={{
                  title: "Refresh external secrets?",
                  description:
                    "Queue a new deployment that resolves one consistent snapshot of the current external secret versions. A retry of the existing deployment keeps its original snapshot.",
                  actionLabel: "Refresh and deploy",
                }}
                action={() =>
                  api.post<{ deployment: Deployment }>(
                    `/v1/core/resources/${resourceId}/actions/refresh-external-secrets`,
                    undefined,
                    { "Idempotency-Key": crypto.randomUUID() },
                  )
                }
                onSuccess={(result) =>
                  router.push(deploymentHref(result.deployment))
                }
                pendingLabel="Queueing…"
                isDisabled={!item.serverReady}
                success="External secret refresh queued"
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={Key01Icon}
                  className="size-3.5 shrink-0"
                />
                Refresh secrets
              </ActionButton>
            ) : null}
            <ActionButton
              confirm={{
                title: "Deploy this datastore?",
                description:
                  "Queue a new datastore deployment. This may replace its running container and briefly interrupt connections.",
                actionLabel: "Deploy datastore",
              }}
              action={() =>
                api.post<{ deployment: Deployment }>(
                  `/v1/core/resources/${resourceId}/actions/deploy`,
                  undefined,
                  { "Idempotency-Key": crypto.randomUUID() },
                )
              }
              onSuccess={(result) =>
                router.push(deploymentHref(result.deployment))
              }
              pendingLabel="Queueing…"
              isDisabled={!item.serverReady}
              success="Datastore deployment queued"
              variant="primary"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={Rocket01Icon}
                className="size-4 shrink-0"
              />
              Deploy
            </ActionButton>
            <DeployableActionsMenu
              active={item.serverReady}
              deployableId={resourceId}
              previousReleaseId={previous?.id}
              runtimeState={item.runtimeState}
              type="resource"
            />
          </div>
        ) : undefined
      }
      breadcrumbAncestors={resourcesBreadcrumb}
      breadcrumbSwitcher={{ id: resourceId, kind: "resources" }}
      title={item.name}
    >
      <InstanceEnvironmentChoice item={item} kind="resources" />
      {detailNavigation.section === "overview" ? (
        <DeployableReadiness
          ready={item.serverReady}
          serverId={item.serverId}
          serverIp={item.serverIp}
        />
      ) : null}
      <PageTabs defaultValue="overview" tabs={tabs} ungroupedTitle="" />
    </DashboardPage>
  );
}

function ResourceSettings({
  item,
  resourceId,
}: {
  item: ResourceRecord;
  resourceId: string;
}) {
  const requestedSettings = useDetailNavigation().settings;
  const tabs: Array<{
    content: ReactNode;
    label: string;
    value: string;
  }> = [
    {
      value: "configuration",
      label: "Configuration",
      content: <ResourceConfiguration item={item} />,
    },
    ...((item.config.container.networkAlias || item.config.access?.sshTunnel) &&
    item.config.container.port
      ? [
          {
            value: "connection",
            label: "Connection",
            content: <ResourceConnectionDetails item={item} />,
          },
        ]
      : []),
    {
      value: "auto-deploy",
      label: "Auto-deploy",
      content: <AutoDeployControlEditor id={resourceId} type="resource" />,
    },
    {
      value: "secrets",
      label: "Secrets",
      content: (
        <ResourceSecrets
          resourceId={resourceId}
          externalSource={item.config.externalSecrets}
        />
      ),
    },
    {
      value: "notifications",
      label: "Notifications",
      content: (
        <DeployableNotifications notifications={item.config.notifications} />
      ),
    },
  ];

  return (
    <ResponsiveSubtabs
      ariaLabel="Datastore settings"
      defaultSelectedKey={
        requestedSettings === "secrets" ? "secrets" : "configuration"
      }
      layout="sidebar"
      selectedKey={
        tabs.some((tab) => tab.value === requestedSettings)
          ? requestedSettings!
          : undefined
      }
      tabs={tabs}
    />
  );
}

function ResourceConfiguration({ item }: { item: ResourceRecord }) {
  return (
    <div className="content-grid lg:grid-cols-2 lg:items-start">
      <Attributes columns={2} title="Image configuration" variant="card">
        <Attributes.Item label="Image" className="col-span-2">
          <TypographyCode className="break-all">
            {item.config.image}
          </TypographyCode>
        </Attributes.Item>
        <Attributes.Item label="Engine">
          {formatResourceKind(item.kind)}
        </Attributes.Item>
        <Attributes.Item label="Repository branch">
          {item.config.sourceBranch ?? "main"}
        </Attributes.Item>
        <Attributes.Item label="Repository revision">
          <TypographyCode title={item.sourceRevision}>
            {item.sourceRevision.slice(0, 12)}
          </TypographyCode>
        </Attributes.Item>
      </Attributes>
      <Attributes columns={2} title="Container configuration" variant="card">
        <Attributes.Item label="Container port">
          {item.config.container.port ?? "Not exposed"}
        </Attributes.Item>
        <Attributes.Item label="Network">
          {item.config.container.network ? (
            <TypographyCode>{item.config.container.network}</TypographyCode>
          ) : (
            "Default bridge"
          )}
        </Attributes.Item>
        <ContainerRuntimeDetails container={item.config.container} />
        <Attributes.Item label="CPU limit">
          {item.config.container.resources.cpus}
        </Attributes.Item>
        <Attributes.Item label="Memory limit">
          {item.config.container.resources.memory}
        </Attributes.Item>
        <Attributes.Item label="Persistent volumes">
          {renderVolumes(item.config.container.volumes)}
        </Attributes.Item>
      </Attributes>
      <ResourceHealthCheck health={item.config.health} />
      <Attributes columns={2} title="Deployment configuration" variant="card">
        <Attributes.Item label="Auto-deploy">
          {item.config.autoDeploy ? "Enabled" : "Disabled"}
        </Attributes.Item>
        <Attributes.Item label="Primary domain">
          {item.config.domains?.primary ? (
            <DomainLink domain={item.config.domains.primary}>
              {item.config.domains.primary}
            </DomainLink>
          ) : (
            "Not configured"
          )}
        </Attributes.Item>
        <Attributes.Item label="Redirects">
          {item.config.domains?.redirects.length
            ? item.config.domains.redirects.map((redirect) => (
                <span className="flex items-center gap-1" key={redirect.host}>
                  <DomainLink domain={redirect.host}>
                    {redirect.host}
                  </DomainLink>
                  <span>· {redirect.status}</span>
                </span>
              ))
            : "None"}
        </Attributes.Item>
        <Attributes.Item label="TLS">
          {item.config.tls?.mode === "cloudflare-dns" ? (
            <span className="inline-flex items-center gap-1.5">
              <CloudProviderLogo provider="cloudflare" />
              Cloudflare DNS
            </span>
          ) : item.config.tls?.mode === "direct" ? (
            "Direct"
          ) : (
            "Not configured"
          )}
        </Attributes.Item>
      </Attributes>
    </div>
  );
}

function ResourceConnectionDetails({ item }: { item: ResourceRecord }) {
  return (
    <Attributes columns={2} title="Connection details" variant="card">
      <Attributes.Item label="Private host">
        {item.config.container.networkAlias ? (
          <TypographyCode>{item.config.container.networkAlias}</TypographyCode>
        ) : (
          "Not configured"
        )}
      </Attributes.Item>
      <Attributes.Item label="Private port">
        <TypographyCode>{item.config.container.port}</TypographyCode>
      </Attributes.Item>
      {item.config.access?.sshTunnel ? (
        <>
          <Attributes.Item label="Service host">
            <TypographyCode>127.0.0.1</TypographyCode>
          </Attributes.Item>
          <Attributes.Item label="Service port">
            <TypographyCode>
              {item.config.access.sshTunnel.hostPort}
            </TypographyCode>
          </Attributes.Item>
          <Attributes.Item label="SSH host">
            <TypographyCode>{item.serverIp}</TypographyCode>
          </Attributes.Item>
          <Attributes.Item label="SSH port">
            <TypographyCode>{item.serverSsh.port}</TypographyCode>
          </Attributes.Item>
          <Attributes.Item label="SSH username">
            <TypographyCode>{item.serverSsh.username}</TypographyCode>
          </Attributes.Item>
          <Attributes.Item label="Transport">SSH tunnel</Attributes.Item>
        </>
      ) : null}
    </Attributes>
  );
}

function ResourceHealthCheck({
  health,
}: {
  health: Resource["config"]["health"];
}) {
  return (
    <Attributes columns={2} title="Health check" variant="card">
      <Attributes.Item label="Check type">
        {health.type === "http"
          ? "HTTP"
          : health.type === "command"
            ? "Command"
            : "Container"}
      </Attributes.Item>
      <Attributes.Item label="Timeout">
        {health.timeoutSeconds} seconds
      </Attributes.Item>
      {health.publicPath ? (
        <Attributes.Item label="Public health path">
          <TypographyCode className="break-all">
            {health.publicPath}
          </TypographyCode>
        </Attributes.Item>
      ) : null}
      {health.type === "http" && health.port ? (
        <Attributes.Item label="Health port">{health.port}</Attributes.Item>
      ) : null}
      {health.type === "http" ? (
        <Attributes.Item label="Endpoint path" className="col-span-2">
          <TypographyCode className="break-all">{health.path}</TypographyCode>
        </Attributes.Item>
      ) : health.type === "command" ? (
        <Attributes.Item label="Command" className="col-span-2">
          <TypographyCode className="break-all">
            {health.command.join(" ")}
          </TypographyCode>
        </Attributes.Item>
      ) : null}
    </Attributes>
  );
}

function renderVolumes(volumes: Resource["config"]["container"]["volumes"]) {
  if (!volumes.length) return "None";
  return (
    <span className="grid gap-1.5">
      {volumes.map((volume) => (
        <span
          className="flex min-w-0 flex-wrap items-center gap-1.5"
          key={volume.name}
        >
          <TypographyCode>{volume.name}</TypographyCode>
          <span aria-hidden="true" className="text-muted">
            →
          </span>
          <TypographyCode>{volume.mountPath}</TypographyCode>
        </span>
      ))}
    </span>
  );
}

function formatResourceKind(kind: Resource["kind"]) {
  if (kind === "postgres") return "PostgreSQL";
  if (kind === "redis") return "Redis";
  return "Docker image";
}

function getResourceLifecycleStatus(item: ResourceRecord) {
  if (item.archivedAt) return "archived";
  if (!item.serverReady) return "server_setup_pending";
  return "active";
}
