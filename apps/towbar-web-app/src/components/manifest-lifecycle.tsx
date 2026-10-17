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
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
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
import type { App, Resource } from "@workspace/towbar-web-client";
import type {
  ManifestLifecycleItem,
  ManifestLifecycleResponse,
} from "@workspace/towbar-contracts";
import { useApiQuery, refreshApiQueries } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { DashboardPage, InlineLink } from "./page-parts";
import { useAccess } from "./access-context";
import { EnvironmentChip } from "./environment-chip";
import { AppIdentity, ResourceIdentity } from "./deployable-identity";
import { IntegrationProviderLogo } from "./integration-provider-logo";
import { LifecycleDetails } from "./manifest-lifecycle-details";

export function ManifestLifecycle({
  view: tab,
}: {
  view: "conflicts" | "retirements";
}) {
  const [offset, setOffset] = useState(0);
  const apps = useApiQuery<{ apps: App[] }>("/v1/core/apps", 60_000);
  const resources = useApiQuery<{ resources: Resource[] }>(
    "/v1/core/resources",
    60_000,
  );
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
      className: "min-w-56",
      cell: (item) => (
        <TypographyCode className="break-all">{item.manifestId}</TypographyCode>
      ),
    },
    {
      key: "workload",
      header: "Service / Datastore",
      className: "min-w-64",
      cell: (item) => (
        <span className="grid gap-3">
          {item.workloads.length ? (
            item.workloads.map((workload) => {
              const app = apps.data?.apps.find((app) => app.id === workload.id);
              if (app)
                return (
                  <AppIdentity
                    key={workload.id}
                    app={app}
                    showIndicators={false}
                  />
                );
              const resource = resources.data?.resources.find(
                (resource) => resource.id === workload.id,
              );
              if (resource)
                return (
                  <ResourceIdentity
                    key={workload.id}
                    resource={resource}
                    showIndicators={false}
                  />
                );
              return (
                <InlineLink
                  key={workload.id}
                  href={workload.href}
                  className="inline-flex min-w-0 items-center gap-3"
                >
                  <HugeiconsIcon
                    icon={
                      ["app", "compose"].includes(workload.kind)
                        ? DashboardCircleIcon
                        : DatabaseIcon
                    }
                    className="size-8 shrink-0 text-muted"
                    aria-hidden="true"
                  />
                  {workload.name}
                </InlineLink>
              );
            })
          ) : (
            <span className="text-sm text-muted">Not materialized</span>
          )}
        </span>
      ),
    },
    {
      key: "environment",
      header: "Environment",
      cell: (item) => <EnvironmentChip name={item.environment} />,
    },
    {
      key: "repositories",
      className: "min-w-64",
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
              className="inline-flex min-w-0 items-start gap-2 [overflow-wrap:anywhere]"
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
            label={removalInProgress(item) ? "Removing" : "Removal failed"}
          />
        ) : (
          <Chip color={item.state === "conflict" ? "danger" : "warning"}>
            <Chip.Label>
              {item.state === "conflict"
                ? "Manifest conflict"
                : "Retirement pending"}
            </Chip.Label>
          </Chip>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      className: "w-px whitespace-nowrap text-right",
      headerClassName: "text-right",
      cell: (item) => (
        <div className="flex flex-nowrap justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="pointer-coarse:min-h-11"
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
              className="pointer-coarse:min-h-11"
              isDisabled={removalInProgress(item)}
              onPress={() => setRemoving(item)}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                aria-hidden="true"
                className="size-4"
              />
              {item.state === "removing" && !removalInProgress(item)
                ? "Retry removal"
                : "Remove"}
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
            <ResourceTable
              ariaLabel={
                tab === "conflicts"
                  ? "Manifest conflicts"
                  : "Pending retirements"
              }
              columns={columns}
              items={query.data.items}
              getRowKey={(item) => item.key}
              tableClassName="min-w-[760px]"
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
                    className="pointer-coarse:min-h-11"
                    isDisabled={offset === 0}
                    onPress={() => setOffset(Math.max(0, offset - 20))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="pointer-coarse:min-h-11"
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
    if (busy || confirmation !== item.manifestId || !reason.trim()) return;
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
            <Modal.Heading className="pr-8 break-words pointer-coarse:pr-12">
              Permanently remove {item.manifestId}?
            </Modal.Heading>
            <Modal.CloseTrigger
              isDisabled={busy}
              className="pointer-coarse:size-11"
            />
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
                <TypographyCode className="break-all">
                  {item.manifestId}
                </TypographyCode>{" "}
                manifest to a repository instead.
              </p>
              {error ? <QueryError message={error} /> : null}
              <Field>
                <FieldLabel
                  htmlFor="retirement-confirm"
                  className="[overflow-wrap:anywhere]"
                  isRequired
                >
                  Type {item.manifestId} to confirm
                </FieldLabel>
                <Input
                  id="retirement-confirm"
                  disabled={busy}
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
                  disabled={busy}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={500}
                  required
                />
              </Field>
            </form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              className="pointer-coarse:min-h-11"
              isDisabled={busy}
              onPress={onClose}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              className="pointer-coarse:min-h-11"
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
