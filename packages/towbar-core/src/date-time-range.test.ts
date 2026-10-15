import assert from "node:assert/strict";
import test from "node:test";
import {
  dateFormatOptions,
  defaultDateTimePreferences,
  timeFormatOptions,
} from "./date-time.js";
import {
  initializeDateTimeRange,
  resolveDateTimeRange,
} from "./date-time-range.js";

void test("every saved format round-trips server-initialized ranges without losing precision", () => {
  const now = Date.parse("2026-09-17T14:00:00Z");
  const initial = {
    startAt: "2026-09-16T18:21:32.123Z",
    endAt: "2026-09-17T00:51:43.456Z",
    retentionDays: 7,
  };
  for (const date of dateFormatOptions)
    for (const time of timeFormatOptions) {
      const preferences = {
        dateFormat: date.id,
        timeFormat: time.id,
        timeZone: "Asia/Kathmandu",
      };
      const form = initializeDateTimeRange(preferences, initial, now);
      const result = resolveDateTimeRange(
        preferences,
        {
          start: { value: form.start, occurrence: form.startOccurrence },
          end: { value: form.end, occurrence: form.endOccurrence },
          retentionDays: 7,
        },
        now,
      );
      assert.deepEqual(result.range, {
        startAt: initial.startAt,
        endAt: initial.endAt,
      });
    }
});

void test("repeated daylight-saving times need an explicit occurrence and initialized ranges keep it", () => {
  const preferences = {
    ...defaultDateTimePreferences,
    timeZone: "America/New_York",
  };
  const now = Date.parse("2026-11-02T00:00:00Z");
  const input = {
    start: { value: "01:15, 1 Nov 2026" },
    end: { value: "02:30, 1 Nov 2026" },
    retentionDays: 7,
  };
  const result = resolveDateTimeRange(preferences, input, now);
  assert.equal(result.range, null);
  assert.deepEqual(
    result.choices.start.map((choice) => choice.instant),
    ["2026-11-01T05:15:00Z", "2026-11-01T06:15:00Z"],
  );
  assert.notEqual(
    result.choices.start[0]!.label,
    result.choices.start[1]!.label,
  );
  assert.equal(
    resolveDateTimeRange(
      preferences,
      {
        ...input,
        start: { ...input.start, occurrence: result.choices.start[1]!.instant },
      },
      now,
    ).range?.startAt,
    "2026-11-01T06:15:00Z",
  );
  const form = initializeDateTimeRange(
    preferences,
    {
      startAt: "2026-11-01T06:15:34Z",
      endAt: "2026-11-01T07:30:52Z",
      retentionDays: 7,
    },
    now,
  );
  assert.equal(
    resolveDateTimeRange(
      preferences,
      {
        ...input,
        start: { value: form.start, occurrence: form.startOccurrence },
        end: { value: form.end, occurrence: form.endOccurrence },
      },
      now,
    ).range?.startAt,
    "2026-11-01T06:15:34Z",
  );
});

void test("rejects nonexistent local times, invalid dates, future times, and ranges outside retention", () => {
  const preferences = {
    ...defaultDateTimePreferences,
    timeZone: "America/New_York",
  };
  const now = Date.parse("2026-03-09T00:00:00Z");
  const input = {
    start: { value: "02:15, 8 Mar 2026" },
    end: { value: "04:30, 8 Mar 2026" },
    retentionDays: 7,
  };
  assert.throws(
    () => resolveDateTimeRange(preferences, input, now),
    /does not exist/,
  );
  for (const value of [
    "12:00, 30 Feb 2026",
    "25:00, 8 Mar 2026",
    "12:00, 8 Marchgarbage 2026",
    "1:00 PM, 8 Mar 2026",
  ]) {
    assert.throws(() =>
      resolveDateTimeRange(preferences, { ...input, start: { value } }, now),
    );
  }
  assert.throws(
    () =>
      resolveDateTimeRange(
        preferences,
        { ...input, start: { value: "01:00, 1 Feb 2026" } },
        now,
      ),
    /retained/,
  );
  assert.throws(
    () =>
      resolveDateTimeRange(
        preferences,
        {
          ...input,
          start: { value: "04:00, 8 Mar 2026" },
          end: { value: "04:30, 9 Mar 2026" },
        },
        now,
      ),
    /future/,
  );
  assert.throws(
    () =>
      resolveDateTimeRange(preferences, { ...input, start: input.end }, now),
    /at least 30 seconds/,
  );
});

void test("segmented range values resolve in the saved timezone independently of display format", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  for (const date of dateFormatOptions)
    for (const time of timeFormatOptions) {
      const result = resolveDateTimeRange(
        {
          dateFormat: date.id,
          timeFormat: time.id,
          timeZone: "Asia/Kathmandu",
        },
        {
          start: { value: "2026-10-15T10:00:30.123" },
          end: { value: "2026-10-15T11:15:45.456" },
          retentionDays: 7,
        },
        now,
      );
      assert.deepEqual(result.range, {
        startAt: "2026-10-15T04:15:30.123Z",
        endAt: "2026-10-15T05:30:45.456Z",
      });
    }
});

void test("segmented ranges retain DST occurrence choices and reject nonexistent or offset-bearing wall times", () => {
  const preferences = {
    ...defaultDateTimePreferences,
    timeZone: "America/New_York",
  };
  const now = Date.parse("2026-11-02T00:00:00Z");
  const input = {
    start: { value: "2026-11-01T01:15" },
    end: { value: "2026-11-01T02:30" },
    retentionDays: 7,
  };
  const result = resolveDateTimeRange(preferences, input, now);
  assert.equal(result.range, null);
  assert.deepEqual(
    result.choices.start.map((choice) => choice.instant),
    ["2026-11-01T05:15:00Z", "2026-11-01T06:15:00Z"],
  );
  assert.equal(
    resolveDateTimeRange(
      preferences,
      {
        ...input,
        start: { ...input.start, occurrence: result.choices.start[1]!.instant },
      },
      now,
    ).range?.startAt,
    "2026-11-01T06:15:00Z",
  );
  for (const value of [
    "2026-03-08T02:15",
    "2026-02-30T10:00",
    "2026-11-01T25:00",
    "2026-11-01T01:15:60",
    "2026-11-01T01:15Z",
    "2026-11-01T01:15-04:00",
  ]) {
    assert.throws(() =>
      resolveDateTimeRange(preferences, { ...input, start: { value } }, now),
    );
  }
});
