"use client";
import { useState } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import type { ResourceOperation } from "@workspace/towbar-web-client";
import { useUrlTablePagination as useTablePagination } from "@/hooks/use-url-pagination";
import { Pagination } from "@avgeek-oss/design-system/navigation/pagination";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { StatusBadge } from "@workspace/towbar-web-ui/status-badge";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { CleanupObjectType } from "./cleanup-object-type";
import { RelativeTime } from "./last-synced-time";

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
      <RelativeTime label="Requested" value={operation.createdAt} />
    ),
  },
  {
    key: "completed",
    header: "Completed",
    cell: (operation) =>
      operation.finishedAt ? (
        <RelativeTime label="Completed" value={operation.finishedAt} />
      ) : (
        "—"
      ),
  },
  {
    key: "results",
    header: "Results",
    cell: (operation) => <CleanupResults operation={operation} />,
  },
];

type CleanupAction = {
  name: string;
  kind: string;
  reason: string;
  status: string;
  label: string;
};

const resultColumns: ResourceTableColumn<CleanupAction>[] = [
  {
    key: "entity",
    header: "Entity",
    headerClassName: "w-[32%]",
    cell: (item) => (
      <span className="font-medium text-foreground [overflow-wrap:anywhere]">
        {item.name}
      </span>
    ),
  },
  {
    key: "type",
    header: "Type",
    headerClassName: "w-[18%]",
    cell: (item) => <CleanupObjectType kind={item.kind} />,
  },
  {
    key: "comments",
    header: "Comments",
    headerClassName: "w-[32%]",
    cell: (item) => (
      <span className="[overflow-wrap:anywhere]">{item.reason}</span>
    ),
  },
  {
    key: "status",
    header: "Status",
    headerClassName: "w-[18%]",
    cell: (item) => (
      <StatusBadge
        status={item.status}
        label={item.label}
        tooltip={item.reason}
      />
    ),
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
          kind:
            item.kind === "container" && item.reason.includes("Caddy")
              ? "route"
              : item.kind,
          status: "failed",
          label: "Failed",
        })),
        ...(result.retiredPaths ?? []).map((path) => ({
          kind: path.startsWith("docker-network:")
            ? "network"
            : path.startsWith("/etc/caddy/")
              ? "route"
              : "path",
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
        className="whitespace-nowrap"
        onPress={() => setOpen(true)}
      >
        View result
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog className="max-w-5xl">
            <Modal.Header>
              <Modal.Heading>Cleanup result</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="min-w-0">
              <ResourceTable
                ariaLabel="Cleanup results"
                columns={resultColumns}
                getRowKey={(item) => `${item.status}:${item.kind}:${item.name}`}
                items={actions}
                tableClassName="min-w-[720px] table-fixed"
                emptyTitle="No cleanup actions"
                emptyDescription={
                  operation.errorMessage ??
                  (operation.state === "queued"
                    ? "Waiting for the server queue. Actions will appear when cleanup finishes."
                    : operation.state === "running"
                      ? "Cleanup is running. Actions will appear when it finishes."
                      : result
                        ? "No objects needed cleanup."
                        : "No cleanup actions were recorded.")
                }
                footer={
                  operation.errorMessage ? (
                    <span className="text-danger [overflow-wrap:anywhere]">
                      {operation.errorMessage}
                    </span>
                  ) : undefined
                }
              />
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
