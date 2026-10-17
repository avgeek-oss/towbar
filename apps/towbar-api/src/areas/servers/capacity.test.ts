import assert from "node:assert/strict";
import test from "node:test";

import { classifyCapacityHealth } from "./capacity.js";

const base = {
  checkedAt: new Date().toISOString(),
  cpuUsagePercent: 20,
  diskUsedPercent: 40,
  latestCheckStatus: "succeeded" as const,
  memoryUsedPercent: 50,
  runtimes: [],
};

void test("capacity health escalates failed checks and exhausted hosts", () => {
  assert.equal(
    classifyCapacityHealth({ ...base, latestCheckStatus: "failed" }),
    "critical",
  );
  assert.equal(
    classifyCapacityHealth({ ...base, diskUsedPercent: 96 }),
    "critical",
  );
});

void test("capacity health calls out pressure before an outage", () => {
  assert.equal(
    classifyCapacityHealth({ ...base, memoryUsedPercent: 86 }),
    "attention",
  );
  assert.equal(classifyCapacityHealth(base), "healthy");
});

void test("capacity health tolerates an isolated restart but surfaces repeated restarts", () => {
  const runtime = {
    cpuPercent: 2,
    healthStatus: "healthy" as const,
    id: "31111111-1111-4111-8111-111111111111",
    kind: "app" as const,
    memoryLimitBytes: 1_000,
    memoryUsageBytes: 200,
    name: "Example API",
    observedState: "running" as const,
    restartCount: 1,
    sourceId: "11111111-1111-4111-8111-111111111111",
    startedAt: new Date().toISOString(),
  };

  assert.equal(
    classifyCapacityHealth({ ...base, runtimes: [runtime] }),
    "healthy",
  );
  assert.equal(
    classifyCapacityHealth({
      ...base,
      runtimes: [{ ...runtime, restartCount: 3 }],
    }),
    "attention",
  );
});

void test("capacity health stays unknown until a server reports metrics", () => {
  assert.equal(classifyCapacityHealth({ ...base, checkedAt: null }), "unknown");
});

void test("CPU and memory capacity share 70% warning and 90% critical thresholds", () => {
  for (const metric of ["cpuUsagePercent", "memoryUsedPercent"]) {
    for (const [value, expected] of [
      [69.9, "healthy"],
      [70, "attention"],
      [89.9, "attention"],
      [90, "critical"],
    ] as const) {
      assert.equal(
        classifyCapacityHealth({ ...base, [metric]: value }),
        expected,
      );
    }
  }
});
