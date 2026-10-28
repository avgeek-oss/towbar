"use client";

import {
  type KeyScope,
  type KeyAccess,
  type KeyPermissionMode,
} from "@workspace/towbar-access";
import { useAccess } from "./access-context";
import { PageSelectionTitle } from "./page-selection-title";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ShieldBanIcon } from "@hugeicons/core-free-icons";
import { useMemo, useRef, useState } from "react";
import {
  CreateApiKeyDialog,
  apiKeyPermissionOptions,
  apiKeyExpiryOptions,
  McpGuideSettings,
  McpConnectionsSettings,
} from "@avgeek-oss/design-system";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { ActionButton } from "./page-parts";
import { RelativeTime } from "./last-synced-time";
import { McpClientLogo } from "./mcp-client-logo";
import { PrivateKeyStore } from "./private-key-store";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  access: KeyAccess;
  includeAdmin: boolean;
  permissionMode: KeyPermissionMode;
  scope: KeyScope;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  tokenType: "api-key" | "mcp-oauth";
  oauthClientName: string | null;
  oauthClientId: string | null;
  oauthClientLogo: string | null;
  oauthClientTrust: "metadata-document" | "unverified" | null;
};
type KeySettings = {
  keys: ApiKey[];
  apiUrl: string;
  mcpUrl: string;
  rateLimit: { requests: number; windowSeconds: number };
};
const baseEndpoint = "/v1/core/settings/api-keys";

export type KeyStoreSection =
  "private-keys" | "personal-keys" | "team-keys" | "mcp-connections" | "mcp";
export function ApiMcpSettings({ section }: { section: KeyStoreSection }) {
  const scope: KeyScope = section === "team-keys" ? "team" : "personal";
  const endpoint = `${baseEndpoint}/${scope}`;
  const isKeyPage = section === "personal-keys" || section === "team-keys";
  const query = useApiQuery<KeySettings>(
    isKeyPage || section === "mcp-connections" ? endpoint : null,
  );
  const guide = useApiQuery<KeySettings>(
    section === "mcp" ? `${baseEndpoint}/personal` : null,
  );
  const [revokedKeyIds, setRevokedKeyIds] = useState<Set<string>>(
    () => new Set(),
  );
  const visibleKeys = (query.data?.keys ?? []).filter(
    (key) => !key.revokedAt && !revokedKeyIds.has(key.id),
  );
  const apiKeys = visibleKeys.filter((key) => key.tokenType === "api-key");
  const mcpConnections = visibleKeys.filter(
    (key) => key.tokenType === "mcp-oauth",
  );
  const [creatingPrivateKey, setCreatingPrivateKey] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formInstance, setFormInstance] = useState(0);
  const actions = useMemo(
    () =>
      section === "private-keys" ? (
        <Button onPress={() => setCreatingPrivateKey(true)}>
          <HugeiconsIcon
            aria-hidden="true"
            icon={Add01Icon}
            className="size-4"
          />
          Add private key
        </Button>
      ) : isKeyPage ? (
        <Button
          onPress={() => {
            setFormInstance((value) => value + 1);
            setCreating(true);
          }}
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={Add01Icon}
            className="size-4"
          />
          Create API key
        </Button>
      ) : undefined,
    [section, isKeyPage],
  );
  const sectionLabels: Record<KeyStoreSection, string> = {
    "private-keys": "SSH keys",
    "personal-keys": "API Keys",
    "team-keys": "API Keys",
    "mcp-connections": "MCP Connections",
    mcp: "MCP Guide",
  };
  const columns: ResourceTableColumn<ApiKey>[] = [
    {
      key: "name",
      header: "Key",
      className: "min-w-52",
      cell: (key) => key.name,
    },
    {
      key: "access",
      header: "Permissions",
      cell: (key) =>
        key.access === "read"
          ? "Read-only"
          : key.includeAdmin
            ? key.permissionMode === "full-admin"
              ? "Administrative permissions"
              : "Scoped administrative permissions"
            : "Edit",
    },
    {
      key: "added",
      header: "Added",
      cell: (key) => <RelativeTime label="Added" value={key.createdAt} />,
    },
    {
      key: "expires",
      header: "Expires",
      cell: (key) =>
        key.expiresAt ? (
          <RelativeTime label="Expires" value={key.expiresAt} />
        ) : (
          "No expiry"
        ),
    },
    {
      key: "used",
      header: "Last used",
      cell: (key) =>
        key.lastUsedAt ? (
          <RelativeTime label="Last used" value={key.lastUsedAt} />
        ) : (
          <span className="text-muted">Never</span>
        ),
    },
    {
      key: "actions",
      header: "",
      cell: (key) =>
        !key.revokedAt ? (
          <ActionButton
            action={async () => {
              await api.delete(`${endpoint}/${key.id}`);
              setRevokedKeyIds((ids) => new Set(ids).add(key.id));
              query.refresh();
            }}
            confirm={{
              title: `Revoke ${key.name}?`,
              description:
                "Any REST API script using this key will lose access immediately. Create a replacement key to reconnect.",
              actionLabel: "Revoke key",
            }}
            variant="danger"
            success="Key revoked"
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={ShieldBanIcon}
              size={16}
              className="shrink-0"
            />
            Revoke
          </ActionButton>
        ) : null,
    },
  ];

  return (
    <div className="content-grid">
      <PageSelectionTitle label={sectionLabels[section]} actions={actions} />
      {section === "private-keys" ? (
        <PrivateKeyStore
          createOpen={creatingPrivateKey}
          onCreateOpenChange={setCreatingPrivateKey}
        />
      ) : isKeyPage || section === "mcp-connections" ? (
        query.error ? (
          <QueryError message={query.error} />
        ) : !query.data ? (
          <QueryLoading />
        ) : isKeyPage ? (
          <ResourceTable
            ariaLabel={sectionLabels[section]}
            columns={columns}
            items={apiKeys}
            getRowKey={(key) => key.id}
            emptyTitle="No API keys yet"
            emptyDescription={
              scope === "personal"
                ? "Create an API key for your scripts or apps."
                : "Create an API key for scripts or apps used by your team."
            }
          />
        ) : (
          <McpConnectionsSettings
            items={mcpConnections.map((key) => ({
              id: key.id,
              name: key.oauthClientName ?? key.name,
              createdAt: key.createdAt,
              expiresAt: key.expiresAt,
              lastUsedAt: key.lastUsedAt,
              permissions:
                key.access === "read"
                  ? "Read-only"
                  : key.includeAdmin
                    ? "Administrative permissions"
                    : "Edit",
              client: {
                name: key.oauthClientName ?? key.name,
                id:
                  key.oauthClientTrust === "metadata-document"
                    ? (key.oauthClientId ?? undefined)
                    : undefined,
                logo: (
                  <McpClientLogo client={key.oauthClientLogo ?? "unknown"} />
                ),
              },
            }))}
            formatDate={(value) => <RelativeTime label="Date" value={value} />}
            onRevoke={async (id) => {
              await api.delete(`${endpoint}/${id}`);
              setRevokedKeyIds((ids) => new Set(ids).add(id));
              query.refresh();
              toast.success("Connection revoked");
            }}
          />
        )
      ) : guide.error ? (
        <QueryError message={guide.error} />
      ) : !guide.data ? (
        <QueryLoading />
      ) : (
        <McpSetup url={guide.data.mcpUrl} />
      )}
      <CreateKey
        key={formInstance}
        scope={scope}
        isOpen={creating}
        onOpenChange={setCreating}
        onCreated={() => query.refresh()}
      />
    </div>
  );
}

