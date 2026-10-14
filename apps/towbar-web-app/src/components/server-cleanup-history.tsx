"use client";
import { useState } from "react";
import { Attributes } from "@avgeek-oss/design-system/data-display/attributes";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import type { ResourceOperation } from "@workspace/towbar-web-client";
import { useTablePagination } from "@avgeek-oss/design-system/hooks/use-table-pagination";
import { Pagination } from "@avgeek-oss/design-system/navigation/pagination";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate } from "./dashboard-overview";

export type ServerCleanupPage = {
  inProgress: boolean;
  operations: ResourceOperation[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

const columns: ResourceTableColumn<ResourceOperation>[] = [
  {
    key: "trigger",
    header: "Trigger",
    cell: (operation) =>
      operation.request.trigger === "sync" ? "Repository sync" : "Manual",
  },
  {
    key: "status",
    header: "Status",
    cell: (operation) => <StatusBadge status={operation.state} />,
  },
  {
    key: "requested",
    header: "Requested",
    cell: (operation) => (
      <span className="whitespace-nowrap">
        {formatDate(operation.createdAt)}
      </span>
    ),
  },
  {
    key: "completed",
    header: "Completed",
    cell: (operation) => (
      <span className="whitespace-nowrap">
        {operation.finishedAt ? formatDate(operation.finishedAt) : "—"}
      </span>
    ),
  },
  {
    key: "results",
    header: "Results",
    cell: (operation) => <CleanupResults operation={operation} />,
  },
];

function CleanupResults({ operation }: { operation: ResourceOperation }) {
  const [open, setOpen] = useState(false);
  const result =
    operation.result && "cleaned" in operation.result ? operation.result : null;
  const actions = result
    ? [
        ...result.cleaned.map((item) => ({
          ...item,
          status: "succeeded",
          label: "Removed",
        })),
        ...result.skipped.map((item) => ({
          ...item,
          status: "skipped",
          label: "Skipped",
        })),
        ...(result.failures ?? []).map((item) => ({
          ...item,
          status: "failed",
          label: "Failed",
        })),
        ...(result.retiredPaths ?? []).map((path) => ({
          kind: path.startsWith("docker-network:") ? "network" : "path",
          name: path.startsWith("docker-network:")
            ? path.slice("docker-network:".length)
            : path,
          reason: "Retired workload cleanup",
          status: "succeeded",
          label: "Removed",
        })),
      ]
    : [];
  return (
    <>
      <Button
        size="sm"
        variant="tertiary"
        className="min-h-11 whitespace-nowrap"
        onPress={() => setOpen(true)}
      >
        View result
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Cleanup result</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="grid gap-6 text-sm">
              <Attributes variant="embedded">
                <Attributes.Item label="Status">
                  <StatusBadge status={operation.state} />
                </Attributes.Item>
                <Attributes.Item label="Trigger">
                  {operation.request.trigger === "sync"
                    ? "Repository sync"
                    : "Manual request"}
                </Attributes.Item>
                <Attributes.Item label="Requested">
                  {formatDate(operation.createdAt)}
                </Attributes.Item>
                <Attributes.Item label="Started">
                  {operation.startedAt ? formatDate(operation.startedAt) : "—"}
                </Attributes.Item>
                <Attributes.Item label="Completed">
                  {operation.finishedAt
                    ? formatDate(operation.finishedAt)
                    : "—"}
                </Attributes.Item>
              </Attributes>
              {operation.errorMessage ? (
                <p className="text-danger [overflow-wrap:anywhere]">
                  {operation.errorMessage}
                </p>
              ) : null}
              <section aria-label="Cleanup actions" className="grid gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  Actions
                </h3>
                {actions.length ? (
                  <ul className="divide-y divide-separator">
                    {actions.map((item, index) => (
                      <li
                        key={`${item.kind}:${item.name}:${index}`}
                        className="flex items-start gap-3 py-4"
                      >
                        <div className="grid min-w-0 flex-1 gap-1">
                          <p className="font-medium text-foreground [overflow-wrap:anywhere]">
                            {item.name}
                          </p>
                          <p className="text-xs capitalize text-muted">
                            {item.kind}
                          </p>
                          <p className="text-muted [overflow-wrap:anywhere]">
                            {item.reason}
                          </p>
                        </div>
                        <StatusBadge
                          status={item.status}
                          label={item.label}
                          tooltip={item.reason}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted">
                    {operation.state === "queued"
                      ? "Waiting for the server queue. Actions will appear when cleanup finishes."
                      : operation.state === "running"
                        ? "Cleanup is running. Actions will appear when it finishes."
                        : result
                          ? "No objects needed cleanup."
                          : "No cleanup actions were recorded."}
                  </p>
                )}
              </section>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

export function ServerCleanupHistory({
  firstPage,
  serverId,
}: {
  firstPage: ServerCleanupPage;
  serverId: string;
}) {
  const pagination = useTablePagination({
    pageSize: firstPage.pagination.limit,
    total: firstPage.pagination.total,
  });
  const requested = useApiQuery<ServerCleanupPage>(
    pagination.page === 1
      ? null
      : `/v1/core/servers/${serverId}/cleanup?page=${pagination.page}&limit=${pagination.pageSize}`,
    5_000,
  );
  const page = pagination.page === 1 ? firstPage : requested.data;
  return (
    <section className="grid gap-4" aria-label="Cleanup history">
      {requested.error ? (
        <QueryError message={requested.error} />
      ) : page ? (
        <ResourceTable
          ariaLabel="Server cleanup history"
          columns={columns}
          getRowKey={(operation) => operation.id}
          items={page.operations}
          emptyTitle="No cleanup attempts"
          emptyDescription="Repository removals and manual cleanup requests appear here."
          tableClassName="min-w-[720px]"
        />
      ) : (
        <QueryLoading />
      )}
      {firstPage.pagination.total > pagination.pageSize ? (
        <Pagination
          aria-label="Cleanup history pages"
          page={pagination.page}
          size="sm"
          totalPages={pagination.totalPages ?? 1}
          onPageChange={pagination.setPage}
        />
      ) : null}
    </section>
  );
}
