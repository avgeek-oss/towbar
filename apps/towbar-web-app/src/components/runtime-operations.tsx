"use client";
import { useAccess } from "./access-context";
import {
  MoreHorizontalIcon,
  PlayIcon,
  ReloadIcon,
  SourceCodeIcon,
  BanIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";

import { ElapsedTime } from "./elapsed-time";

import { ConfigurationLinks } from "./configuration-links";

import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "@/hooks/use-guarded-router";
import { useState } from "react";
import type {
  Deployment,
  ResourceOperation,
  RuntimeState,
} from "@workspace/towbar-web-client";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { Label } from "@avgeek-oss/design-system/forms/label";
import { ListBox, Select } from "@avgeek-oss/design-system/forms/select";
import { AlertDialog } from "@avgeek-oss/design-system/overlays/alert-dialog";
import { Dropdown } from "@avgeek-oss/design-system/overlays/dropdown";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { CodePanel } from "@workspace/towbar-web-ui/code-panel";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";

import { ActionButton } from "@/components/page-parts";
import { refreshApiQueries, useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { deploymentHref } from "@/lib/deployment-route";
import { formatDate } from "./dashboard-overview";

type DeployableType = "app" | "resource";
type DeployableAction = "restart" | "rollback" | "start" | "stop";
const ingressRuntimeTarget = "__towbar_ingress__";

export function DeployableActionsMenu({
  active,
  deployableId,
  previousReleaseId,
  runtimeState,
  services = [],
  type,
}: {
  active: boolean;
  deployableId: string;
  previousReleaseId?: string;
  runtimeState: RuntimeState;
  services?: string[];
  type: DeployableType;
}) {
  const router = useRouter();
  const { can } = useAccess();
  const [selectedAction, setSelectedAction] = useState<DeployableAction | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [service, setService] = useState("");
  const path = type === "app" ? "apps" : "resources";
  const actions: DeployableAction[] = [
    "start",
    ...(runtimeState.observedState !== "stopped"
      ? (["restart", "stop"] as const)
      : []),
    ...(previousReleaseId ? (["rollback"] as const) : []),
  ];
  const selection = selectedAction
    ? getDeployableActionDetails(selectedAction, type)
    : null;

  async function runAction() {
    if (!selectedAction || !selection) return;
    setBusy(true);
    try {
      if (selectedAction === "rollback") {
        const result = await api.post<{ deployment: Deployment }>(
          `/v1/core/${path}/${deployableId}/actions/rollback`,
          { releaseId: previousReleaseId },
          { "Idempotency-Key": crypto.randomUUID() },
        );
        router.push(deploymentHref(result.deployment));
      } else {
        await api.post(
          `/v1/core/${path}/${deployableId}/actions/${selectedAction}`,
          { service: service || undefined },
          { "Idempotency-Key": crypto.randomUUID() },
        );
      }
      toast.success(selection.success);
      refreshApiQueries();
      setSelectedAction(null);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  if (!can("admin")) return null;
  return (
    <>
      <Dropdown>
        <Button
          aria-label={`More ${type} actions`}
          isDisabled={!active}
          isIconOnly
          variant="secondary"
        >
          <HugeiconsIcon aria-hidden="true" icon={MoreHorizontalIcon} />
        </Button>
        <Dropdown.Popover className="min-w-48">
          <Dropdown.Menu
            aria-label={`${type === "app" ? "Service" : "Datastore"} actions`}
            onAction={(key) =>
              setSelectedAction(String(key) as DeployableAction)
            }
          >
            {actions.map((action) => {
              const details = getDeployableActionDetails(action, type);
              return (
                <Dropdown.Item
                  id={action}
                  key={action}
                  textValue={details.label}
                  variant={details.danger ? "danger" : undefined}
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    className={
                      details.danger
                        ? "size-4 shrink-0 text-danger"
                        : "size-4 shrink-0 text-muted"
                    }
                    icon={actionIcon(action)}
                  />
                  <Label>{details.label}</Label>
                </Dropdown.Item>
              );
            })}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <AlertDialog.Backdrop
        isOpen={Boolean(selection)}
        onOpenChange={(open) => {
          if (!open && !busy) setSelectedAction(null);
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon
                status={selection?.danger ? "danger" : "accent"}
              />
              <AlertDialog.Heading>{selection?.title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="content-grid">
                <p>{selection?.description}</p>
                {services.length ? (
                  <RuntimeScopeSelect
                    services={services}
                    value={service}
                    onChange={setService}
                  />
                ) : null}
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                isDisabled={busy}
                variant="secondary"
                onPress={() => setSelectedAction(null)}
              >
                Cancel
              </Button>
              <Button
                isDisabled={busy}
                variant={selection?.danger ? "danger" : "primary"}
                onPress={runAction}
              >
                {busy ? selection?.pendingLabel : selection?.label}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}

function getDeployableActionDetails(
  action: DeployableAction,
  type: DeployableType,
) {
  switch (action) {
    case "start":
      return {
        danger: false,
        description:
          "Towbar will start the container using its current deployed configuration.",
        label: `Start ${type}`,
        pendingLabel: "Queueing start…",
        success: "Start queued",
        title: `Start this ${type}?`,
      };
    case "restart":
      return {
        danger: false,
        description:
          "Towbar will briefly interrupt the running container and start it again using its current deployed configuration.",
        label: `Restart ${type}`,
        pendingLabel: "Queueing restart…",
        success: "Restart queued",
        title: `Restart this ${type}?`,
      };
    case "stop":
      return {
        danger: true,
        description:
          "Towbar will stop the running container. It stays stopped until Start, Restart, or a new deployment succeeds.",
        label: `Stop ${type}`,
        pendingLabel: "Stopping…",
        success: "Stop queued",
        title: `Stop this ${type}?`,
      };
    case "rollback":
      return {
        danger: false,
        description:
          type === "app"
            ? "Towbar will check the retained image, routing, TLS, and public endpoint before switching traffic."
            : "Towbar will stop the current container, start the retained image against the same persistent volumes, and restore the current release if validation fails.",
        label: `Roll back ${type}`,
        pendingLabel: "Queueing rollback…",
        success: "Rollback queued",
        title: `Roll back this ${type}?`,
      };
  }
}

function actionIcon(action: DeployableAction) {
  switch (action) {
    case "start":
      return PlayIcon;
    case "restart":
      return ReloadIcon;
    case "stop":
      return BanIcon;
    case "rollback":
      return Undo02Icon;
  }
}

export function RuntimeLogs({
  active,
  deployableId,
  hasIngress = false,
  services = [],
  type,
}: {
  active: boolean;
  deployableId: string;
  hasIngress?: boolean;
  services?: string[];
  type: DeployableType;
}) {
  const [target, setTarget] = useState("");
  const ingressSelected = target === ingressRuntimeTarget;
  const service = ingressSelected ? "" : target;
  const path = type === "app" ? "apps" : "resources";
  const operations = useApiQuery<{ operations: ResourceOperation[] }>(
    `/v1/core/${path}/${deployableId}/operations`,
    5_000,
  );
  if (operations.error) return <QueryError message={operations.error} />;
  if (!operations.data) return <QueryLoading variant="detail" />;

  const latest = operations.data.operations.find((operation) => {
    if (operation.type !== "capture_logs") return false;
    const runtime =
      typeof operation.request.runtime === "string"
        ? operation.request.runtime
        : "workload";
    if (runtime !== (ingressSelected ? "ingress" : "workload")) return false;
    const selected =
      typeof operation.request.service === "string"
        ? operation.request.service
        : "";
    return selected === service;
  });
  const result = readLogResult(latest?.result);
  const captureLogsButton = active ? (
    <ActionButton
      confirm={{
        title: `Capture ${ingressSelected ? "Cloudflare Tunnel" : "container"} logs?`,
        description: `Queue a server operation to capture the latest 500 log lines from the ${
          ingressSelected ? "managed Cloudflare Tunnel" : "selected workload"
        } runtime.`,
        actionLabel: "Capture logs",
      }}
      action={() =>
        api.post(
          `/v1/core/${path}/${deployableId}/actions/logs`,
          {
            runtime: ingressSelected ? "ingress" : "workload",
            service: service || undefined,
            tail: 500,
          },
          { "Idempotency-Key": crypto.randomUUID() },
        )
      }
      pendingLabel="Queueing…"
      success="Log capture queued"
      variant="primary"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={SourceCodeIcon}
        className="size-4 shrink-0"
      />
      Capture logs
    </ActionButton>
  ) : null;
  const captureControls = (
    <div className="flex flex-wrap items-end gap-3">
      {services.length || hasIngress ? (
        <RuntimeScopeSelect
          hasIngress={hasIngress}
          services={services}
          value={target}
          workloadLabel={
            services.length
              ? "Entire stack"
              : type === "app"
                ? "Service container"
                : "Datastore container"
          }
          onChange={setTarget}
        />
      ) : null}
      {captureLogsButton}
    </div>
  );

  if (!latest) {
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>No logs captured</EmptyState.Title>
          <EmptyState.Description>
            {active
              ? `Capture the latest ${
                  ingressSelected ? "Cloudflare Tunnel" : "container"
                } output when you need to inspect this ${type}.`
              : `Log capture becomes available after the target server is prepared.`}
          </EmptyState.Description>
        </EmptyState.Header>
        {captureLogsButton ? (
          <EmptyState.Content>{captureControls}</EmptyState.Content>
        ) : null}
      </EmptyState>
    );
  }

  return (
    <div className="content-grid">
      {!active ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>New log captures are unavailable</Alert.Title>
            <Alert.Description>
              Prepare the target server before requesting another container log
              capture.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted typography--body-sm">
          Last requested {formatDate(latest.createdAt)}
        </p>
        {captureControls}
      </div>
      {latest.state === "succeeded" ? (
        result?.logs ? (
          <CodePanel
            ariaLabel={`Captured ${ingressSelected ? "Cloudflare Tunnel" : "container"} logs`}
            language="text"
          >
            {result.logs}
          </CodePanel>
        ) : (
          <EmptyState>
            <EmptyState.Header>
              <EmptyState.Title>No log output returned</EmptyState.Title>
              <EmptyState.Description>
                The container produced no output for this capture.
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        )
      ) : (
        <Attributes title="Latest log capture" variant="card">
          <Attributes.Item label="Status">
            <StatusBadge status={latest.state} />
          </Attributes.Item>
          <Attributes.Item label="Requested">
            {formatDate(latest.createdAt)}
          </Attributes.Item>
          <Attributes.Item label="Duration">
            <ElapsedTime {...latest} status={latest.state} />
          </Attributes.Item>
          <Attributes.Item label="Result">
            {latest.errorMessage ?? "Waiting for the worker"}
            {latest.errorMessage ? (
              <ConfigurationLinks serverId={latest.serverId} />
            ) : null}
          </Attributes.Item>
        </Attributes>
      )}
      {result?.truncated ? (
        <p className="text-muted typography--body-sm">
          Output was truncated to the Towbar log limit.
        </p>
      ) : null}
    </div>
  );
}

function RuntimeScopeSelect({
  hasIngress = false,
  onChange,
  services,
  value,
  workloadLabel,
}: {
  hasIngress?: boolean;
  onChange: (value: string) => void;
  services: string[];
  value: string;
  workloadLabel?: string;
}) {
  return (
    <Select
      aria-label="Runtime target"
      className="min-w-52"
      selectedKey={value || "__stack"}
      onSelectionChange={(key) =>
        key !== null && onChange(String(key) === "__stack" ? "" : String(key))
      }
      variant="secondary"
    >
      <Label>Target</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item
            id="__stack"
            textValue={workloadLabel ?? "Entire stack"}
          >
            {workloadLabel ?? "Entire stack"}
          </ListBox.Item>
          {[...new Set(services)].sort().map((service) => (
            <ListBox.Item id={service} key={service} textValue={service}>
              {service}
            </ListBox.Item>
          ))}
          {hasIngress ? (
            <ListBox.Item
              id={ingressRuntimeTarget}
              textValue="Cloudflare Tunnel"
            >
              Cloudflare Tunnel
            </ListBox.Item>
          ) : null}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function readLogResult(result: ResourceOperation["result"] | undefined) {
  if (!result || !("logs" in result) || typeof result.logs !== "string") {
    return null;
  }
  return { logs: result.logs, truncated: result.truncated };
}

export function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1_073_741_824).toFixed(1)} GiB`;
}
