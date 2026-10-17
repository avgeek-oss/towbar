"use client";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  Edit02Icon,
  FloppyDiskIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Link01Icon,
  ReloadIcon,
  Unlink01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { Field, FieldLabel } from "@avgeek-oss/design-system/forms/field";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { RelativeTime } from "./last-synced-time";
import { ActionButton } from "./page-parts";
import { useApiQuery, refreshApiQueries } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { SourceBranchSelect } from "./source-branch-select";
import { formatDate } from "./dashboard-overview";
import { EnvironmentChip } from "./environment-chip";

export type SourceEnvironment = {
  id: string;
  name: string;
  branch: string;
  mappingRevision: string;
  previewsEnabled: boolean;
  latestSyncStatus: "never" | "queued" | "running" | "succeeded" | "failed";
  latestSyncFinishedAt: string | null;
  latestSuccessfulSyncId: string | null;
  disconnectedAt: string | null;
};

export function SourceEnvironments({
  sourceId,
  canManage,
  branches,
}: {
  sourceId: string;
  canManage: boolean;
  branches: string[];
}) {
  const endpoint = `/v1/core/sources/${sourceId}/environments`;
  const query = useApiQuery<{ environments: SourceEnvironment[] }>(
    endpoint,
    5000,
  );
  const [editing, setEditing] = useState<SourceEnvironment | null>(null);
  const [branch, setBranch] = useState("");
  const releaseDraft = useUnsavedChanges(
    Boolean(editing && branch !== editing.branch),
  );
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (query.error && !query.data) return <QueryError message={query.error} />;
  if (!query.data) return <QueryLoading />;
  return (
    <div className="content-grid">
      <ResourceTable
        ariaLabel="Repository environments"
        items={query.data.environments}
        getRowKey={(item) => item.id}
        emptyTitle="No environments connected"
        emptyDescription="Connect an environment declared in towbar.yml to start syncing."
        columns={[
          {
            key: "name",
            header: "Environment",
            cell: (item) => <EnvironmentChip name={item.name} />,
          },
          {
            key: "configuration",
            header: "Last result",
            cell: (item) => (
              <StatusBadge
                status={
                  item.disconnectedAt
                    ? "disconnected"
                    : item.latestSyncStatus === "never"
                      ? "pending"
                      : item.latestSyncStatus
                }
                label={
                  item.disconnectedAt
                    ? "Disconnected"
                    : item.latestSyncStatus === "never"
                      ? "Not synced"
                      : item.latestSyncStatus === "succeeded"
                        ? "Succeeded"
                        : undefined
                }
                tooltip={sourceEnvironmentStatusTooltip(item)}
              />
            ),
          },
          {
            key: "branch",
            header: "Branch",
            cell: (item) => (
              <span className="inline-flex items-center gap-1.5">
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  aria-hidden="true"
                  className="size-[1em] shrink-0 text-muted"
                />
                <TypographyCode className="rounded-none bg-transparent p-0">
                  {item.branch}
                </TypographyCode>
              </span>
            ),
          },
          {
            key: "previews",
            header: "PR previews",
            cell: (item) =>
              item.previewsEnabled && !item.disconnectedAt ? (
                <TooltipText
                  className="inline-flex"
                  tooltip={`Pull requests targeting ${item.name} can create preview deployments.`}
                >
                  <Chip color="success">
                    <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
                      {<HugeiconsIcon icon={GitPullRequestIcon} />}
                      Enabled
                    </Chip.Label>
                  </Chip>
                </TooltipText>
              ) : (
                <StatusBadge status="disabled" />
              ),
          },
          {
            key: "lastSynced",
            header: "Last sync",
            cell: (item) =>
              item.latestSyncFinishedAt ? (
                <RelativeTime
                  label="Last sync"
                  value={item.latestSyncFinishedAt}
                />
              ) : (
                "—"
              ),
          },
          {
            key: "actions",
            header: "Actions",
            headerClassName: "text-end",
            className: "min-w-52 whitespace-nowrap text-end",
            cell: (item) =>
              canManage && !item.disconnectedAt ? (
                <div className="flex flex-nowrap justify-end gap-2">
                  <ActionButton
                    action={() => api.post(`${endpoint}/${item.id}/syncs`)}
                    confirm={{
                      title: `Sync ${item.name} now?`,
                      actionLabel: "Sync",
                      description: `Towbar will sync configuration from ${item.branch} and queue eligible automatic deployments.`,
                    }}
                    success={`${item.name} sync queued`}
                    pendingLabel="Queueing…"
                  >
                    <HugeiconsIcon icon={ReloadIcon} aria-hidden="true" />
                    Sync
                  </ActionButton>
                  <Button
                    aria-label={`Edit ${item.name} branch`}
                    variant="secondary"
                    onPress={() => {
                      setSaveError(null);
                      setEditing(item);
                      setBranch(item.branch);
                    }}
                  >
                    <HugeiconsIcon icon={Edit02Icon} aria-hidden="true" />
                    <span className="hidden 2xl:inline">Edit branch</span>
                  </Button>
                  <ActionButton
                    action={() =>
                      api.delete(`${endpoint}/${item.id}`, {
                        expectedRevision: item.mappingRevision,
                      })
                    }
                    confirm={{
                      title: `Disconnect ${item.name}?`,
                      actionLabel: "Disconnect environment",
                      description:
                        "This stops synchronization and automatic deployments for this environment. Running workloads, stored secrets, deployment history and resource data are preserved.",
                    }}
                    pendingLabel="Disconnecting…"
                    success={`${item.name} disconnected`}
                    variant="danger"
                    aria-label={`Disconnect ${item.name}`}
                  >
                    <HugeiconsIcon icon={Unlink01Icon} aria-hidden="true" />
                    <span className="hidden 2xl:inline">Disconnect</span>
                  </ActionButton>
                </div>
              ) : canManage && item.disconnectedAt ? (
                <div className="flex justify-end">
                  <ActionButton
                    action={() =>
                      api.post(endpoint, {
                        environment: item.name,
                        branch: item.branch,
                      })
                    }
                    confirm={{
                      title: `Reconnect ${item.name}?`,
                      actionLabel: "Reconnect environment",
                      description: `Towbar will validate and sync ${item.branch} without deploying. Existing secrets and workload data are retained.`,
                    }}
                    pendingLabel="Reconnecting…"
                    success={`${item.name} reconnected; sync queued`}
                  >
                    <HugeiconsIcon icon={Link01Icon} aria-hidden="true" />
                    Reconnect
                  </ActionButton>
                </div>
              ) : null,
          },
        ]}
      />
      <Modal.Backdrop
        isOpen={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEditing(null);
            setSaveError(null);
          }
        }}
      >
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Edit {editing?.name} branch</Modal.Heading>
              <Modal.CloseTrigger isDisabled={busy} />
            </Modal.Header>
            <Modal.Body>
              <form
                className="content-grid"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!editing) return;
                  setSaveError(null);
                  setBusy(true);
                  try {
                    await api.patch(`${endpoint}/${editing.id}`, {
                      branch: branch.trim(),
                      expectedRevision: editing.mappingRevision,
                    });
                    releaseDraft();
                    toast.success("Branch saved; sync queued");
                    setEditing(null);
                    refreshApiQueries();
                  } catch (failure) {
                    setSaveError(
                      failure instanceof Error
                        ? failure.message
                        : "Couldn't save branch",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Field className="gap-3">
                  <FieldLabel htmlFor="edit-environment-branch" isRequired>
                    Deployment branch
                  </FieldLabel>
                  <SourceBranchSelect
                    ariaLabel={`${editing?.name ?? "Environment"} branch`}
                    branches={branches}
                    required
                    triggerId="edit-environment-branch"
                    value={branch}
                    onChange={(nextBranch) => {
                      setBranch(nextBranch);
                      setSaveError(null);
                    }}
                  />
                  {saveError ? (
                    <p
                      id="environment-branch-error"
                      role="alert"
                      className="text-sm text-danger"
                    >
                      {saveError}
                    </p>
                  ) : null}
                </Field>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    onPress={() => setEditing(null)}
                    isDisabled={busy}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" isDisabled={busy || !branch.trim()}>
                    <HugeiconsIcon
                      icon={FloppyDiskIcon}
                      aria-hidden="true"
                      className="size-4"
                    />
                    {busy ? "Saving…" : "Save and sync"}
                  </Button>
                </div>
              </form>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}

function sourceEnvironmentStatusTooltip(item: SourceEnvironment) {
  if (item.disconnectedAt)
    return `Disconnected ${formatDate(item.disconnectedAt)}. New repository changes will not sync.`;
  if (item.latestSyncStatus === "never")
    return "This environment has not completed its first repository sync.";
  const description =
    item.latestSyncStatus === "succeeded"
      ? "The latest repository sync completed successfully."
      : item.latestSyncStatus === "failed"
        ? "The latest repository sync failed."
        : item.latestSyncStatus === "running"
          ? "The latest repository sync is in progress."
          : "The latest repository sync is waiting for a worker.";
  return item.latestSyncFinishedAt
    ? `${description} Finished ${formatDate(item.latestSyncFinishedAt)}.`
    : description;
}
