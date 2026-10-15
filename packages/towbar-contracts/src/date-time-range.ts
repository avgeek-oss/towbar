import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import {
  type DateTimePreferences,
  createDateTimeFormatter,
} from "./date-time.js";

export const rangeInitializationSchema = z
  .object({
    startAt: z.iso.datetime({ offset: true }),
    endAt: z.iso.datetime({ offset: true }),
    retentionDays: z.number().int().min(1).max(3650),
  })
  .strict();
const rangeValueSchema = z
  .object({
    value: z.string().min(1).max(100),
    occurrence: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export const preferredRangeSchema = z
  .object({
    start: rangeValueSchema,
    end: rangeValueSchema,
    retentionDays: z.number().int().min(1).max(3650),
  })
  .strict();
export type PreferredRangeInput = z.infer<typeof preferredRangeSchema>;
export type TimeOccurrence = { instant: string; label: string };

export function initializeDateTimeRange(
  preferences: DateTimePreferences,
  input: z.infer<typeof rangeInitializationSchema>,
  now = Date.now(),
) {
  const format = createDateTimeFormatter(preferences);
  const startAt = new Date(
    Math.max(
      Date.parse(input.startAt),
      now - input.retentionDays * 86400_000 + 60_000,
    ),
  ).toISOString();
  const endAt = new Date(Math.min(Date.parse(input.endAt), now)).toISOString();
  return {
    start: format(startAt)!.dateTime!,
    end: format(endAt)!.dateTime!,
    startOccurrence: startAt,
    endOccurrence: endAt,
    timeZone: preferences.timeZone,
    example: format(new Date(now).toISOString())!.dateTime!,
  };
}

function parsePreferredDateTime(
  value: string,
  preferences: DateTimePreferences,
) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/u.test(value)) {
    if (!z.iso.datetime({ local: true }).safeParse(value).success)
      throw new Error("Enter a valid calendar date and time.");
    return Temporal.PlainDateTime.from(value, { overflow: "reject" });
  }
  const separator = value.indexOf(", ");
  if (separator < 0)
    throw new Error(
      "Enter the time followed by a comma and the date, using your saved formats.",
    );
  const timeText = value.slice(0, separator).trim();
  const dateText = value.slice(separator + 2).trim();
  const datePatterns = {
    "day-short-month-year": /^(\d{1,2}) ([a-z]+) (\d{4})$/i,
    "short-month-day-year": /^([a-z]+) (\d{1,2}), (\d{4})$/i,
    "year-month-day": /^(\d{4})-(\d{2})-(\d{2})$/,
    "day-month-year": /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    "month-day-year": /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  };
  const date = datePatterns[preferences.dateFormat].exec(dateText);
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?: (AM|PM))?$/i.exec(timeText);
  if (!date || !time)
    throw new Error(
      "Enter a valid date and time using the format shown below.",
    );
  const namedMonths = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sept",
    "oct",
    "nov",
    "dec",
  ];
  let year: number, month: number, day: number;
  if (preferences.dateFormat === "year-month-day")
    [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
  else if (preferences.dateFormat === "day-short-month-year")
    [day, month, year] = [
      Number(date[1]),
      namedMonths.indexOf(date[2]!.toLowerCase().replace(/^sep$/, "sept")) + 1,
      Number(date[3]),
    ];
  else if (preferences.dateFormat === "short-month-day-year")
    [month, day, year] = [
      namedMonths.indexOf(date[1]!.toLowerCase().replace(/^sep$/, "sept")) + 1,
      Number(date[2]),
      Number(date[3]),
    ];
  else if (preferences.dateFormat === "day-month-year")
    [day, month, year] = [Number(date[1]), Number(date[2]), Number(date[3])];
  else [month, day, year] = [Number(date[1]), Number(date[2]), Number(date[3])];
  let hour = Number(time[1]);
  if (preferences.timeFormat.startsWith("12")) {
    if (hour < 1 || hour > 12 || !time[4])
      throw new Error("Use a time from 1 to 12 with AM or PM.");
    hour = (hour % 12) + (time[4].toUpperCase() === "PM" ? 12 : 0);
  } else if (time[4]) throw new Error("Use a 24-hour time without AM or PM.");
  try {
    return Temporal.PlainDateTime.from(
      {
        year,
        month,
        day,
        hour,
        minute: Number(time[2]),
        second: Number(time[3] ?? 0),
      },
      { overflow: "reject" },
    );
  } catch {
    throw new Error("Enter a valid calendar date and time.");
  }
}

function resolveWallTime(
  input: PreferredRangeInput["start"],
  preferences: DateTimePreferences,
) {
  const plain = parsePreferredDateTime(input.value, preferences);
  const earlier = plain.toZonedDateTime(preferences.timeZone, {
    disambiguation: "earlier",
  });
  const later = plain.toZonedDateTime(preferences.timeZone, {
    disambiguation: "later",
  });
  if (
    !earlier.toPlainDateTime().equals(plain) ||
    !later.toPlainDateTime().equals(plain)
  )
    throw new Error(
      "This local time does not exist because the clock moves forward. Choose a time before or after the daylight-saving change.",
    );
  const candidates = [
    ...new Set([earlier.toInstant().toString(), later.toInstant().toString()]),
  ];
  const format = createDateTimeFormatter(preferences);
  // Keep seconds and the original occurrence when an initialized field is unchanged.
  if (input.occurrence && format(input.occurrence)?.dateTime === input.value) {
    return {
      instant: Temporal.Instant.from(input.occurrence).toString(),
      choices: [],
    };
  }
  if (candidates.length === 1) return { instant: candidates[0]!, choices: [] };
  if (input.occurrence) {
    const match = candidates.find(
      (candidate) => Date.parse(candidate) === Date.parse(input.occurrence!),
    );
    if (match) return { instant: match, choices: [] };
  }
  return {
    instant: null,
    choices: candidates.map((instant, index) => ({
      instant,
      label: `${index === 0 ? "First" : "Second"} occurrence (${format(instant)!.zoneLabel})`,
    })),
  };
}

export function resolveDateTimeRange(
  preferences: DateTimePreferences,
  input: PreferredRangeInput,
  now = Date.now(),
) {
  const start = resolveWallTime(input.start, preferences);
  const end = resolveWallTime(input.end, preferences);
  if (!start.instant || !end.instant)
    return { range: null, choices: { start: start.choices, end: end.choices } };
  const from = Date.parse(start.instant),
    to = Date.parse(end.instant);
  if (to - from < 30_000)
    throw new Error(
      "Choose a range of at least 30 seconds, with the end after the start.",
    );
  if (to > now) throw new Error("The end date/time cannot be in the future.");
  if (from < now - input.retentionDays * 86400_000)
    throw new Error(
      `Choose a start within the retained ${input.retentionDays} days.`,
    );
  return {
    range: { startAt: start.instant, endAt: end.instant },
    choices: { start: [], end: [] },
  };
}
