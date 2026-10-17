"use client";
import { ScoutIcon } from "./scout-icons";
import { useUrlCursorPagination } from "@/hooks/use-url-pagination";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useApiQuery } from "@/hooks/use-api-query";
import type { ScoutIncident } from "./scout-controls";
export type ScoutOverviewIdentity = {
  serverName: string;
  workload: {
    environmentName: string;
    name: string;
    kind: string;
    sourceId: string;
    archivedAt: string | null;
  } | null;
};
export type OverviewIncident = ScoutOverviewIdentity & {
  incident: ScoutIncident & { serverId: string };
};
export function entityLabel(
  row: ScoutOverviewIdentity,
  owner: { deployableId: string | null },
) {
  return owner.deployableId
    ? row.workload
      ? `${row.workload.name} · ${row.workload.environmentName}`
      : "Removed workload"
    : row.serverName;
}
export function useWorkspaceIncidents<T>(
  state: "active" | "resolved",
  severity: "all" | "critical" | "warning",
) {
  const pagination = useUrlCursorPagination();
  const query = useApiQuery<{
    items: T[];
    nextBefore: string | null;
    nextBeforeId: string | null;
  }>(
    `/v1/core/monitoring/incidents?state=${state}&severity=${severity}&limit=20${pagination.suffix}`,
    30_000,
    { keepPreviousData: true },
  );
  return {
    query,
    reset: pagination.reset,
    pagination: (
      <div className="flex items-center justify-end gap-3">
        <span className="text-sm text-muted">Page {pagination.page}</span>
        <Button
          variant="secondary"
          isDisabled={pagination.page === 1 || query.isPreviousData}
          onPress={pagination.previous}
        >
          <ScoutIcon name="previous" />
          {pagination.previousLabel}
        </Button>
        <Button
          variant="secondary"
          isDisabled={!query.data?.nextBefore || query.isPreviousData}
          onPress={() =>
            pagination.next({
              before: query.data!.nextBefore!,
              beforeId: query.data!.nextBeforeId!,
            })
          }
        >
          <ScoutIcon name="next" />
          Next
        </Button>
      </div>
    ),
  };
}