function CreateKey({
  scope,
  isOpen,
  onOpenChange,
  onCreated,
}: {
  scope: KeyScope;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { user } = useAccess();
  const request = useRef<{
    id: string;
    values: string;
    body: {
      name: string;
      access: "read" | "edit";
      includeAdmin: boolean;
      expiresAt: string | null;
    };
  } | null>(null);
  const role = user?.workspaceRole;
  return (
    <CreateApiKeyDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      permissionOptions={apiKeyPermissionOptions.filter(
        (option) =>
          option.id === "read" ||
          (option.id === "edit" && (role === "admin" || role === "member")) ||
          (option.id === "admin" && role === "admin"),
      )}
      expiryOptions={apiKeyExpiryOptions.filter(
        (option) => option.id !== "never" || role === "admin",
      )}
      onCreate={async (values) => {
        const fingerprint = JSON.stringify(values);
        if (request.current?.values !== fingerprint) {
          request.current = {
            id: crypto.randomUUID(),
            values: fingerprint,
            body: {
              name: values.name,
              access: values.permission === "read" ? "read" : "edit",
              includeAdmin: values.permission === "admin",
              expiresAt:
                values.expiry === "never"
                  ? null
                  : new Date(
                      Date.now() + Number(values.expiry) * 86400000,
                    ).toISOString(),
            },
          };
        }
        const result = await api.post<{ token: string | null }>(
          `${baseEndpoint}/${scope}`,
          request.current.body,
          { "Idempotency-Key": request.current.id },
        );
        onCreated();
        return result;
      }}
    />
  );
}

function McpSetup({ url }: { url: string }) {
  const configs = {
    codex: {
      title: "~/.codex/config.toml",
      code: `[mcp_servers.towbar]\nurl = ${JSON.stringify(url)}`,
    },
    cursor: {
      title: ".cursor/mcp.json",
      code: JSON.stringify({ mcpServers: { towbar: { url } } }, null, 2),
    },
    vscode: {
      title: ".vscode/mcp.json",
      code: JSON.stringify(
        { servers: { towbar: { type: "http", url } } },
        null,
        2,
      ),
    },
    claude: {
      title: "Claude Code",
      code: `claude mcp add --transport http towbar '${url}'`,
    },
    other: {
      title: "Connection details",
      code: `Transport: Streamable HTTP\nURL: ${url}\nAuthentication: OAuth`,
    },
  };
  const labels = {
    codex: "Codex",
    claude: "Claude Code",
    cursor: "Cursor",
    vscode: "VS Code",
    other: "Other clients",
  };
  return (
    <McpGuideSettings
      configurations={Object.entries(configs).map(([id, config]) => ({
        id,
        label: labels[id as keyof typeof labels],
        filename: config.title,
        code: config.code,
        icon: <McpClientLogo client={id} />,
      }))}
      documentationUrl="https://www.towbar.dev/docs/api/mcp"
    />
  );
}
