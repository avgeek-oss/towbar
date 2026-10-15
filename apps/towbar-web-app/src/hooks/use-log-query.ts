"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageQuery } from "./use-page-query";
import {
  logQueryHistoryReducer,
  type LogQueryState,
} from "@/components/log-query-history";
import { logQueryParams, readLogQueryParams } from "@/components/log-query-url";

export function useLogQuery() {
  const { search, update } = usePageQuery();
  const serialized = search.toString();
  const current = useMemo(
    () => readLogQueryParams(new URLSearchParams(serialized)),
    [serialized],
  );
  const history = useRef<LogQueryState[]>([]);
  const [past, setPast] = useState<LogQueryState[]>([]);
  useEffect(() => {
    const reset = () => {
      history.current = [];
      setPast([]);
    };
    window.addEventListener("popstate", reset);
    return () => window.removeEventListener("popstate", reset);
  }, []);
  const changeQuery = useCallback(
    (action: Parameters<typeof logQueryHistoryReducer>[1]) => {
      const previous = {
        current: readLogQueryParams(
          new URLSearchParams(window.location.search),
        ),
        past: history.current,
      };
      const next = logQueryHistoryReducer(previous, action);
      if (next === previous) return;
      history.current = next.past;
      setPast(next.past);
      update(
        logQueryParams(next.current),
        action.type !== "change" || action.record === false,
      );
    },
    [update],
  );
  return { current, past, changeQuery };
}
