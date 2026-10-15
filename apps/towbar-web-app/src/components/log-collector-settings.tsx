"use client";
import { useRef, useState } from "react";
import {
  Delete02Icon,
  Download01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { InlineExternalLink } from "@avgeek-oss/design-system/navigation/inline-external-link";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { TowbarApiError } from "@workspace/towbar-web-client";
import type {
  LogCollectionStatus,
  LogStorageStatus,
} from "@workspace/towbar-web-client";
import { refreshApiQueries, useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { displayDateTime } from "@/lib/date-time-display";

export function LogCollectorSettings({
  serverId,
  canManage,
  ready,
}: {
  serverId: string;
  canManage: boolean;
  ready: boolean;
}) {
  const collector = useApiQuery<LogCollectionStatus>(
    `/v1/core/servers/${serverId}/log-collection`,
    5000,
  );
  const storage = useApiQuery<LogStorageStatus>(
    "/v1/core/observability/logs/status",
    15000,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const action = useRef<{ enabled: boolean; key: string } | null>(null);
  async function configure(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (!action.current || action.current.enabled !== enabled)
        action.current = { enabled, key: crypto.randomUUID() };
      await api.put(
        `/v1/core/servers/${serverId}/log-collection`,
        { enabled },
        { "Idempotency-Key": action.current.key },
      );
      action.current = null;
      refreshApiQueries();
    } catch (cause) {
      if (cause instanceof TowbarApiError && cause.status < 500)
        action.current = null;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update log collection.",
      );
    } finally {
      setBusy(false);
    }
  }
  const item = collector.data,
    pending = busy || ["queued", "installing"].includes(item?.status ?? "");
  return (
    <Widget>
      <Widget.Header>
        <Widget.Title help={false}>Centralized logs</Widget.Title>
      </Widget.Header>
      <Widget.Content className="content-grid">
        {collector.error || storage.error || error ? (
          <QueryError message={collector.error ?? storage.error ?? error!} />
        ) : null}
        {!item || !storage.data ? (
          !collector.error && !storage.error ? (
            <QueryLoading />
          ) : null
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-4 text-sm lg:grid-cols-3">
              <div>
                <dt className="text-muted">Status</dt>
                <dd>
                  {item.status === "waiting"
                    ? "Waiting for first log"
                    : item.status === "backlogged"
                      ? "Queue storage at limit"
                      : item.status}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Collector version</dt>
                <dd>{item.version ?? "Not installed"}</dd>
              </div>
              <div>
                <dt className="text-muted">Last ingestion</dt>
                <dd>
                  {item.lastIngestedAt
                    ? displayDateTime(item.lastIngestedAt)
                    : "No logs received yet"}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Container coverage</dt>
                <dd>
                  {item.supportedContainers} supported ·{" "}
                  {item.unsupportedContainers} unsupported
                </dd>
              </div>
              <div>
                <dt className="text-muted">Queue storage</dt>
                <dd>{(item.queueBytes / 1048576).toFixed(1)} MiB</dd>
              </div>
              <div>
                <dt className="text-muted">Rejected records</dt>
                <dd>{item.droppedRecords}</dd>
              </div>
            </dl>
            {item.errorMessage ? (
              <QueryError message={item.errorMessage} />
            ) : null}
            {storage.data.state !== "ready" ? (
              <p className="text-sm text-muted">
                {storage.data.reason ??
                  "Connect ClickHouse in config.yml before enabling collection."}{" "}
                <InlineExternalLink href={storage.data.documentationUrl}>
                  Setup and requirements
                </InlineExternalLink>
              </p>
            ) : null}
            {!ready ? (
              <p className="text-sm text-muted">
                Prepare this server before enabling log collection.
              </p>
            ) : null}
            {item.unsupportedContainers > 0 ? (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>
                    Some managed containers cannot be collected. Check the
                    Docker json-file driver, workload ownership, and the
                    512-container limit.
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  isDisabled={
                    pending || !ready || storage.data.state !== "ready"
                  }
                  onPress={() => configure(true)}
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={
                      item.desiredState === "enabled"
                        ? RefreshIcon
                        : Download01Icon
                    }
                    className="size-4 shrink-0"
                  />
                  {pending
                    ? "Updating…"
                    : item.desiredState === "enabled"
                      ? "Update collector"
                      : "Enable log collection"}
                </Button>
                <Button
                  variant="danger"
                  isDisabled={pending || item.desiredState !== "enabled"}
                  onPress={() => configure(false)}
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={Delete02Icon}
                    className="size-4 shrink-0"
                  />
                  Disable collection
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Widget.Content>
    </Widget>
  );
}
