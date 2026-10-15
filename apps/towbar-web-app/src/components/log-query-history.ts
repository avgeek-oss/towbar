import type { LogCondition } from "./log-explorer-model";
import type { CustomMonitoringRange } from "./monitoring-range";

export type LogQueryState = {
  range: string;
  customRange: CustomMonitoringRange | null;
  selection: { workload: string; environment: string; severity: string };
  conditions: LogCondition[];
  match: "and" | "or";
};
export type LogQueryHistory = { current: LogQueryState; past: LogQueryState[] };
export const initialLogQueryHistory: LogQueryHistory = {
  current: {
    range: "60",
    customRange: null,
    selection: { workload: "all", environment: "production", severity: "all" },
    conditions: [],
    match: "and",
  },
  past: [],
};

export function logQueryHistoryReducer(
  state: LogQueryHistory,
  action:
    | { type: "change"; patch: Partial<LogQueryState> }
    | { type: "undo" }
    | { type: "clear" },
): LogQueryHistory {
  if (action.type === "clear") return initialLogQueryHistory;
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    return previous
      ? { current: previous, past: state.past.slice(0, -1) }
      : state;
  }
  const next = { ...state.current, ...action.patch };
  return JSON.stringify(next) === JSON.stringify(state.current)
    ? state
    : {
        current: next,
        past: [...state.past.slice(-49), state.current],
      };
}

export function isLogQueryUndo(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.altKey ||
    event.shiftKey ||
    (!event.metaKey && !event.ctrlKey) ||
    event.key.toLowerCase() !== "z"
  )
    return false;
  return !event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        target.matches(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"], [role="dialog"], [role="alertdialog"]',
        ),
    );
}
