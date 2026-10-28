"use client";

import { useRouter } from "@/hooks/use-guarded-router";
import { useEffect, useState } from "react";

import type { Server, ServerPreparation } from "@workspace/towbar-web-client";
import { Accordion } from "@avgeek-oss/design-system/data-display/accordion";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { cn } from "@avgeek-oss/design-system/lib/utils";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import {
  preparationChecklist,
  preparationGroups,
  type PreparationChecklist,
} from "@/lib/server-preparation-checklist";
import { shouldShowServerPreparation } from "@/lib/server-preparation-visibility";
import { api } from "@/lib/api";
import { ActionButton } from "./page-parts";
import { useAccess } from "./access-context";
import { ConfigurationLinks } from "./configuration-links";
import { ElapsedTime } from "./elapsed-time";
import { ProgressChecklistItem } from "./progress-checklist";

export type ServerPreparationProps = {
  credentialsPending: boolean;
  item: Server;
  latestPreparation: ServerPreparation | undefined;
  serverId: string;
  setupStatus: Server["setupStatus"];
};

export function PrepareServerButton(
  props: ServerPreparationProps & {
    onQueued?: (preparationId: string) => void;
  },
) {
  const { can } = useAccess();
  const router = useRouter();
  if (!can("server.prepare") || props.setupStatus === "ready") return null;
  const busy = props.setupStatus === "preparing";
  const actionLabel =
    props.setupStatus === "failed" ? "Retry setup" : "Resume Setup";
  const button = (
    <ActionButton<{ preparation: ServerPreparation }>
      action={() =>
        api.post(`/v1/core/servers/${props.serverId}/actions/prepare`)
      }
      confirm={{
        actionLabel,
        description:
          "Towbar will connect with the trusted SSH host key, install or validate Docker Engine, Caddy, and Python, enable the OTEL Logs Collector when ClickHouse is configured, then verify the host. Existing conflicting services are not removed automatically.",
        title:
          props.setupStatus === "failed"
            ? "Retry server setup?"
            : "Resume server setup?",
      }}
      isDisabled={
        Boolean(props.item.archivedAt) || busy || props.credentialsPending
      }
      onSuccess={({ preparation }) => {
        props.onQueued?.(preparation.id);
        router.push(`/servers/${props.serverId}/preparation`);
      }}
      pendingLabel="Queueing…"
      success="Server setup queued"
      variant="primary"
    >
      {busy ? "Setting up server" : actionLabel}
    </ActionButton>
  );
  return props.credentialsPending && !busy ? (
    <TooltipText
      className="inline-flex"
      tooltip="Update the server credentials and trust its host key to continue."
    >
      {button}
    </TooltipText>
  ) : (
    button
  );
}

export function ServerPreparationOverview(props: ServerPreparationProps) {
  const { can } = useAccess();
  if (
    !shouldShowServerPreparation({
      latestPreparation: props.latestPreparation,
      setupStatus: props.setupStatus,
    })
  )
    return null;
  const model = preparationChecklist(
    props.latestPreparation,
    props.setupStatus,
  );
  return (
    <Widget>
      <Widget.Header
        endContent={
          <StatusBadge
            status={model.preparation?.status ?? props.setupStatus}
          />
        }
      >
        <Widget.Title>Server setup</Widget.Title>
      </Widget.Header>
      <Widget.Content className="p-2">
        <Accordion
          allowsMultipleExpanded
          hideSeparator
          className="grid gap-2"
          aria-label="Server setup checklist"
        >
          <ProgressChecklistItem
            id="ssh-key"
            title="Connect SSH key"
            description="Connect a stored private key and trust the server’s host key."
            status={props.credentialsPending ? "waiting" : "succeeded"}
            href={
              can("server.credentials")
                ? `/servers/${props.serverId}/settings/configuration`
                : undefined
            }
          >
            <p className="text-sm text-muted">
              A stored SSH private key is connected to this server and its host
              key is trusted.
            </p>
          </ProgressChecklistItem>
          <ProgressChecklistItem
            id="prepare-server"
            title="Set up server"
            description="Install and verify the services needed for deployments."
            status={props.setupStatus === "failed" ? "failed" : "waiting"}
            href={`/servers/${props.serverId}/preparation`}
          >
            <p className="text-sm break-words text-danger-soft-foreground">
              {model.preparation?.errorMessage ??
                "Setup stopped before the server was ready. Review the steps in Server Setup for details."}
            </p>
          </ProgressChecklistItem>
        </Accordion>
      </Widget.Content>
    </Widget>
  );
}

