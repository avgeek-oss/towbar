import assert from "node:assert/strict";
import test from "node:test";
import {
  localizedResponse,
  defaultDateTimePreferences,
} from "@workspace/towbar-core/date-time";
import {
  clearDateTimeLabels,
  localizationGeneration,
  receiveDateTimeLabels,
} from "../lib/date-time-display";
import {
  conditionFilters,
  logDateTime,
  logRangeLabel,
} from "./log-explorer-model";

void test("built-in filters preserve their typed selectors and parsed fields remain attributes", () => {
  assert.deepEqual(
    conditionFilters([
      { id: "a", field: "service", operator: "equals", value: "api" },
      { id: "b", field: "stream", operator: "equals", value: "stderr" },
      {
        id: "c",
        field: "deploymentId",
        operator: "equals",
        value: "deployment",
      },
      {
        id: "d",
        field: "attribute:service",
        operator: "contains",
        value: "billing",
      },
      {
        id: "e",
        field: "attribute:customer",
        operator: "equals",
        value: "123",
      },
    ]),
    {
      services: ["api"],
      stream: "stderr",
      deploymentIds: ["deployment"],
      attributes: [
        { key: "service", value: "billing", operator: "contains" },
        { key: "customer", value: "123", operator: "equals" },
      ],
    },
  );
});
void test("logs always show seconds while preserving the user's localized date and timezone", () => {
  const values = { from: "2026-10-14T23:55:17Z", to: "2026-10-15T00:05:23Z" };
  clearDateTimeLabels();
  receiveDateTimeLabels(
    localizedResponse(values, {
      ...defaultDateTimePreferences,
      timeZone: "Asia/Kolkata",
    }),
    localizationGeneration(),
  );
  assert.equal(logDateTime(values.from), "05:25:17, 15 Oct 2026");
  assert.equal(
    logRangeLabel(values.from, values.to),
    "15 Oct 2026 · 05:25:17 – 05:35:23",
  );
  clearDateTimeLabels();
  receiveDateTimeLabels(
    localizedResponse(values, defaultDateTimePreferences),
    localizationGeneration(),
  );
  assert.equal(
    logRangeLabel(values.from, values.to),
    "23:55:17, 14 Oct 2026 – 00:05:23, 15 Oct 2026",
  );
  clearDateTimeLabels();
});
