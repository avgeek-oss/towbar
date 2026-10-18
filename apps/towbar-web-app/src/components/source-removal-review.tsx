"use client";

import type { RepositoryRemovalPreview } from "@workspace/towbar-contracts";
import {
  Delete02Icon,
  ReloadIcon,
  Unlink01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { TypographyCode } from "@avgeek-oss/design-system/typography/typography";
import { QueryError } from "@workspace/towbar-web-ui/query-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { ActionButton, FormCard } from "./page-parts";
import { EnvironmentChip } from "./environment-chip";

export function SourceRemovalReview({
  sourceId,
  environment,
  onSuccess,
}: {
  sourceId: string;
  environment?: { id: string; name: string; mappingRevision: string };
  onSuccess: () => void;
}) {
  const query = useApiQuery<{ preview: RepositoryRemovalPreview }>(
    `/v1/core/sources/${sourceId}/removal-preview${environment ? `?environmentId=${environment.id}` : ""}`,
    undefined,
    { keepPreviousData: false },
  );
  const preview = query.data?.preview;
  const label = environment ? "Disconnect environment" : "Remove repository";
  return (
    <FormCard help={false} title="Removal review">
      <div className="content-grid">
        <p className="max-w-3xl text-sm text-muted">
          {environment
            ? `Disconnect ${environment.name}`
            : "Remove this repository connection"}{" "}
          and stop using its manifests. Compatible workloads move to their
          remaining repository; workloads without a declaration enter
          Retirements. Running containers, secrets, volumes, backups, and
          history are preserved. Git files stay unchanged.
        </p>
        {query.error ? <QueryError message={query.error} /> : null}
        {preview ? (
          <>
            <div className="flex flex-wrap gap-2" aria-label="Removal outcomes">
              {preview.summary.transfers > 0 ? (
                <Chip color="success">
                  <Chip.Label>
                    {preview.summary.transfers}{" "}
                    {preview.summary.transfers === 1 ? "transfer" : "transfers"}
                  </Chip.Label>
                </Chip>
              ) : null}
              {preview.summary.retirements > 0 ? (
                <Chip color="warning">
                  <Chip.Label>
                    {preview.summary.retirements}{" "}
                    {preview.summary.retirements === 1
                      ? "retirement"
                      : "retirements"}
                  </Chip.Label>
                </Chip>
              ) : null}
              {preview.summary.conflicts > 0 ? (
                <Chip color="danger">
                  <Chip.Label>
                    {preview.summary.conflicts}{" "}
                    {preview.summary.conflicts === 1 ? "conflict" : "conflicts"}
                  </Chip.Label>
                </Chip>
              ) : null}
            </div>
            {preview.blockers.length ? (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>Wait for active operations</Alert.Title>
                  <Alert.Description>
                    {preview.blockers.join(" · ")}. Refresh the review when they
                    finish.
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            <div className="max-h-[50vh] overflow-auto">
              <ResourceTable
                ariaLabel="Repository removal outcomes"
                getRowKey={(item) => item.key}
                items={preview.workloads}
                emptyTitle="No workloads affected"
                emptyDescription="The connection can be removed without changing any workloads."
                columns={[
                  {
                    key: "workload",
                    header: "Workload",
                    className: "min-w-48",
                    cell: (item) => (
                      <div className="grid gap-1">
                        <span>{item.name}</span>
                        <TypographyCode>{item.manifestId}</TypographyCode>
                      </div>
                    ),
                  },
                  {
                    key: "environment",
                    header: "Environment",
                    cell: (item) => <EnvironmentChip name={item.environment} />,
                  },
                  {
                    key: "outcome",
                    header: "Outcome",
                    className: "min-w-48",
                    cell: (item) => (
                      <div className="grid gap-2">
                        <Chip
                          color={
                            item.outcome === "conflict"
                              ? "danger"
                              : item.outcome === "retire"
                                ? "warning"
                                : item.outcome === "transfer"
                                  ? "success"
                                  : "default"
                          }
                        >
                          <Chip.Label>
                            {
                              {
                                transfer: "Transfer",
                                retire: "Retirement",
                                conflict: "Conflict",
                                unchanged: "Unchanged",
                              }[item.outcome]
                            }
                          </Chip.Label>
                        </Chip>
                        {item.destination ? (
                          <span className="text-sm text-muted">
                            {item.destination}
                          </span>
                        ) : null}
                      </div>
                    ),
                  },
                  {
                    key: "changes",
                    header: "Configuration",
                    className: "min-w-64",
                    cell: (item) => (
                      <div className="grid gap-2 text-sm">
                        {item.reason ? (
                          <span className="text-muted">{item.reason}</span>
                        ) : null}
                        {item.changedPaths.length ? (
                          <div className="flex flex-wrap gap-1">
                            {item.changedPaths.map((path) => (
                              <TypographyCode key={path}>{path}</TypographyCode>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted">
                            No configuration changes
                          </span>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </div>
          </>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onPress={query.refresh}
            isDisabled={query.isRefreshing}
          >
            <HugeiconsIcon icon={ReloadIcon} aria-hidden="true" />
            Refresh review
          </Button>
          <ActionButton
            action={() =>
              environment
                ? api.delete(
                    `/v1/core/sources/${sourceId}/environments/${environment.id}`,
                    {
                      expectedRevision: environment.mappingRevision,
                      expectedRemovalRevision: preview!.revision,
                    },
                  )
                : api.delete(`/v1/core/sources/${sourceId}`, {
                    expectedRevision: preview!.revision,
                  })
            }
            isDisabled={
              !preview ||
              Boolean(query.error) ||
              Boolean(preview.blockers.length)
            }
            confirm={{
              title: `${label}?`,
              actionLabel: label,
              description: `Apply the reviewed outcomes: ${preview?.summary.transfers ?? 0} transfers, ${preview?.summary.retirements ?? 0} retirements, and ${preview?.summary.conflicts ?? 0} conflicts. Runtime and retained data stay in place. Configuration differences are recorded without starting a deployment.`,
            }}
            onSuccess={onSuccess}
            pendingLabel={environment ? "Disconnecting…" : "Removing…"}
            success={
              environment
                ? `${environment.name} disconnected`
                : "Repository removed"
            }
            variant="danger"
          >
            <HugeiconsIcon
              icon={environment ? Unlink01Icon : Delete02Icon}
              aria-hidden="true"
            />
            {label}
          </ActionButton>
        </div>
      </div>
    </FormCard>
  );
}
