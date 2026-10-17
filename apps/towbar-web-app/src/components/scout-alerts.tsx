"use client";
import { useQueryChoice } from "@/hooks/use-page-query";
import { useUrlCursorPagination } from "@/hooks/use-url-pagination";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  TableCellStack,
  TableCellDescription,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import { SCOUT_ALERT_RULE_LIMIT_PER_ENTITY } from "@workspace/towbar-contracts/scout-alerts";
import { Alert02Icon, AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ScoutIcon } from "./scout-icons";
import { useState } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { ActionButton } from "./page-parts";
import { formatDate } from "./dashboard-overview";
import { ScoutRuleEditor } from "./scout-rule-editor";
import {
  ScoutSelect,
  conditionDescription,
  scoutValue,
  type ScoutRule,
  type ScoutIncident,
  type ScoutRulesResponse,
} from "./scout-controls";
import { ScoutIncidentDrawer } from "./scout-incident-drawer";
import {
  ScoutIncidentSeverityChip,
  ScoutIncidentStateChip,
} from "./scout-incident-chips";
import { PageSelectionTitle } from "./page-selection-title";

export function ScoutAlerts({
  serverId,
  deployableId,
  view,
}: {
  serverId: string;
  deployableId?: string;
  view: "alerts" | "incidents";
}) {
  const endpoint = `/v1/core/servers/${serverId}/scout-alerts`;
  const entity = deployableId ?? "server";
  const query = useApiQuery<ScoutRulesResponse>(
    `${endpoint}?deployableId=${entity}`,
    30_000,
  );
  const [selectedIncident, setSelectedIncident] =
    useState<ScoutIncident | null>(null);
  const [editing, setEditing] = useState<ScoutRule | "new" | null>(null);
  const [state, setState] = useQueryChoice(
    "state",
    ["active", "resolved", "all"],
    "active",
  );
  const pagination = useUrlCursorPagination();
  const cursor = pagination.suffix;
  const incidents = useApiQuery<{
    incidents: ScoutIncident[];
    nextBefore: string | null;
    nextBeforeId: string | null;
  }>(
    `${endpoint}/incidents?state=${state}&limit=10&deployableId=${entity}${cursor}`,
    30_000,
    { keepPreviousData: true },
  );
  const refresh = () => {
    query.refresh();
    incidents.refresh();
  };
  const incidentTitle =
    view === "incidents" ? (
      <PageSelectionTitle
        label="Incidents"
        icon={<HugeiconsIcon icon={AlertCircleIcon} />}
        keepEntityName
        actions={
          <div className="w-44">
            <ScoutSelect
              label="Incident status"
              hideLabel
              value={state}
              onChange={(value) => {
                setState(value);
                pagination.reset();
              }}
              options={[
                { id: "active", label: "Active" },
                { id: "resolved", label: "Resolved" },
                { id: "all", label: "All incidents" },
              ]}
            />
          </div>
        }
      />
    ) : null;
  if (!query.data)
    return (
      <>
        {view === "alerts" ? (
          <PageSelectionTitle
            label="Alerts"
            icon={<HugeiconsIcon icon={Alert02Icon} />}
            keepEntityName
          />
        ) : null}
        {incidentTitle}
        <Widget>
          <Widget.Content className="min-h-64">
            {query.error ? (
              <QueryError message={query.error} />
            ) : (
              <QueryLoading />
            )}
          </Widget.Content>
        </Widget>
      </>
    );
  const data = query.data;
  const rules = data.rules.filter(
    (r) => r.deployableId === (deployableId ?? null),
  );
  const entityLabel = deployableId
    ? data.workloads.find((workload) => workload.id === deployableId)?.kind ===
      "app"
      ? "app"
      : "resource"
    : "server";
  const ruleLimitReached = rules.length >= SCOUT_ALERT_RULE_LIMIT_PER_ENTITY;
  const columns: ResourceTableColumn<ScoutRule>[] = [
    {
      key: "name",
      header: "Rule",
      cell: (r) => (
        <TableCellStack as="div">
          <span>{r.name}</span>
          <TableCellDescription>
            {conditionDescription(r.condition)}
          </TableCellDescription>
        </TableCellStack>
      ),
      className: "min-w-72",
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <TooltipText className="inline-flex" tooltip={ruleStatusTooltip(r)}>
          <Chip
            size="sm"
            color={
              !r.enabled
                ? "default"
                : r.evaluationState === "firing"
                  ? r.severity === "critical"
                    ? "danger"
                    : "warning"
                  : r.evaluationState === "healthy"
                    ? "success"
                    : r.evaluationState === "error"
                      ? "danger"
                      : r.evaluationState === "pending"
                        ? "warning"
                        : "default"
            }
          >
            <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
              {
                <ScoutIcon
                  name={
                    !r.enabled
                      ? "paused"
                      : r.evaluationState === "healthy"
                        ? "resolved"
                        : r.evaluationState === "firing"
                          ? r.severity === "critical"
                            ? "critical"
                            : "warning"
                          : r.evaluationState === "error"
                            ? "critical"
                            : "time"
                  }
                />
              }
              {!r.enabled
                ? "Paused"
                : ({
                    healthy: "Healthy",
                    firing: "Alerting",
                    pending: "Evaluating",
                    unknown: "No recent data",
                    inactive: "Scout inactive",
                    error: "Evaluation error",
                  }[r.evaluationState] ?? "Evaluating")}
            </Chip.Label>
          </Chip>
        </TooltipText>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      cell: (r) => (
        <TooltipText
          className="inline-flex"
          tooltip={
            r.severity === "critical"
              ? "A firing rule creates a critical incident and uses urgent notification styling."
              : "A firing rule creates a warning incident."
          }
        >
          <Chip
            size="sm"
            color={r.severity === "critical" ? "danger" : "warning"}
          >
            <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
              {
                <ScoutIcon
                  name={r.severity === "critical" ? "critical" : "warning"}
                />
              }
              {r.severity === "critical" ? "Critical" : "Warning"}
            </Chip.Label>
          </Chip>
        </TooltipText>
      ),
    },
    {
      key: "reading",
      header: "Latest reading",
      cell: (r) => (
        <TableCellStack className="tabular-nums">
          {scoutValue(r.observedValue, r.condition.metric)}
          {r.httpCheck ? (
            <TableCellDescription className="block">
              {r.httpCheck.reason ??
                (r.httpCheck.status_code
                  ? `HTTP ${r.httpCheck.status_code} · ${r.httpCheck.latency_ms} ms`
                  : "Checking…")}
            </TableCellDescription>
          ) : null}
        </TableCellStack>
      ),
    },
    {
      key: "actions",
      header: "",
      cell: (r) =>
        data.canManage ? (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onPress={() => setEditing(r)}>
              <ScoutIcon name="edit" />
              Edit
            </Button>
            <ActionButton
              variant="secondary"
              action={() =>
                api.put(`${endpoint}/rules/${r.id}`, {
                  name: r.name,
                  enabled: !r.enabled,
                  severity: r.severity,
                  deployableId: r.deployableId,
                  condition: r.condition,
                })
              }
              onSuccess={refresh}
              success={r.enabled ? "Rule paused" : "Rule resumed"}
            >
              <ScoutIcon name={r.enabled ? "paused" : "running"} />
              {r.enabled ? "Pause" : "Resume"}
            </ActionButton>
            <ActionButton
              variant="danger"
              action={() => api.delete(`${endpoint}/rules/${r.id}`)}
              onSuccess={refresh}
              confirm={{
                title: `Delete ${r.name}?`,
                description:
                  "Stops this rule. Existing incidents remain in history.",
                actionLabel: "Delete rule",
              }}
              success="Rule deleted"
            >
              <ScoutIcon name="delete" />
              Delete
            </ActionButton>
          </div>
        ) : null,
    },
  ];
  const incidentColumns: ResourceTableColumn<ScoutIncident>[] = [
    {
      key: "rule",
      header: "Incident",
      cell: (i) => (
        <TableCellStack as="div">
          <span>{i.ruleName}</span>
          <TableCellDescription>
            {conditionDescription(i.condition)}
          </TableCellDescription>
        </TableCellStack>
      ),
      className: "min-w-64",
    },
    {
      key: "state",
      header: "State",
      cell: (i) => <ScoutIncidentStateChip incident={i} />,
    },
    {
      key: "severity",
      header: "Severity",
      cell: (i) => <ScoutIncidentSeverityChip severity={i.severity} />,
    },
    { key: "started", header: "Started", cell: (i) => formatDate(i.openedAt) },
    {
      key: "resolved",
      header: "Ended",
      cell: (i) =>
        i.resolvedAt ? (
          <TableCellStack as="div">
            <span>{formatDate(i.resolvedAt)}</span>
            <TableCellDescription>
              {i.resolutionReason?.replaceAll("_", " ")}
            </TableCellDescription>
          </TableCellStack>
        ) : (
          "Ongoing"
        ),
    },
    {
      key: "reading",
      header: "Reading",
      cell: (i) => scoutValue(i.lastValue, i.condition.metric),
    },
    {
      key: "graph",
      header: "",
      cell: (incident) => (
        <Button
          variant="secondary"
          onPress={() => setSelectedIncident(incident)}
        >
          <ScoutIcon name="view" />
          View Incident
        </Button>
      ),
    },
  ];
  return (
    <div className="grid min-w-0 gap-8">
      {view === "alerts" ? (
        <section className="grid min-w-0 gap-4" aria-label="Alert rules">
          <PageSelectionTitle
            label="Alerts"
            icon={<HugeiconsIcon icon={Alert02Icon} />}
            keepEntityName
            actions={
              data.canManage ? (
                <Button
                  isDisabled={ruleLimitReached}
                  aria-describedby={
                    ruleLimitReached ? "scout-rule-limit" : undefined
                  }
                  onPress={() => setEditing("new")}
                >
                  <ScoutIcon name="add" />
                  Create rule
                </Button>
              ) : undefined
            }
          />
          {data.canManage && ruleLimitReached ? (
            <p
              id="scout-rule-limit"
              role="status"
              className="text-sm text-muted"
            >
              This {entityLabel} has reached the limit of{" "}
              {SCOUT_ALERT_RULE_LIMIT_PER_ENTITY} alert rules. Delete a rule to
              create another.
            </p>
          ) : null}
          {query.error ? <QueryError message={query.error} /> : null}
          <ResourceTable
            ariaLabel="Scout alert rules"
            columns={columns}
            getRowKey={(r) => r.id}
            items={rules}
            emptyTitle="No alert rules yet"
            emptyDescription="Create a rule with a metric and threshold. New rules start active and can be paused at any time."
          />
        </section>
      ) : null}
      {view === "incidents" ? (
        <section className="grid min-w-0 gap-4" aria-label="Scout incidents">
          {incidentTitle}
          {incidents.error ? <QueryError message={incidents.error} /> : null}
          {incidents.data ? (
            <ResourceTable
              ariaLabel="Scout incidents"
              columns={incidentColumns}
              getRowKey={(i) => i.id}
              items={incidents.data.incidents}
              emptyTitle={
                state === "active"
                  ? "No active incidents"
                  : "No incidents in this view"
              }
              emptyDescription={
                state === "active"
                  ? "Incidents appear here when an active rule meets its alert condition."
                  : "History follows this server’s Scout retention setting."
              }
            />
          ) : (
            <QueryLoading />
          )}
          <div className="flex items-center justify-end gap-3">
            <span className="text-sm text-muted">Page {pagination.page}</span>
            <Button
              variant="secondary"
              isDisabled={pagination.page === 1 || incidents.isPreviousData}
              onPress={pagination.previous}
            >
              <ScoutIcon name="previous" />
              {pagination.previousLabel}
            </Button>
            <Button
              variant="secondary"
              isDisabled={
                !incidents.data?.nextBefore || incidents.isPreviousData
              }
              onPress={() =>
                pagination.next({
                  before: incidents.data!.nextBefore!,
                  beforeId: incidents.data!.nextBeforeId!,
                })
              }
            >
              <ScoutIcon name="next" />
              Next
            </Button>
          </div>
        </section>
      ) : null}
      {view === "incidents" && selectedIncident ? (
        <ScoutIncidentDrawer
          serverId={serverId}
          incident={selectedIncident}
          onClose={() => setSelectedIncident(null)}
        />
      ) : null}
      {view === "alerts" && editing ? (
        <ScoutRuleEditor
          serverId={serverId}
          initial={editing === "new" ? undefined : editing}
          analytics={
            data.workloads.find((workload) => workload.id === deployableId)
              ?.analytics
          }
          deployableId={deployableId}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

function ruleStatusTooltip(rule: ScoutRule) {
  const evaluated = rule.evaluatedAt
    ? ` Last evaluated ${formatDate(rule.evaluatedAt)}.`
    : "";
  if (!rule.enabled) return "This rule is paused and is not being evaluated.";
  const description =
    {
      healthy: "The latest reading is within the configured threshold.",
      firing: "The latest reading meets the alert condition.",
      pending: "Towbar is waiting for enough readings to evaluate this rule.",
      unknown: "No recent measurement is available for this rule.",
      inactive: "Scout is not reporting for this rule's target.",
      error: "The latest rule evaluation failed.",
    }[rule.evaluationState] ?? "Towbar is evaluating this rule.";
  return `${description}${evaluated}`;
}
