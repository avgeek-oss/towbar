import {
  logFilterSchema,
  logConditionGroupSchema,
} from "@workspace/towbar-contracts";
import {
  initialLogQueryHistory,
  type LogQueryState,
} from "./log-query-history";

export function readLogQueryParams(params: URLSearchParams): LogQueryState {
  const defaults = initialLogQueryHistory.current;
  const selection = { ...defaults.selection };
  const workload = params.get("workload"),
    server = params.get("server");
  if (
    workload &&
    logFilterSchema.shape.workloadIds.safeParse([workload]).success
  )
    selection.workload = `workload:${workload}`;
  else if (
    server &&
    logFilterSchema.shape.serverIds.safeParse([server]).success
  )
    selection.workload = `server:${server}`;
  const environment = params.get("environment");
  if (
    environment === "all" ||
    environment === "production" ||
    environment === "preview"
  )
    selection.environment = environment;
  const severity = params.get("level");
  if (
    severity &&
    ["all", "trace", "debug", "info", "warn", "error", "fatal"].includes(
      severity,
    )
  )
    selection.severity = severity;
  const preset = params.get("range");
  let range =
    preset && ["15", "60", "360", "1440", "10080"].includes(preset)
      ? preset
      : defaults.range;
  let customRange: LogQueryState["customRange"] = null;
  const custom = logFilterSchema.safeParse({
    from: params.get("from"),
    to: params.get("to"),
  });
  if (preset === "custom" && custom.success) {
    range = "custom";
    customRange = { startAt: custom.data.from, endAt: custom.data.to };
  }
  const match = params.get("match") === "or" ? "or" : "and";
  let conditions: LogQueryState["conditions"] = [];
  const encoded = params.get("conditions");
  if (encoded && encoded.length <= 16384) {
    try {
      const group = logConditionGroupSchema.safeParse({
        match,
        conditions: JSON.parse(encoded),
      });
      if (group.success)
        conditions = group.data.conditions.map((condition, index) => ({
          ...condition,
          id: `url-${index}`,
        }));
    } catch {
      // An incomplete or hand-edited URL must not prevent opening the explorer.
    }
  }
  return {
    search: (params.get("search") ?? "").slice(0, 512),
    selection,
    range,
    customRange,
    conditions,
    match,
  };
}

export function logQueryParams(
  state: LogQueryState,
): Record<string, string | null> {
  return {
    search: state.search || null,
    range: state.range,
    from: state.customRange?.startAt ?? null,
    to: state.customRange?.endAt ?? null,
    workload: state.selection.workload.startsWith("workload:")
      ? state.selection.workload.slice(9)
      : null,
    server: state.selection.workload.startsWith("server:")
      ? state.selection.workload.slice(7)
      : null,
    environment: state.selection.environment,
    level: state.selection.severity === "all" ? null : state.selection.severity,
    match: state.conditions.length ? state.match : null,
    conditions: state.conditions.length
      ? JSON.stringify(
          state.conditions.map(({ field, operator, value }) => ({
            field,
            operator,
            value,
          })),
        )
      : null,
  };
}
