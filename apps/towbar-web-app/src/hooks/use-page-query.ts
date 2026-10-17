"use client";
import { useCallback } from "react";
import { useSearchParams } from "next/navigation";

const filterKeys = new Set([
  "q",
  "view",
  "sourceId",
  "environment",
  "serverIp",
  "resourceType",
  "running",
  "health",
  "setup",
  "scout",
  "sync",
  "autoDeploy",
  "type",
  "targetEnvironment",
  "state",
  "trigger",
  "serverId",
  "sort",
  "severity",
  "event",
  "userId",
  "provider",
  "category",
  "entityId",
  "search",
  "range",
  "from",
  "to",
  "measure",
  "days",
  "filters",
]);

/** Read URL state during render; update from the current URL so batched controls compose. */
export function usePageQuery() {
  const search = useSearchParams();
  const update = useCallback(
    (values: Record<string, string | null>, replace = false) => {
      const url = new URL(window.location.href);
      if (Object.keys(values).some((key) => filterKeys.has(key))) {
        for (const key of ["page", "cursors", "cursorsPage"])
          url.searchParams.delete(key);
      }
      for (const [key, value] of Object.entries(values)) {
        if (value === null || value === "") url.searchParams.delete(key);
        else url.searchParams.set(key, value);
      }
      if (url.href !== window.location.href)
        window.history[replace ? "replaceState" : "pushState"](
          null,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
    },
    [],
  );
  return { search, update };
}
export function useQueryChoice<T extends string>(
  key: string,
  choices: readonly T[],
  fallback: T,
) {
  const { search, update } = usePageQuery();
  const raw = search.get(key);
  const value = choices.find((choice) => choice === raw) ?? fallback;
  const set = useCallback(
    (next: string) =>
      update({
        [key]:
          next === fallback || !choices.some((choice) => choice === next)
            ? null
            : next,
      }),
    [key, fallback, choices, update],
  );
  return [value, set] as const;
}
