"use client";

import { Add01Icon, Unlink01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";

import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { ActionButton, FormCard } from "./page-parts";

type Connection = {
  description: string;
  id: string;
  name: string;
  slug: string;
  verificationStatus: string;
};

export function GitLabSettings() {
  const query = useApiQuery<{ connections: Connection[] }>(
    "/v1/core/gitlab/connections",
  );
  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;
  const connection = query.data.connections[0] ?? null;

  return (
    <div className="content-grid grid-cols-[repeat(auto-fill,minmax(min(28rem,100%),1fr))] items-start">
      <FormCard
        title="GitLab connection"
        help={false}
        headerEnd={
          connection ? (
            <StatusBadge status="active" label="Connected" />
          ) : undefined
        }
      >
        {connection ? (
          <div className="content-grid">
            <Attributes columns={1} variant="embedded">
              <Attributes.Item label="Account">
                {connection.name}
              </Attributes.Item>
              <Attributes.Item label="Identity">
                {connection.description}
              </Attributes.Item>
              <Attributes.Item label="Authorization">OAuth 2.0</Attributes.Item>
            </Attributes>
            <div className="flex flex-wrap gap-3">
              <ActionButton
                action={createGitLabAuthorization}
                pendingLabel="Opening GitLab…"
                redirectOnSuccess={(result) => result.authorizationUrl}
                success="Opening GitLab"
              >
                Reauthorize GitLab
              </ActionButton>
              <ActionButton
                action={() => api.delete("/v1/core/gitlab/oauth/connection")}
                confirm={{
                  actionLabel: "Disconnect GitLab",
                  description:
                    "Existing GitLab repositories will stop syncing and cannot deploy until GitLab is authorized again.",
                  title: "Disconnect GitLab?",
                }}
                success="GitLab disconnected"
                variant="danger"
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={Unlink01Icon}
                  className="size-4"
                />
                Disconnect GitLab
              </ActionButton>
            </div>
          </div>
        ) : (
          <EmptyState>
            <EmptyState.Header>
              <EmptyState.Title>GitLab not connected</EmptyState.Title>
              <EmptyState.Description className="max-w-md text-pretty">
                Authorize Towbar using the GitLab OAuth application configured
                in the runtime environment.
              </EmptyState.Description>
            </EmptyState.Header>
            <EmptyState.Content>
              <ActionButton
                action={createGitLabAuthorization}
                pendingLabel="Opening GitLab…"
                redirectOnSuccess={(result) => result.authorizationUrl}
                success="Opening GitLab"
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={Add01Icon}
                  className="size-4"
                />
                Connect GitLab
              </ActionButton>
            </EmptyState.Content>
          </EmptyState>
        )}
      </FormCard>
    </div>
  );
}

async function createGitLabAuthorization() {
  return await api.post<{ authorizationUrl: string }>(
    "/v1/core/gitlab/oauth/start",
  );
}