export function ServerPreparationChecklist(
  props: ServerPreparationProps & { redirectingToOverview: boolean },
) {
  const model = preparationChecklist(
    props.latestPreparation,
    props.setupStatus,
  );
  return (
    <div className="grid gap-6">
      {props.redirectingToOverview ? <PreparationCompleteAlert /> : null}
      {model.historyUnavailable ? (
        <p className="text-sm text-muted">
          Detailed step history is unavailable for this server.
        </p>
      ) : null}
      {model.preparation?.status === "failed" &&
      model.preparation.errorMessage ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Server setup stopped</Alert.Title>
            <Alert.Description>
              {model.preparation.errorMessage}
              <ConfigurationLinks serverId={props.serverId} />
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {preparationGroups.map((group) => {
        const steps = model.steps.filter((step) => step.group === group.id);
        const completed = steps.filter(
          (step) => step.status === "succeeded",
        ).length;
        return (
          <Widget key={group.id}>
            <Widget.Header
              endContent={
                model.historyUnavailable ? undefined : (
                  <span className="shrink-0 text-xs text-muted tabular-nums">
                    {completed} of {steps.length} completed
                  </span>
                )
              }
            >
              <Widget.Title>{group.title}</Widget.Title>
            </Widget.Header>
            <Widget.Content className="p-2">
              <Accordion
                allowsMultipleExpanded
                hideSeparator
                className="grid gap-2"
                aria-label={group.title}
              >
                {steps.map((step) => (
                  <PreparationStep
                    key={`${model.preparation?.id ?? "pending"}:${step.id}`}
                    step={step}
                    model={model}
                  />
                ))}
              </Accordion>
            </Widget.Content>
          </Widget>
        );
      })}
    </div>
  );
}

function PreparationCompleteAlert() {
  const [seconds, setSeconds] = useState(5);

  useEffect(() => {
    const timer = window.setInterval(
      () => setSeconds((current) => Math.max(1, current - 1)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <Alert status="success">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>Server setup complete</Alert.Title>
        <Alert.Description>
          The first server check is scheduled. Opening Overview in{" "}
          <span className="tabular-nums">{seconds}</span>{" "}
          {seconds === 1 ? "second" : "seconds"}.
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

function PreparationStep({
  step,
  model,
}: {
  step: PreparationChecklist["steps"][number];
  model: PreparationChecklist;
}) {
  const failed = step.status === "failed";
  const running =
    step.status === "running" && model.preparation?.status === "running";
  const completed = step.status === "succeeded";
  const details =
    step.message ??
    (model.historyUnavailable
      ? "No step details were recorded."
      : completed
        ? "No further details were recorded for this step."
        : failed
          ? "This step failed. Review the setup error before retrying."
          : running
            ? "This step is in progress. Details update automatically."
            : model.preparation?.status === "failed"
              ? "This step did not run because setup stopped."
              : model.preparation
                ? "Waiting for setup to reach this step."
                : "This step runs when server setup starts.");
  return (
    <ProgressChecklistItem
      id={step.id}
      title={step.title}
      description={step.description}
      runningTone="warning"
      status={
        completed
          ? "succeeded"
          : failed
            ? "failed"
            : running
              ? "running"
              : "waiting"
      }
    >
      <p
        className={cn(
          "text-sm break-words",
          failed ? "text-danger-soft-foreground" : "text-muted",
        )}
      >
        {details}
      </p>
      {step.log ? (
        <div className="grid min-w-0 gap-2">
          <p className="text-xs text-muted">Terminal output</p>
          <pre
            aria-label={`${step.title} terminal output`}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A scrollable region must be reachable by keyboard so its overflow can be scrolled (WCAG 2.1.1).
            tabIndex={0}
            className="max-h-80 overflow-auto rounded-lg bg-default p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground"
          >
            {step.log}
          </pre>
          {step.logTruncated ? (
            <p className="text-sm text-muted">
              Earlier output was trimmed. Showing the most recent terminal
              output.
            </p>
          ) : null}
        </div>
      ) : completed && !model.historyUnavailable ? (
        <p className="text-sm text-muted">
          Terminal output was not recorded for this run.
        </p>
      ) : null}
      {step.startedAt ? (
        <p className="text-xs text-muted">
          Duration:{" "}
          <ElapsedTime
            startedAt={step.startedAt}
            finishedAt={
              step.finishedAt ?? model.preparation?.finishedAt ?? null
            }
            status={running ? "running" : "succeeded"}
          />
        </p>
      ) : null}
    </ProgressChecklistItem>
  );
}
