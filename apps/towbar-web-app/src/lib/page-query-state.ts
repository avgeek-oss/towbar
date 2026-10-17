import {
  analyticsFiltersSchema,
  analyticsHttpFilterFields,
  analyticsWebFilterFields,
} from "@workspace/towbar-contracts";

export function queryInteger(
  value: string | null,
  fallback = 1,
  min = 1,
  max = 1_000_000,
) {
  if (!value || !/^\d+$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function analyticsUrlState(search: Pick<URLSearchParams, "get">) {
  const kind: "request" | "pageview" =
    search.get("measure") === "request" ? "request" : "pageview";
  const allowedDays = [1 / 96, 1 / 24, 1 / 8, 1 / 2, 1, 7, 14, 30, 90];
  const days = Number(search.get("days") ?? 1);
  const raw = search.get("filters");
  let filters: unknown = [];
  if (raw && raw.length <= 8_192) {
    try {
      filters = JSON.parse(raw);
    } catch {
      filters = [];
    }
  }
  const parsed = analyticsFiltersSchema.safeParse(filters);
  const fields: readonly string[] =
    kind === "request" ? analyticsHttpFilterFields : analyticsWebFilterFields;
  return {
    kind,
    days: allowedDays.includes(days) ? days : 1,
    filters: parsed.success
      ? parsed.data.filter((filter) => fields.includes(filter.field))
      : [],
  };
}

export type HistoryCursor = { before: string; beforeId: string };
export function parseCursorTrail(raw: string | null): HistoryCursor[] {
  if (!raw || raw.length > 12_000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 50) return [];
    if (
      !value.every(
        (cursor) =>
          cursor &&
          typeof cursor === "object" &&
          typeof cursor.before === "string" &&
          cursor.before.length <= 64 &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
            cursor.before,
          ) &&
          Number.isFinite(Date.parse(cursor.before)) &&
          typeof cursor.beforeId === "string" &&
          /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(
            cursor.beforeId,
          ),
      )
    )
      return [];
    return value;
  } catch {
    return [];
  }
}
