import { randomUUID } from "node:crypto";
import type { ResourceOperation } from "@workspace/towbar-web-client";

export function createServerCleanupFixture(
  serverId: string,
): ResourceOperation[] {
  return Array.from({ length: 23 }, (_, index) => {
    const createdAt = new Date(
      Date.UTC(2026, 9, 13, 12) - index * 3_600_000,
    ).toISOString();
    const failed = index % 5 === 1;
    return {
      id: randomUUID(),
      serverId,
      sourceId: null,
      resourceId: null,
      type: "cleanup_orphans",
      request: {
        type: "cleanup_orphans",
        trigger: index % 2 ? "manual" : "sync",
      },
      state: failed ? "failed" : "succeeded",
      createdAt,
      startedAt: new Date(Date.parse(createdAt) + 2_000).toISOString(),
      finishedAt: new Date(Date.parse(createdAt) + 12_000).toISOString(),
      updatedAt: new Date(Date.parse(createdAt) + 12_000).toISOString(),
      requestedBy: null,
      deletedAt: null,
      cancelRequestedAt: null,
      phase: null,
      errorCode: failed ? "RESOURCE_OPERATION_FAILED" : null,
      errorMessage: failed
        ? "A volume still has container references. Inspect its usage and request cleanup again."
        : null,
      result: {
        ...(index % 2
          ? {
              buildCache: {
                status: "succeeded" as const,
                message:
                  "Total: 2.5GB; cache limit 5120 MiB; free-space target 10240 MiB",
              },
            }
          : {}),
        cleaned:
          index === 2
            ? []
            : [
                {
                  kind: "container",
                  name: `retired-worker-${index}`,
                  reason: "Workload removed from Git",
                },
              ],
        skipped: Array.from({ length: index === 0 ? 40 : 1 }, (_, item) => ({
          kind: "image" as const,
          name:
            item === 0
              ? "towbar/api:previous"
              : `towbar/workload-${item}:current`,
          reason:
            item === 0
              ? "Retained for rollback"
              : "Image is retained for deployment or rollback",
        })),
        failures: failed
          ? [
              {
                kind: "volume",
                name: "retired-data",
                reason: "Volume still has container references",
              },
            ]
          : [],
        retiredPaths:
          failed || index === 2
            ? []
            : [
                "docker-network:towbar-retired-worker",
                "/etc/caddy/towbar/retired-worker.caddy",
              ],
      },
    };
  });
}
