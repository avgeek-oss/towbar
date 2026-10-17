"use client";
import { useState, type FormEvent } from "react";
import {
  AlertCircleIcon,
  DashboardCircleIcon,
  DatabaseIcon,
  Delete02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { Input } from "@avgeek-oss/design-system/forms/input";
import { Field, FieldLabel } from "@avgeek-oss/design-system/forms/field";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import type {
  ManifestLifecycleItem,
  ManifestLifecycleResponse,
} from "@workspace/towbar-contracts";
import { useApiQuery, refreshApiQueries } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { DashboardPage, InlineLink } from "./page-parts";
import { useAccess } from "./access-context";
import { EnvironmentIcon } from "./environment-icon";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { LifecycleDetails } from "./manifest-lifecycle-details";

export function ManifestLifecycle({
  view: tab,
}: {
  view: "conflicts" | "retirements";
}) {
  const [offset, setOffset] = useState(0);
  const query = useApiQuery<ManifestLifecycleResponse>(
    `/v1/core/manifest-lifecycle?tab=${tab}&offset=${offset}&limit=20`,
    30_000,
  );
  const [selected, setSelected] = useState<ManifestLifecycleItem | null>(null);
  const [removing, setRemoving] = useState<ManifestLifecycleItem | null>(null);
  const { can } = useAccess();
  const columns: ResourceTableColumn<ManifestLifecycleItem>[] = [
    {
      key: "manifest",
      header: "Manifest ID",
      cell: (item) => (
        <span className="grid gap-1">
          <span className="inline-flex items-center gap-2">
            <HugeiconsIcon
              icon={
                item.workloads[0]?.kind &&
                !["app", "compose"].includes(item.workloads[0].kind)
                  ? DatabaseIcon
                  : DashboardCircleIcon
              }
              className="size-4 shrink-0 text-muted"
              aria-hidden="true"
            />
            <TypographyCode>{item.manifestId}</TypographyCode>
          </span>
          <span className="text-xs text-muted">
            {item.workloads[0]?.name ?? "Not materialized"}
          </span>
        </span>
      ),
    },
    {
      key: "environment",
      header: "Environment",
      cell: (item) => (
        <span className="inline-flex items-center gap-2">
          <EnvironmentIcon name={item.environment} />
          {item.environment}
        </span>
      ),
    },
    {
      key: "repositories",
      header: tab === "conflicts" ? "Repositories" : "Last repository",
      cell: (item) => (
        <span className="grid gap-1">
          {[
            ...new Map(
              (item.declarations.length
                ? item.declarations
                : item.workloads
              ).map((source) => [source.sourceId, source]),
            ).values(),
          ].map((source) => (
            <InlineLink
              href={`/repositories/${source.sourceId}`}
              key={source.sourceId}
              className="inline-flex items-center gap-2"
            >
              <IntegrationProviderLogo provider={source.provider ?? "github"} />
              {source.repository}
            </InlineLink>
          ))}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (item) =>
        item.state === "removing" ? (
          <StatusBadge
            status={removalInProgress(item) ? "running" : "failed"}
          />
        ) : (
          <span
            className={
              item.state === "conflict" ? "text-danger" : "text-warning"
            }
          >
            {item.state === "conflict"
              ? "Manifest conflict"
              : "Retirement pending"}
          </span>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      className: "text-right",
      headerClassName: "text-right",
      cell: (item) => (
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onPress={() => setSelected(item)}
          >
            <HugeiconsIcon
              icon={ViewIcon}
              aria-hidden="true"
              className="size-4"
            />
            Details
          </Button>
          {item.state !== "conflict" && can("server.remove") ? (
            <Button
              size="sm"
              variant="danger-soft"
              isDisabled={removalInProgress(item)}
              onPress={() => setRemoving(item)}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                aria-hidden="true"
                className="size-4"
              />
              Remove
            </Button>
          ) : null}
        </div>
      ),
    },
  ];
  return (
    <DashboardPage
      title={tab === "conflicts" ? "Conflicts" : "Retirements"}
      icon={tab === "conflicts" ? AlertCircleIcon : Delete02Icon}
    >
      <div className="content-grid">
        <p className="text-sm text-muted">
          {tab === "conflicts"
            ? "Correct manifest conflicts in Git, then sync the affected repositories. Running workloads stay unchanged."
            : "Removed manifests keep their runtime and data. Restore a compatible declaration in Git to resume management, or explicitly remove the workload here."}
        </p>
        {query.error ? (
          <QueryError message={query.error} />
        ) : !query.data ? (
          <QueryLoading />
        ) : (
          <>
            <div className="hidden md:block">
              <ResourceTable
                ariaLabel={
                  tab === "conflicts"
                    ? "Manifest conflicts"
                    : "Pending retirements"
                }
                columns={columns}
                items={query.data.items}
                getRowKey={(item) => item.key}
                emptyTitle={
                  tab === "conflicts"
                    ? "No manifest conflicts"
                    : "No pending retirements"
                }
                emptyDescription={
                  tab === "conflicts"
                    ? "Each manifest ID is managed by a single repository in its environment."
                    : "All workloads have a repository declaration."
                }
              />
            </div>
            <div className="grid gap-3 md:hidden">
              {query.data.items.map((item) => (
                <div
                  key={item.key}
                  className="grid gap-3 rounded-xl border bg-surface p-4 text-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="grid gap-1">
                      <span className="inline-flex items-center gap-2">
                        <HugeiconsIcon
                          icon={
                            item.workloads[0]?.kind &&
                            !["app", "compose"].includes(item.workloads[0].kind)
                              ? DatabaseIcon
                              : DashboardCircleIcon
                          }
                          className="size-4 shrink-0 text-muted"
                          aria-hidden="true"
                        />
                        <TypographyCode>{item.manifestId}</TypographyCode>
                      </span>
                      <span className="text-xs text-muted">
                        {item.environment}
                      </span>
                    </span>
                    <span
                      className={
                        item.state === "conflict"
                          ? "text-danger text-xs"
                          : "text-warning text-xs"
                      }
                    >
                      {item.state === "conflict"
                        ? "Conflict"
                        : item.state === "removing"
                          ? removalInProgress(item)
                            ? "Removing"
                            : "Removal failed"
                          : "Retirement pending"}
                    </span>
                  </div>
                  <span className="text-xs text-muted break-words">
                    {(item.declarations.length
                      ? item.declarations
                      : item.workloads
                    )
                      .map((source) => source.repository)
                      .join(" · ")}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      onPress={() => setSelected(item)}
                    >
                      <HugeiconsIcon
                        icon={ViewIcon}
                        className="size-4"
                        aria-hidden="true"
                      />
                      Details
                    </Button>
                    {item.state !== "conflict" && can("server.remove") ? (
                      <Button
                        variant="danger-soft"
                        isDisabled={removalInProgress(item)}
                        onPress={() => setRemoving(item)}
                      >
                        <HugeiconsIcon
                          icon={Delete02Icon}
                          className="size-4"
                          aria-hidden="true"
                        />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
              {!query.data.items.length ? (
                <p className="py-6 text-center text-sm text-muted">
                  {tab === "conflicts"
                    ? "No manifest conflicts"
                    : "No pending retirements"}
                </p>
              ) : null}
            </div>
            {query.data.total > 20 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
                <span>
                  {offset + 1}–{Math.min(offset + 20, query.data.total)} of{" "}
                  {query.data.total}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    isDisabled={offset === 0}
                    onPress={() => setOffset(Math.max(0, offset - 20))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    isDisabled={query.data.nextOffset === null}
                    onPress={() => setOffset(offset + 20)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
      {selected ? (
        <LifecycleDetails item={selected} onClose={() => setSelected(null)} />
      ) : null}
      {removing ? (
        <RemoveRetirement item={removing} onClose={() => setRemoving(null)} />
      ) : null}
    </DashboardPage>
  );
}

function RemoveRetirement({
  item,
  onClose,
}: {
  item: ManifestLifecycleItem;
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const workload = item.workloads[0]!;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.post(
        `/v1/core/retirements/${workload.id}/actions/remove`,
        {
          expectedRevision: workload.revision,
          confirmManifestId: confirmation,
          reason,
        },
        { "idempotency-key": idempotencyKey },
      );
      refreshApiQueries();
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not remove workload",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Permanently remove {item.manifestId}?</Modal.Heading>
            <Modal.CloseTrigger isDisabled={busy} />
          </Modal.Header>
          <Modal.Body>
            <form
              id="remove-retirement"
              className="grid gap-4"
              onSubmit={submit}
            >
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>
                    This removes the workload’s containers, routes and
                    persistent volumes from every associated server. History and
                    backups remain. Adding its manifest again after removal
                    creates a fresh workload.
                  </Alert.Description>
                </Alert.Content>
              </Alert>
              <p className="text-sm">
                To retain the data, cancel and add a compatible{" "}
                <span className="inline-flex items-center gap-2">
                  <HugeiconsIcon
                    icon={
                      item.workloads[0]?.kind &&
                      !["app", "compose"].includes(item.workloads[0].kind)
                        ? DatabaseIcon
                        : DashboardCircleIcon
                    }
                    className="size-4 shrink-0 text-muted"
                    aria-hidden="true"
                  />
                  <TypographyCode>{item.manifestId}</TypographyCode>
                </span>{" "}
                manifest to a repository instead.
              </p>
              {error ? <QueryError message={error} /> : null}
              <Field>
                <FieldLabel htmlFor="retirement-confirm" isRequired>
                  Type {item.manifestId} to confirm
                </FieldLabel>
                <Input
                  id="retirement-confirm"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="retirement-reason" isRequired>
                  Reason
                </FieldLabel>
                <Input
                  id="retirement-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={500}
                  required
                />
              </Field>
            </form>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" isDisabled={busy} onPress={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              type="submit"
              form="remove-retirement"
              isPending={busy}
              isDisabled={confirmation !== item.manifestId || !reason.trim()}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                className="size-4"
                aria-hidden="true"
              />
              Remove permanently
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function removalInProgress(item: ManifestLifecycleItem) {
  return (
    item.state === "removing" &&
    item.operations.some(
      (operation) =>
        operation.state === "queued" || operation.state === "running",
    )
  );
}
