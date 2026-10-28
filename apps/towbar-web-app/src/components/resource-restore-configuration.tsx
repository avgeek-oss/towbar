"use client";

import {
  Delete02Icon,
  Shield01Icon,
  BanIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FormEvent } from "react";
import { useState } from "react";
import type {
  BackupAssurance,
  Resource,
  ResourceOperation,
  ResourceOperationEvent,
  RestoreResult,
  SourceBackup,
} from "@workspace/towbar-web-client";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@avgeek-oss/design-system/forms/field";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { ElapsedTime } from "./elapsed-time";
import { ActionButton } from "@/components/page-parts";
import { CloudProviderLogo } from "@/components/cloud-provider-logo";
import { refreshApiQueries, useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { formatDate } from "./dashboard-overview";
import {
  InlineLink,
  RelativeTime,
  formatBackupFormat,
  formatBytes,
  formatEngine,
} from "./resource-backup-configuration";

export function ResourceRestoreConfiguration({
  active,
  resource,
}: {
  active: boolean;
  resource: Resource;
}) {
  const [selectedBackup, setSelectedBackup] = useState<SourceBackup | null>(
    null,
  );
  const backup = resource.config.backup;

  const backups = useApiQuery<{ backups: SourceBackup[] }>(
    `/v1/core/sources/${resource.sourceId}/backups`,
    10_000,
  );
  const assurances = useApiQuery<{
    assurances: BackupAssurance[];
    awsConfigured: boolean;
    canRestore: boolean;
    gcpConfigured?: boolean;
    missingCredentialMessage?: string;
  }>(`/v1/core/resources/${resource.id}/backup-assurance`, 10_000);
  const operations = useApiQuery<{ operations: ResourceOperation[] }>(
    `/v1/core/resources/${resource.id}/operations`,
    5_000,
  );

  if (!backup) {
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>No managed backups configured</EmptyState.Title>
          <EmptyState.Description>
            Database restore requires backup storage configured in the resource
            manifest.
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  }

  const error = backups.error ?? assurances.error ?? operations.error;
  if (error) return <QueryError message={error} />;
  if (!backups.data || !assurances.data || !operations.data) {
    return <QueryLoading />;
  }

  const retainedBackups = backups.data.backups.filter(
    (candidate) => candidate.resourceId === resource.id,
  );
  const restoreOperations = operations.data.operations.filter(
    (operation) =>
      operation.type === "restore" || operation.type === "restore_cleanup",
  );
  const assuranceData = assurances.data;
  const assuranceByBackup = new Map(
    assuranceData.assurances.map((item) => [item.backupOperationId, item]),
  );

  const restoreProvider =
    backup.restoreFrom ?? (backup.s3 ? "s3" : backup.gcs ? "gcs" : "s3");
  const restoreProviderLabel =
    restoreProvider === "gcs" ? "Google Cloud Storage" : "AWS S3";
  const restoreProviderName =
    restoreProvider === "gcs" ? "Google Cloud" : "AWS";
  const restoreProviderConfigured =
    restoreProvider === "gcs"
      ? Boolean(assuranceData.gcpConfigured)
      : Boolean(assuranceData.awsConfigured);

  const restoreLocationUri =
    restoreProvider === "s3" && backup.s3
      ? `s3://${backup.s3.bucket}/${backup.s3.prefix || "towbar"}`
      : restoreProvider === "gcs" && backup.gcs
        ? `gs://${backup.gcs.bucket}/${backup.gcs.prefix || "towbar"}`
        : "Not configured";

  const restoreColumns: ResourceTableColumn<SourceBackup>[] = [
    {
      key: "created",
      header: "Created",
      cell: (item) => (
        <RelativeTime
          label="Created"
          value={item.finishedAt ?? item.createdAt}
        />
      ),
      className: "min-w-48 whitespace-nowrap tabular-nums",
    },
    {
      key: "assurance",
      header: "Restore assurance",
      cell: (item) => (
        <StatusBadge
          status={assuranceByBackup.get(item.id)?.status ?? "unknown"}
        />
      ),
    },
    {
      key: "size",
      header: "Size",
      cell: (item) => formatBytes(item.result.sizeBytes),
      className: "whitespace-nowrap tabular-nums",
      headerClassName: "whitespace-nowrap",
    },
    {
      key: "engine",
      header: "Engine",
      cell: (item) =>
        item.result.engine && item.result.engineMajorVersion
          ? `${formatEngine(item.result.engine)} ${item.result.engineMajorVersion}`
          : "Metadata missing",
    },
    {
      key: "format",
      header: "Format",
      cell: (item) => formatBackupFormat(item.result.format),
    },
    {
      key: "actions",
      header: "Action",
      cell: (item) => {
        const assurance = assuranceByBackup.get(item.id);
        return (
          <Button
            isDisabled={
              !active ||
              !restoreProviderConfigured ||
              !assuranceData.canRestore ||
              !assurance?.restoreReady ||
              restoreOperations.some((operation) =>
                ["queued", "running"].includes(operation.state),
              )
            }
            variant="secondary"
            onPress={() => setSelectedBackup(item)}
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={Undo02Icon}
              className="shrink-0"
            />
            Restore
          </Button>
        );
      },
      className: "whitespace-nowrap",
    },
  ];

  return (
    <div className="content-grid min-w-0">
      {!restoreProviderConfigured ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Restore unavailable</Alert.Title>
            <Alert.Description>
              Add {restoreProviderName} credentials in{" "}
              <InlineLink
                href={`/manage/integrations/${restoreProvider === "gcs" ? "gcp" : "aws"}`}
              >
                Manage → Integrations
              </InlineLink>{" "}
              before database restores can run.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Attributes title="Restore source" variant="card">
        <Attributes.Item label="Authoritative provider">
          <span className="inline-flex items-center gap-2">
            <CloudProviderLogo
              provider={restoreProvider}
              className="size-4 shrink-0"
            />
            <span>{restoreProviderLabel}</span>
          </span>
        </Attributes.Item>
        <Attributes.Item label="Repository location">
          <TypographyCode className="block truncate" title={restoreLocationUri}>
            {restoreLocationUri}
          </TypographyCode>
        </Attributes.Item>
      </Attributes>

      <ResourceTable
        ariaLabel="Restorable backups"
        columns={restoreColumns}
        emptyDescription="Backups from the configured restore provider will appear here for restore."
        emptyTitle="No restorable backups"
        getRowKey={(item) => item.id}
        items={retainedBackups}
      />

      {restoreOperations.length ? (
        <RestoreHistory
          canManage={
            active && restoreProviderConfigured && assuranceData.canRestore
          }
          operations={restoreOperations}
          resourceId={resource.id}
        />
      ) : null}

      <RestoreConfirmation
        backup={selectedBackup}
        resource={resource}
        onClose={() => setSelectedBackup(null)}
      />
    </div>
  );
}

function RestoreConfirmation({
  backup,
  onClose,
  resource,
}: {
  backup: SourceBackup | null;
  onClose: () => void;
  resource: Resource;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setConfirmation("");
    setReason("");
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!backup) return;
    setSubmitting(true);
    try {
      await api.post(
        `/v1/core/resources/${resource.id}/actions/restore`,
        { backupId: backup.id, confirmation, reason },
        { "Idempotency-Key": crypto.randomUUID() },
      );
      toast.success("Database restore queued");
      refreshApiQueries();
      close();
    } catch (cause) {
      toast.danger(cause instanceof Error ? cause.message : "Restore failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal.Backdrop
      isOpen={Boolean(backup)}
      onOpenChange={(open) => {
        if (!open && !submitting) close();
      }}
    >
      <Modal.Container scroll="inside" size="lg">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Restore {resource.name}</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <form className="content-grid" onSubmit={submit}>
              <div className="grid gap-2">
                <p className="font-medium text-danger">
                  This replaces the active database
                </p>
                <p className="text-muted">
                  Towbar restores into an isolated candidate first. After
                  validation, promotion briefly replaces the active volume.
                  Promotion cannot be cancelled; the previous volume is retained
                  for rollback for seven days.
                </p>
              </div>
              {backup ? (
                <Attributes columns={2} title="Selected backup">
                  <Attributes.Item label="Created">
                    {formatDate(backup.finishedAt ?? backup.createdAt)}
                  </Attributes.Item>
                  <Attributes.Item label="Size">
                    {formatBytes(backup.result.sizeBytes)}
                  </Attributes.Item>
                  <Attributes.Item label="Engine">
                    {formatEngine(backup.result.engine)}{" "}
                    {backup.result.engineMajorVersion}
                  </Attributes.Item>
                  <Attributes.Item label="Checksum">
                    <TypographyCode title={backup.result.checksum}>
                      {backup.result.checksum.slice(0, 12)}
                    </TypographyCode>
                  </Attributes.Item>
                </Attributes>
              ) : null}
              <Field>
                <FieldLabel htmlFor="restore-reason" isRequired>
                  Reason
                </FieldLabel>
                <Input
                  id="restore-reason"
                  minLength={10}
                  required
                  value={reason}
                  variant="secondary"
                  onChange={(event) => setReason(event.currentTarget.value)}
                />
                <FieldDescription>
                  Recorded in the restore request. Minimum 10 characters.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="restore-confirmation" isRequired>
                  Type {resource.name} to confirm
                </FieldLabel>
                <Input
                  id="restore-confirmation"
                  required
                  value={confirmation}
                  variant="secondary"
                  onChange={(event) =>
                    setConfirmation(event.currentTarget.value)
                  }
                />
              </Field>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  isDisabled={submitting}
                  variant="secondary"
                  onPress={close}
                >
                  Cancel
                </Button>
                <Button
                  isDisabled={
                    submitting ||
                    confirmation !== resource.name ||
                    reason.trim().length < 10
                  }
                  type="submit"
                  variant="danger"
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={Undo02Icon}
                    className="size-4 shrink-0"
                  />
                  {submitting ? "Queueing restore…" : "Restore database"}
                </Button>
              </div>
            </form>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function RestoreHistory({
  canManage,
  operations,
  resourceId,
}: {
  canManage: boolean;
  operations: ResourceOperation[];
  resourceId: string;
}) {
  const [cleanupOperation, setCleanupOperation] =
    useState<ResourceOperation | null>(null);
  const latestRestore = operations.find(
    (operation) => operation.type === "restore",
  );
  const cleanupByRestore = new Set(
    operations
      .filter(
        (operation) =>
          operation.type === "restore_cleanup" &&
          ["queued", "running", "succeeded"].includes(operation.state),
      )
      .map((operation) =>
        operation.request.type === "restore_cleanup"
          ? operation.request.restoreId
          : null,
      )
      .filter((restoreId): restoreId is string => Boolean(restoreId)),
  );
  const restoreColumns: ResourceTableColumn<ResourceOperation>[] = [
    {
      key: "restore-id",
      header: "Restore ID",
      cell: (operation) => (
        <TypographyCode title={operation.id}>
          {operation.id.slice(0, 8)}
        </TypographyCode>
      ),
      className: "whitespace-nowrap",
      headerClassName: "whitespace-nowrap",
    },
    {
      key: "status",
      header: "Status",
      cell: (operation) => <StatusBadge status={operation.state} />,
    },
    {
      key: "phase",
      header: "Phase",
      cell: (operation) => formatPhase(operation.phase),
    },
    {
      key: "created",
      header: "Created",
      cell: (operation) => (
        <RelativeTime label="Created" value={operation.createdAt} />
      ),
      className: "min-w-48 whitespace-nowrap tabular-nums",
    },
    {
      key: "duration",
      header: "Duration",
      cell: (operation) => (
        <ElapsedTime {...operation} status={operation.state} />
      ),
    },
    {
      key: "reason",
      header: "Reason",
      cell: (operation) => readString(operation.request.reason) ?? "—",
      className: "min-w-64",
    },
    {
      key: "rollback",
      header: "Rollback retention",
      cell: (operation) => {
        const result = readRestoreResult(operation.result);
        return result?.rollbackAvailableUntil ? (
          <RelativeTime
            label="Rollback retention"
            value={result.rollbackAvailableUntil}
          />
        ) : (
          "—"
        );
      },
    },
    {
      key: "action",
      header: "Action",
      cell: (operation) => (
        <RestoreOperationAction
          canManage={canManage}
          cleanupCompleted={cleanupByRestore.has(operation.id)}
          operation={operation}
          resourceId={resourceId}
          onCleanup={() => setCleanupOperation(operation)}
        />
      ),
    },
  ];
  return (
    <section className="grid min-w-0 gap-3">
      <h4 className="typography--heading-sm">Restore history</h4>
      {latestRestore && ["queued", "running"].includes(latestRestore.state) ? (
        <RestoreProgress operation={latestRestore} resourceId={resourceId} />
      ) : null}
      <ResourceTable
        ariaLabel="Restore history"
        columns={restoreColumns}
        emptyDescription="Restore operations appear here with their request history."
        emptyTitle="No restore history"
        getRowKey={(operation) => operation.id}
        items={operations}
      />
      <RestoreCleanupConfirmation
        operation={cleanupOperation}
        resourceId={resourceId}
        onClose={() => setCleanupOperation(null)}
      />
    </section>
  );
}

function RestoreProgress({
  operation,
  resourceId,
}: {
  operation: ResourceOperation;
  resourceId: string;
}) {
  const events = useApiQuery<{ events: ResourceOperationEvent[] }>(
    `/v1/core/resources/${resourceId}/operations/${operation.id}/events`,
    2_000,
  );
  return (
    <Widget>
      <Widget.Header endContent={<StatusBadge status={operation.state} />}>
        <Widget.Title>Restore progress</Widget.Title>
      </Widget.Header>
      <Widget.Content>
        <p className="mb-3 text-sm text-muted">
          Duration: <ElapsedTime {...operation} status={operation.state} />
        </p>
        {events.error ? <QueryError message={events.error} /> : null}
        {!events.data && !events.error ? <QueryLoading variant="list" /> : null}
        {events.data ? (
          <ol className="grid gap-3">
            {events.data.events.map((event) => (
              <li className="grid gap-1" key={event.id}>
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={event.level} />
                  <span className="font-medium">
                    {formatPhase(event.phase)}
                  </span>
                  <span className="text-muted typography--body-xs">
                    {formatDate(event.createdAt)}
                  </span>
                </span>
                <span className="text-muted typography--body-sm">
                  {event.message}
                </span>
                {event.command ? (
                  <TypographyCode>{event.command}</TypographyCode>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </Widget.Content>
    </Widget>
  );
}

function RestoreOperationAction({
  canManage,
  cleanupCompleted,
  onCleanup,
  operation,
  resourceId,
}: {
  canManage: boolean;
  cleanupCompleted: boolean;
  onCleanup: () => void;
  operation: ResourceOperation;
  resourceId: string;
}) {
  const result = readRestoreResult(operation.result);
  const cancellable =
    operation.type === "restore" &&
    ["queued", "running"].includes(operation.state) &&
    ![
      "promoting",
      "verifying_promotion",
      "rolling_back",
      "retaining_previous",
    ].includes(operation.phase ?? "");
  const cleanable =
    operation.type === "restore" &&
    operation.state === "succeeded" &&
    !cleanupCompleted &&
    Boolean(result?.previousVolumes.length);
  if (!canManage || (!cancellable && !cleanable)) return "—";
  return cancellable ? (
    <ActionButton
      confirm={{
        title: "Cancel this restore?",
        description:
          "Request cancellation of this restore. Review the operation result before using the restored data.",
        actionLabel: "Cancel restore",
      }}
      action={() =>
        api.post(
          `/v1/core/resources/${resourceId}/operations/${operation.id}/actions/cancel`,
        )
      }
      pendingLabel="Cancelling…"
      success="Restore cancellation requested"
      variant="danger"
    >
      <HugeiconsIcon aria-hidden="true" icon={BanIcon} className="shrink-0" />
      Cancel
    </ActionButton>
  ) : (
    <Button variant="secondary" onPress={onCleanup}>
      <HugeiconsIcon
        aria-hidden="true"
        icon={Delete02Icon}
        className="shrink-0"
      />
      Clean up volume
    </Button>
  );
}

function RestoreCleanupConfirmation({
  onClose,
  operation,
  resourceId,
}: {
  onClose: () => void;
  operation: ResourceOperation | null;
  resourceId: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const result = operation ? readRestoreResult(operation.result) : null;

  function close() {
    onClose();
  }

  async function cleanUp() {
    if (!operation) return;
    setSubmitting(true);
    try {
      await api.post(
        `/v1/core/resources/${resourceId}/actions/restore-cleanup`,
        { restoreId: operation.id },
        { "Idempotency-Key": crypto.randomUUID() },
      );
      toast.success("Rollback volume cleanup queued");
      refreshApiQueries();
      close();
    } catch (cause) {
      toast.danger(cause instanceof Error ? cause.message : "Cleanup failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal.Backdrop
      isOpen={Boolean(operation)}
      onOpenChange={(open) => {
        if (!open && !submitting) close();
      }}
    >
      <Modal.Container size="md">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Clean up rollback volume?</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body className="content-grid">
            <div className="grid gap-2">
              <p className="font-medium text-danger">
                This removes the retained database volume
              </p>
              <p className="text-muted">
                The promoted database stays active, but Towbar can no longer
                roll back to the previous volume after cleanup.
              </p>
            </div>
            <p className="text-muted typography--body-sm">
              {result?.previousVolumes.length ?? 0} previous volume
              {(result?.previousVolumes.length ?? 0) === 1 ? "" : "s"} will be
              removed.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                isDisabled={submitting}
                variant="secondary"
                onPress={close}
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={Shield01Icon}
                  className="size-4 shrink-0"
                />
                Keep rollback volume
              </Button>
              <Button
                isDisabled={submitting}
                variant="danger"
                onPress={cleanUp}
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={Delete02Icon}
                  className="size-4 shrink-0"
                />
                {submitting ? "Queueing cleanup…" : "Clean up volume"}
              </Button>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function readRestoreResult(result: ResourceOperation["result"]) {
  if (!result || !("outcome" in result)) return null;
  return result as RestoreResult;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function formatPhase(phase: string | null) {
  if (!phase) return "Queued";
  return phase
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
