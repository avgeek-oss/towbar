"use client";

import {
  Add01Icon,
  ReloadIcon,
  Unlink01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/hooks/use-guarded-router";
import { useEffect, useRef, useState } from "react";
import type {
  GitHubConnection,
  PreviewReportingHealth,
} from "@workspace/towbar-web-client";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { ButtonLink } from "@avgeek-oss/design-system/buttons/button";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";

import { ActionButton, FormCard } from "@/components/page-parts";
import { refreshApiQueries, useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";

type GitHubState = {
  configuration: {
    appId: string;
    appSlug: string;
    source: "environment";
  } | null;
  connections: GitHubConnection[];
  previewReporting: PreviewReportingHealth;
};

export function GitHubSettings() {
  const router = useRouter();
  const params = useSearchParams();
  const completed = useRef(false);
  const [callbackError, setCallbackError] = useState<string>();
  const query = useApiQuery<GitHubState>("/v1/core/github", 15_000);
  const refresh = query.refresh;
  const installationId = params.get("installation_id");
  const state = params.get("state");

  useEffect(() => {
    if (!installationId || !state || completed.current) return;
    completed.current = true;
    api
      .post("/v1/core/github/actions/complete-installation", {
        installationId,
        state,
      })
      .then(() => {
        router.replace("/manage/integrations/github");
        refreshApiQueries();
        refresh();
      })
      .catch((error: unknown) =>
        setCallbackError(
          error instanceof Error ? error.message : "Could not connect GitHub",
        ),
      );
  }, [installationId, router, state, refresh]);

  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;
  if (callbackError) return <QueryError message={callbackError} />;
  if (installationId && state) return <QueryLoading />;
  if (!query.data.configuration)
    return (
      <QueryError message="GitHub is not configured in the Towbar environment." />
    );

  return (
    <GitHubConnectionCard
      configuration={query.data.configuration}
      connections={query.data.connections}
    />
  );
}

function GitHubConnectionCard({
  configuration,
  connections,
}: {
  configuration: NonNullable<GitHubState["configuration"]>;
  connections: GitHubConnection[];
}) {
  const connect = (
    <ActionButton
      action={createGitHubInstallation}
      pendingLabel="Opening GitHub…"
      redirectOnSuccess={(result) => result.url}
      success="Opening GitHub"
    >
      <HugeiconsIcon aria-hidden="true" icon={Add01Icon} className="size-4" />
      Connect GitHub account
    </ActionButton>
  );
  return (
    <div className="content-grid">
      <FormCard help={false} title="GitHub App">
        <Attributes columns={2} variant="embedded">
          <Attributes.Item label="App">{configuration.appSlug}</Attributes.Item>
          <Attributes.Item label="App ID">
            <TypographyCode>{configuration.appId}</TypographyCode>
          </Attributes.Item>
        </Attributes>
      </FormCard>
      {connections
        .flatMap((connection) => connection.identityWarnings ?? [])
        .map((message) => (
          <Alert key={message} status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{message}</Alert.Description>
            </Alert.Content>
          </Alert>
        ))}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Connected accounts</h2>
        {connect}
      </div>
      <ResourceTable<GitHubConnection>
        ariaLabel="Connected GitHub accounts"
        getRowKey={(connection) => connection.id}
        items={connections}
        emptyTitle="No GitHub accounts connected"
        emptyDescription="Connect the GitHub App to the accounts and repositories Towbar should manage."
        columns={[
          {
            key: "account",
            header: "Account",
            cell: (connection) => (
              <span>
                {connection.accountLogin}
                <span className="ml-2 text-sm text-muted">
                  {connection.accountType}
                </span>
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (connection) => (
              <StatusBadge
                status={
                  connection.suspendedAt
                    ? "suspended"
                    : connection.permissionReadiness.status === "unavailable"
                      ? "attention"
                      : "active"
                }
              />
            ),
          },
          {
            key: "previews",
            header: "Preview reporting",
            cell: (connection) => (
              <Tooltip>
                <Tooltip.Trigger
                  aria-label={`Preview reporting for ${connection.accountLogin}`}
                  className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <StatusBadge
                    status={
                      connection.permissionReadiness.status === "available" &&
                      connection.permissionReadiness.preview === "ready" &&
                      !connection.suspendedAt
                        ? "ready"
                        : "attention"
                    }
                  />
                </Tooltip.Trigger>
                <Tooltip.Content className="max-w-72" showArrow>
                  <Tooltip.Arrow />
                  {connection.suspendedAt
                    ? "Reconnect this GitHub account to report previews."
                    : connection.permissionReadiness.status === "unavailable"
                      ? "GitHub access could not be verified. Review this account's installation access."
                      : connection.permissionReadiness.preview === "ready"
                        ? "This account can publish preview deployments and pull request comments."
                        : "Preview reporting requires Contents: Read, Deployments: Write, and Pull requests: Write. Review access to grant the missing permissions."}
                </Tooltip.Content>
              </Tooltip>
            ),
          },
          {
            key: "actions",
            header: "Actions",
            headerClassName: "text-right",
            className: "text-right",
            cell: (connection) => (
              <div className="flex flex-wrap justify-end gap-2">
                {connection.suspendedAt ? (
                  <ActionButton
                    action={createGitHubInstallation}
                    pendingLabel="Opening GitHub…"
                    redirectOnSuccess={(result) => result.url}
                    success="Opening GitHub"
                  >
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={ReloadIcon}
                      className="size-4"
                    />
                    Reconnect
                  </ActionButton>
                ) : (
                  <ButtonLink
                    variant="secondary"
                    href={
                      connection.accountType === "Organization"
                        ? `https://github.com/organizations/${encodeURIComponent(connection.accountLogin)}/settings/installations/${connection.installationId}`
                        : `https://github.com/settings/installations/${connection.installationId}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Review access
                  </ButtonLink>
                )}
                {!connection.suspendedAt ? (
                  <ActionButton
                    action={() =>
                      api.delete(
                        `/v1/core/github?${new URLSearchParams({ connectionId: connection.id })}`,
                      )
                    }
                    confirm={{
                      actionLabel: "Disconnect account",
                      title: `Disconnect ${connection.accountLogin}?`,
                      description:
                        "Repositories connected to this account will stop syncing and cannot deploy until it is reconnected. Running workloads and other connected accounts are unaffected.",
                    }}
                    success="GitHub account disconnected"
                    variant="danger"
                  >
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={Unlink01Icon}
                      className="size-4"
                    />
                    Disconnect
                  </ActionButton>
                ) : null}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

async function createGitHubInstallation() {
  return await api.post<{ url: string }>(
    "/v1/core/github/actions/installation-url",
  );
}
