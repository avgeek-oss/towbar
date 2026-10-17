"use client";
import { useCallback, useEffect, useState } from "react";
import { usePageQuery } from "./use-page-query";
import {
  queryInteger,
  parseCursorTrail,
  type HistoryCursor,
} from "@/lib/page-query-state";

export function useUrlTablePagination({
  pageSize = 50,
  total,
  key = "page",
}: { pageSize?: number; total?: number; key?: string } = {}) {
  const { search, update } = usePageQuery();
  const [internalTotal, setTotal] = useState<number>();
  const count = total ?? internalTotal;
  const totalPages =
    count === undefined ? null : Math.max(1, Math.ceil(count / pageSize));
  const requested = queryInteger(search.get(key));
  const page =
    totalPages === null ? requested : Math.min(requested, totalPages);
  const setPage = useCallback(
    (value: number | ((old: number) => number)) => {
      const next = Math.max(
        1,
        Math.min(
          totalPages ?? 1_000_000,
          typeof value === "function" ? value(page) : value,
        ),
      );
      update({ [key]: next === 1 ? null : String(next) });
    },
    [key, page, totalPages, update],
  );
  const reset = useCallback(() => update({ [key]: null }), [key, update]);
  useEffect(() => {
    if (page !== requested)
      update({ [key]: page === 1 ? null : String(page) }, true);
  }, [page, requested, key, update]);
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    totalPages,
    setPage,
    reset,
    setTotal,
  };
}

export function useUrlCursorPagination(key = "cursors") {
  const { search, update } = usePageQuery();
  const trail = parseCursorTrail(search.get(key));
  const pageKey = `${key}Page`;
  const page = trail.length
    ? Math.max(
        trail.length + 1,
        queryInteger(search.get(pageKey), trail.length + 1),
      )
    : 1;
  const cursor = trail.at(-1);
  const params = new URLSearchParams(cursor ? { ...cursor } : {});
  const write = (next: HistoryCursor[], nextPage: number) =>
    update({
      [key]: next.length ? JSON.stringify(next) : null,
      [pageKey]: nextPage > next.length + 1 ? String(nextPage) : null,
    });
  return {
    page,
    suffix: params.size ? `&${params}` : "",
    reset: () => write([], 1),
    previous: () => write(trail.slice(0, -1), trail.length > 1 ? page - 1 : 1),
    previousLabel: trail.length === 1 && page > 2 ? "First page" : "Previous",
    next: (next: HistoryCursor) => write([...trail, next].slice(-50), page + 1),
  };
}
