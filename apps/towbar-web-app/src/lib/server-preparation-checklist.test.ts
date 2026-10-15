import assert from "node:assert/strict";
import test from "node:test";
import type { ServerPreparation } from "@workspace/towbar-web-client";
import { preparationChecklist } from "./server-preparation-checklist";

function completedPreparation(): ServerPreparation {
  return {
    id: "completed",
    status: "succeeded",
    createdAt: "2026-09-01T10:00:00Z",
    startedAt: "2026-09-01T10:00:00Z",
    finishedAt: "2026-09-01T10:01:00Z",
    result: {},
    errorCode: null,
    errorMessage: null,
    steps: preparationChecklist(undefined, "pending").steps.map((step) => ({
      ...step,
      status: "succeeded",
      startedAt: "2026-09-01T10:00:00Z",
      finishedAt: "2026-09-01T10:01:00Z",
    })),
  };
}

void test("shows the full checklist before the first attempt", () => {
  const model = preparationChecklist(undefined, "pending");
  assert.equal(model.completed, 0);
  assert.equal(model.total, 8);
  assert.deepEqual(
    model.steps
      .filter((step) => step.group === "inspection")
      .map((step) => step.id),
    ["connecting", "inspecting"],
  );
  assert.equal(
    model.steps.filter((step) => step.group === "prerequisites").length,
    6,
  );
  assert(model.steps.every((step) => step.status === "waiting"));
});

void test("counts only recorded successful steps when preparation stops", () => {
  const preparation = completedPreparation();
  preparation.status = "failed";
  preparation.steps = preparation.steps.slice(0, 4);
  preparation.steps[3]!.status = "failed";
  preparation.steps[3]!.message =
    "Docker installation conflicts with an existing package.";
  const model = preparationChecklist(preparation, "failed");
  assert.equal(model.completed, 3);
  assert.equal(model.steps[3]!.message, preparation.steps[3]!.message);
  assert.equal(model.steps[4]!.status, "waiting");
  assert.equal(model.total, 7);
});

void test("retains completed step history without the overview's time limit", () => {
  const model = preparationChecklist(completedPreparation(), "ready");
  assert.equal(model.completed, 8);
  assert.equal(model.historyUnavailable, false);
});

void test("does not present an earlier run as preparation for a changed configuration", () => {
  const model = preparationChecklist(completedPreparation(), "pending");
  assert.equal(model.completed, 0);
  assert.equal(model.preparation, undefined);
  assert(model.steps.every((step) => step.status === "waiting"));
  const unknownHistory = preparationChecklist(undefined, "ready");
  assert.equal(unknownHistory.historyUnavailable, true);
  assert.equal(unknownHistory.completed, 0);
});

void test("keeps setup completed for history recorded before automatic collectors", () => {
  const preparation = completedPreparation();
  preparation.steps = preparation.steps.filter(
    (step) => step.id !== "installing_log_collector",
  );
  const model = preparationChecklist(preparation, "ready");
  assert.equal(model.completed, model.total);
  assert.equal(model.total, 7);
});
