"use client";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { FieldDescription } from "@avgeek-oss/design-system/forms/field";
import { useState } from "react";
import type { MonitoringAgentStatus } from "@workspace/towbar-web-client";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Checkbox } from "@avgeek-oss/design-system/forms/checkbox";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { ListBox, Select } from "@avgeek-oss/design-system/forms/select";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { ScoutIcon } from "./scout-icons";
import { ScoutMascot } from "./scout-mascot";
import { ActionButton } from "./page-parts";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { formatDate } from "./dashboard-overview";

export function MonitoringAgentSettings({
  serverId,
  canManage,
  ready,
}: {
  serverId: string;
  canManage: boolean;
  ready: boolean;
}) {
  const query = useApiQuery<{ agent: MonitoringAgentStatus }>(
    `/v1/core/servers/${serverId}/monitoring`,
    5000,
  );
  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;
  return (
    <MonitoringAgentForm
      agent={query.data.agent}
      serverId={serverId}
      canManage={canManage}
      ready={ready}
    />
  );
}
function MonitoringAgentForm({
  agent,
  serverId,
  canManage,
  ready,
}: {
  agent: MonitoringAgentStatus;
  serverId: string;
  canManage: boolean;
  ready: boolean;
}) {
  const [retention, setRetention] = useState<number | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const days = retention ?? agent.retentionDays;
  const busy =
    ["queued", "installing", "uninstalling"].includes(agent.status) ||
    agent.removingServer;
  const installed = agent.desiredState === "enabled";
  const endpoint = `/v1/core/servers/${serverId}/monitoring`;
  return (
    <div className="content-grid">
      <Widget>
        <Widget.Header endContent={<MonitoringStatus agent={agent} />}>
          <Widget.Title help={false}>Scout Agent</Widget.Title>
        </Widget.Header>
        <Widget.Content className="grid gap-5">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4">
            <ScoutMascot />
            <div className="grid min-w-0 gap-2">
              <p className="font-medium">
                Scout Agent, your monitoring powerhouse.
              </p>
              <p className="max-w-3xl text-sm text-muted">
                Monitor server, app, and resource performance in real time.
                Configure alert and incident thresholds to be notified when
                something needs attention.
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-4 text-sm lg:grid-cols-3">
            <div>
              <dt className="text-muted">Scout Agent version</dt>
              <dd className="mt-0.5 tabular-nums">
                {agent.version ?? "Not installed"}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Last sample</dt>
              <dd className="mt-0.5 tabular-nums">
                {agent.lastCollectedAt
                  ? formatDate(agent.lastCollectedAt)
                  : "Waiting for a report"}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Reporting interval</dt>
              <dd className="mt-0.5">30 seconds</dd>
            </div>
          </dl>
          {busy ? (
            <p role="status" className="text-sm text-muted">
              {agent.removingServer
                ? "Removing Scout Agent before removing this server…"
                : agent.status === "uninstalling"
                  ? "Stopping and removing Scout Agent…"
                  : agent.status === "installing"
                    ? "Installing services and checking startup…"
                    : "Waiting for the worker…"}
            </p>
          ) : null}
          {agent.status === "waiting" ? (
            <p role="status" className="text-sm text-muted">
              Scout Agent is installed. Waiting for the first report.
            </p>
          ) : null}
          {agent.errorMessage ? (
            <QueryError message={agent.errorMessage} />
          ) : null}
          {agent.diagnostics &&
          (agent.diagnostics.collectionErrors > 0 ||
            agent.diagnostics.droppedSamples > 0) ? (
            <p className="text-sm text-warning">
              Last collection: {agent.diagnostics.collectionErrors} unavailable
              checks. {agent.diagnostics.droppedSamples} buffered samples
              dropped. Missing measurements appear as gaps.
            </p>
          ) : null}
          {canManage && !installed && !busy ? (
            <Checkbox
              isSelected={acknowledged}
              onChange={setAcknowledged}
              variant="secondary"
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label>
                  Allow Towbar to install Scout Agent and collect performance
                  data.
                </Label>
              </Checkbox.Content>
            </Checkbox>
          ) : null}
          {canManage ? (
            <div className="flex items-center gap-2">
              <ActionButton
                action={() =>
                  api.post(`${endpoint}/actions/install`, {
                    acknowledge: true,
                    retentionDays: days,
                  })
                }
                isDisabled={busy || !ready || (!installed && !acknowledged)}
                confirm={
                  installed
                    ? {
                        title: "Update Scout Agent?",
                        description:
                          "Install the latest version of Scout Agent. Reporting may pause briefly.",
                        actionLabel: "Update Agent",
                      }
                    : {
                        title: "Install Scout Agent?",
                        description:
                          "Install Scout Agent on this server and begin collecting performance data.",
                        actionLabel: "Install Agent",
                      }
                }
                onSuccess={() => {
                  setAcknowledged(false);
                  setRetention(null);
                }}
                success="Scout Agent installation queued"
                pendingLabel="Queuing…"
                variant="primary"
              >
                <ScoutIcon name={installed ? "refresh" : "install"} />
                {installed ? "Update Agent" : "Install Agent"}
              </ActionButton>
              {installed || agent.status === "failed" ? (
                <ActionButton
                  action={() => api.post(`${endpoint}/actions/uninstall`)}
                  isDisabled={busy}
                  confirm={{
                    title: "Uninstall Scout Agent?",
                    description:
                      "Stop monitoring and remove Scout Agent. Existing history is kept for your selected retention period.",
                    actionLabel: "Uninstall Agent",
                  }}
                  success="Scout Agent removal queued"
                  pendingLabel="Queuing…"
                  variant="danger"
                >
                  <ScoutIcon name="delete" />
                  Uninstall Agent
                </ActionButton>
              ) : null}
            </div>
          ) : null}
          {!ready && !installed ? (
            <p className="text-sm text-muted">
              Prepare this server before installing Scout Agent.
            </p>
          ) : null}
        </Widget.Content>
      </Widget>
      {installed ? (
        <Widget>
          <Widget.Header>
            <Widget.Title>Configure</Widget.Title>
          </Widget.Header>
          <Widget.Content className="grid gap-5">
            {canManage ? (
              <div className="grid max-w-sm gap-2">
                <Select
                  selectedKey={String(days)}
                  onSelectionChange={(value) => {
                    if (value) setRetention(Number(value));
                  }}
                  isDisabled={!canManage || busy}
                  variant="secondary"
                  fullWidth
                >
                  <Label>Data retention</Label>
                  <Select.Trigger>
                    <Select.Value className="flex min-w-0 items-center" />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {[7, 15, 30, 60].map((value) => (
                        <ListBox.Item
                          id={String(value)}
                          key={value}
                          textValue={`${value} days`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <ScoutIcon name="date" />
                            {value} days{value === 15 ? " (default)" : ""}
                          </span>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <FieldDescription>
                  Choose how long to keep performance history. Reducing this
                  period removes older data.
                </FieldDescription>
              </div>
            ) : (
              <dl className="text-sm">
                <dt className="text-muted">Data retention</dt>
                <dd className="mt-0.5">{agent.retentionDays} days</dd>
              </dl>
            )}
            {canManage && days !== agent.retentionDays ? (
              <div>
                <ActionButton
                  confirm={
                    days < agent.retentionDays
                      ? {
                          title: "Reduce performance retention?",
                          description: `Performance data older than ${days} days will be removed. This cannot be undone.`,
                          actionLabel: "Reduce retention",
                        }
                      : undefined
                  }
                  action={() => api.patch(endpoint, { retentionDays: days })}
                  onSuccess={() => setRetention(null)}
                  isDisabled={busy}
                  success="Retention updated"
                >
                  <ScoutIcon name="save" />
                  Save retention
                </ActionButton>
              </div>
            ) : null}
          </Widget.Content>
        </Widget>
      ) : null}
    </div>
  );
}
export function MonitoringStatus({ agent }: { agent: MonitoringAgentStatus }) {
  const labels: Record<string, string> = {
    disabled: "Not enabled",
    queued: "Queued",
    installing: "Installing",
    waiting: "Awaiting report",
    online: "Online",
    offline: "No recent report",
    uninstalling: "Uninstalling",
    failed: "Needs attention",
  };
  return (
    <TooltipText
      className="inline-flex"
      tooltip={monitoringStatusTooltip(agent)}
    >
      <Chip
        size="sm"
        color={
          agent.status === "online"
            ? "success"
            : agent.status === "failed"
              ? "danger"
              : agent.status === "offline"
                ? "warning"
                : "default"
        }
      >
        <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
          {["queued", "installing", "uninstalling", "waiting"].includes(
            agent.status,
          ) ? (
            <Spinner
              aria-hidden="true"
              color="current"
              size="sm"
              className="size-3.5"
            />
          ) : (
            <ScoutIcon
              name={
                agent.status === "online"
                  ? "resolved"
                  : agent.status === "failed"
                    ? "critical"
                    : agent.status === "offline"
                      ? "warning"
                      : "time"
              }
            />
          )}
          {labels[agent.status] ?? agent.status}
        </Chip.Label>
      </Chip>
    </TooltipText>
  );
}

function monitoringStatusTooltip(agent: MonitoringAgentStatus) {
  if (agent.errorMessage) return agent.errorMessage;
  if (agent.lastCollectedAt) {
    return `Latest sample collected ${formatDate(agent.lastCollectedAt)}.`;
  }
  return (
    {
      disabled: "Scout Agent is not enabled on this server.",
      queued: "Installation is waiting for an available worker.",
      installing: "Towbar is installing Scout Agent on the server.",
      waiting: "Scout Agent is installed and waiting to send its first report.",
      offline: "No report arrived within the expected reporting window.",
      uninstalling: "Towbar is removing Scout Agent from the server.",
      failed: "The latest Scout Agent operation failed.",
    }[agent.status] ?? "Scout Agent has not sent a sample yet."
  );
}
