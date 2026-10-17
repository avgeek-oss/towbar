import assert from "node:assert/strict";
import test from "node:test";
import type { Source } from "@workspace/towbar-web-client";
import { queueRepositorySyncs } from "./repository-sync";

function source(id: string, status: Source["status"] = "active"): Source {
  return {
    id,
    status,
    provider: "github",
    repositoryOwner: "example",
    repositoryName: id,
    createdAt: "2026-10-17T12:00:00Z",
    updatedAt: "2026-10-17T12:00:00Z",
  };
}

void test("queues every active repository and counts its environment syncs", async () => {
  const requested: string[] = [];
  const result = await queueRepositorySyncs(
    [source("one"), source("archived", "archived"), source("two")],
    async (id) => {
      requested.push(id);
      return {
        outcomes: ["production", "staging"].map((environmentId) => ({
          environmentId,
          syncId: `${id}-${environmentId}`,
          error: null,
        })),
      };
    },
  );
  assert.deepEqual(requested, ["one", "two"]);
  assert.deepEqual(result, { queued: 4, failures: [] });
});

void test("continues after request and environment failures without losing accepted syncs", async () => {
  const requested: string[] = [];
  const result = await queueRepositorySyncs(
    [source("unavailable"), source("partial"), source("last")],
    async (id) => {
      requested.push(id);
      if (id === "unavailable") throw new Error("Provider unavailable");
      return {
        outcomes: [
          { environmentId: "production", syncId: `${id}-sync`, error: null },
          ...(id === "partial"
            ? [
                {
                  environmentId: "staging",
                  syncId: null,
                  error: "Branch missing",
                },
              ]
            : []),
        ],
      };
    },
  );
  assert.deepEqual(requested, ["unavailable", "partial", "last"]);
  assert.deepEqual(result, {
    queued: 2,
    failures: [
      "example/unavailable: Provider unavailable",
      "example/partial: Branch missing",
    ],
  });
});

void test("reports repositories without connected environments", async () => {
  assert.deepEqual(
    await queueRepositorySyncs([source("empty")], async () => ({
      outcomes: [],
    })),
    {
      queued: 0,
      failures: ["example/empty: No connected environments to sync"],
    },
  );
});
