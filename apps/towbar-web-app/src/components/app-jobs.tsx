"use client";

import {
  TableCellStack,
  TableCellDescription,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import { useState } from "react";
import { Clock01Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { CodePanel } from "@workspace/towbar-web-ui/code-panel";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import type { AppJobsResponse, AppJobRun } from "@workspace/towbar-web-client";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { useAccess } from "./access-context";
import { ActionButton } from "./page-parts";
import { formatDate } from "./dashboard-overview";

export function AppJobs({ appId }: { appId: string }) {
  const query = useApiQuery<AppJobsResponse>(
    `/v1/core/apps/${appId}/jobs`,
    5_000,
  );
  const { can } = useAccess();
  const [selected, setSelected] = useState<AppJobRun | null>(null);
  const [open, setOpen] = useState(false);
  if (query.error) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;
  const { jobs, runs, ready, automationPaused } = query.data;
  const displayed = runs.find((run) => run.id === selected?.id) ?? selected;
  return (
    <div className="space-y-6">
      <ResourceTable
        ariaLabel="Scheduled app jobs"
        items={jobs}
        getRowKey={(job) => job.name}
        emptyTitle="No scheduled jobs"
        emptyDescription="Declare jobs in the app manifest to run commands on a schedule."
        columns={[
          {
            key: "name",
            header: "Job",
            cell: (job) => (
              <TableCellStack as="div">
                <span>{job.name}</span>
                {job.description ? (
                  <TableCellDescription>{job.description}</TableCellDescription>
                ) : null}
              </TableCellStack>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (job) => (
              <Chip
                size="sm"
                color={
                  !job.enabled || automationPaused
                    ? "default"
                    : ready
                      ? "success"
                      : "warning"
                }
              >
                <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                  {!job.enabled
                    ? "Disabled"
                    : automationPaused
                      ? "Paused"
                      : ready
                        ? "Enabled"
                        : "Awaiting deployment"}
                </Chip.Label>
              </Chip>
            ),
          },
          {
            key: "schedule",
            header: "Schedule (UTC)",
            cell: (job) => <TypographyCode>{job.schedule.cron}</TypographyCode>,
          },
          {
            key: "timeout",
            header: "Time limit",
            cell: (job) => (
              <span className="tabular-nums">{job.timeoutSeconds}s</span>
            ),
          },
          {
            key: "actions",
            header: "",
            cell: (job) =>
              can("admin") ? (
                <ActionButton
                  variant="secondary"
                  isDisabled={
                    !job.enabled ||
                    !ready ||
                    runs.some(
                      (run) =>
                        run.request.job.name === job.name &&
                        ["queued", "running"].includes(run.state),
                    )
                  }
                  confirm={{
                    title: `Run ${job.name}?`,
                    description:
                      "Run this command using the deployed app image, runtime secrets and persistent storage.",
                    actionLabel: "Run job",
                  }}
                  action={() =>
                    api.post(
                      `/v1/core/apps/${appId}/actions/run-job`,
                      { name: job.name },
                      { "Idempotency-Key": crypto.randomUUID() },
                    )
                  }
                  success="Job queued"
                  pendingLabel="Queueing…"
                >
                  <HugeiconsIcon icon={PlayIcon} aria-hidden="true" />
                  Run now
                </ActionButton>
              ) : null,
          },
        ]}
        footer="Schedules use UTC. Jobs run after deployment; overlapping runs and missed schedules are skipped."
      />
      {jobs.length || runs.length ? (
        <ResourceTable
          ariaLabel="Job run history"
          items={runs}
          getRowKey={(run) => run.id}
          emptyTitle="No job runs yet"
          emptyDescription="Scheduled and manual runs appear here with their status and output."
          columns={[
            { key: "job", header: "Job", cell: (run) => run.request.job.name },
            {
              key: "status",
              header: "Status",
              cell: (run) => <StatusBadge status={run.state} />,
            },
            {
              key: "trigger",
              header: "Trigger",
              cell: (run) => (run.request.scheduledAt ? "Scheduled" : "Manual"),
            },
            {
              key: "time",
              header: "Requested",
              cell: (run) => (
                <span className="tabular-nums">
                  {formatDate(run.createdAt)}
                </span>
              ),
            },
            {
              key: "output",
              header: "",
              cell: (run) => (
                <Button
                  variant="secondary"
                  onPress={() => {
                    setSelected(run);
                    setOpen(true);
                  }}
                >
                  View output
                </Button>
              ),
            },
          ]}
          footer="Showing the latest 100 runs. Failed commands are not retried automatically."
        />
      ) : null}
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>
                <span className="flex items-center gap-2">
                  <HugeiconsIcon icon={Clock01Icon} aria-hidden="true" />
                  {displayed?.request.job.name}
                </span>
              </Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>
              {displayed ? (
                <div className="space-y-4">
                  <StatusBadge status={displayed.state} />
                  {displayed.errorMessage ? (
                    <p className="text-danger">{displayed.errorMessage}</p>
                  ) : null}
                  <CodePanel ariaLabel="Job output">
                    {displayed.result?.logs ||
                      (["queued", "running"].includes(displayed.state)
                        ? "Output is available when the run finishes."
                        : "This run produced no output.")}
                  </CodePanel>
                  {displayed.result?.truncated ? (
                    <p className="text-sm text-muted">
                      Output was truncated to 256 KiB.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}
