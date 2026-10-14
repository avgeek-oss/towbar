"use client";
import { useState } from "react";
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
  return (
    <>
      <Button
        size="sm"
        variant="tertiary"
        className="min-h-11 whitespace-nowrap"
        onPress={() => setOpen(true)}
      >
        {operation.errorMessage
          ? "View failure"
          : result
            ? `${result.cleaned.length} removed · ${result.skipped.length} skipped`
            : "View details"}
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Cleanup details</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="grid gap-3 text-sm">
              <p>
                {operation.request.trigger === "sync"
                  ? "Repository sync"
                  : "Manual request"}{" "}
                · {formatDate(operation.createdAt)}
              </p>
              <StatusBadge status={operation.state} />
              {operation.errorMessage ? (
                <p className="text-danger">{operation.errorMessage}</p>
              ) : null}
              {operation.startedAt ? (
                <p>Started {formatDate(operation.startedAt)}</p>
              ) : (
                <p>
                  {operation.state === "queued"
                    ? "Waiting for the server queue."
                    : "Cleanup did not start."}
                </p>
              )}
              {result ? (
                <>
                  {(["cleaned", "skipped", "failures"] as const).map((kind) =>
                    result[kind]?.length ? (
                      <div key={kind}>
                        <p className="font-medium">
                          {kind === "cleaned"
                            ? "Removed"
                            : kind === "skipped"
                              ? "Skipped"
                              : "Failed"}
                        </p>
                        <ul className="mt-1 grid gap-2">
                          {result[kind]?.map((item) => (
                            <li
                              key={`${item.kind}:${item.name}`}
                              className="break-words"
                            >
                              {item.name}{" "}
                              <span className="text-muted">
                                ({item.kind}) · {item.reason}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null,
                  )}
                  {result.retiredPaths?.length ? (
                    <div>
                      <p className="font-medium">
                        Retired routes and configuration
                      </p>
                      <ul className="mt-1 grid gap-1">
                        {result.retiredPaths.map((path) => (
                          <li key={path} className="break-words">
                            {path}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : null}
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
    <section className="grid gap-4" aria-labelledby="cleanup-history-title">
      <h3 id="cleanup-history-title" className="text-base font-semibold">
        Cleanup history
      </h3>
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
