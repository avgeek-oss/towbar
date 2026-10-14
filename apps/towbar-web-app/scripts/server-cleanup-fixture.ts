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
      startedAt: createdAt,
      finishedAt: createdAt,
      updatedAt: createdAt,
      requestedBy: null,
      deletedAt: null,
      cancelRequestedAt: null,
      phase: null,
      errorCode: failed ? "RESOURCE_OPERATION_FAILED" : null,
      errorMessage: failed
        ? "A volume still has container references. Inspect its usage and request cleanup again."
        : null,
      result: {
        cleaned: [
          {
            kind: "container",
            name: `retired-worker-${index}`,
            reason: "Workload removed from Git",
          },
        ],
        skipped: [
          {
            kind: "image",
            name: "towbar/api:previous",
            reason: "Retained for rollback",
          },
        ],
        failures: failed
          ? [
              {
                kind: "volume",
                name: "retired-data",
                reason: "Volume still has container references",
              },
            ]
          : [],
        retiredPaths: failed ? [] : ["/etc/caddy/towbar/retired-worker.caddy"],
      },
    };
  });
}
