"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TowbarApiError } from "@workspace/towbar-web-client";
import { setRefreshFailure } from "./query-refresh-failures";

import { api } from "@/lib/api";
import { clearDateTimeLabels } from "@/lib/date-time-display";
import { canKeepQueryData, canUseStaleData } from "./api-query-state";

type ApiQueryCacheEntry = {
  cachedAt?: number;
  data?: unknown;
  promise?: Promise<unknown>;
};

const apiQueryCache = new Map<string, ApiQueryCacheEntry>();
let cacheGeneration = 0;
const freshCacheDurationMs = 10_000;

function getCachedApiQuery<T>(path: string | null) {
  if (!path) return undefined;
  return apiQueryCache.get(path)?.data as T | undefined;
}

async function loadApiQuery<T>(path: string, force = false): Promise<T> {
  const cached = apiQueryCache.get(path);
  if (cached?.promise) return cached.promise as Promise<T>;
  if (!force) {
    if (
      cached?.data !== undefined &&
      cached.cachedAt !== undefined &&
      Date.now() - cached.cachedAt < freshCacheDurationMs
    ) {
      return cached.data as T;
    }
  }

  const generation = cacheGeneration;
  const promise = api.get<T>(path);
  apiQueryCache.set(path, { ...cached, promise });
  try {
    const data = await promise;
    if (generation === cacheGeneration)
      apiQueryCache.set(path, { cachedAt: Date.now(), data });
    return data;
  } catch (error) {
    if (apiQueryCache.get(path)?.promise === promise) {
      if (
        cached?.data !== undefined &&
        canUseStaleData(
          error instanceof TowbarApiError ? error.status : undefined,
        )
      )
        apiQueryCache.set(path, { ...cached, cachedAt: 0, promise: undefined });
      else apiQueryCache.delete(path);
    }
    throw error;
  }
}

export function prefetchApiQueries(paths: string[]) {
  return Promise.all(paths.map((path) => loadApiQuery(path)));
}

export function clearApiQueryCache() {
  clearDateTimeLabels();
  cacheGeneration += 1;
  apiQueryCache.clear();
  window.dispatchEvent(new Event("towbar:clear-private-data"));
}
export function refreshApiQueries() {
  apiQueryCache.clear();
  window.dispatchEvent(new Event("towbar:refresh"));
}

export function useApiQuery<T>(
  path: string | null,
  refreshMs?: number | ((data: T | undefined) => number),
  { keepPreviousData = true }: { keepPreviousData?: boolean } = {},
) {
  const [result, setResult] = useState<
    { data: T; path: string; generation: number } | undefined
  >(() => {
    const data = getCachedApiQuery<T>(path);
    return path && data !== undefined
      ? { data, path, generation: cacheGeneration }
      : undefined;
  });
  const [failure, setFailure] = useState<{
    message: string;
    path: string;
    status?: number;
  }>();
  const failureId = useRef(Symbol("query-refresh"));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const pollingMs =
    typeof refreshMs === "function"
      ? refreshMs(
          result?.path === path && result.generation === cacheGeneration
            ? result.data
            : getCachedApiQuery<T>(path),
        )
      : refreshMs;
  useEffect(() => {
    if (!path) return;
    let active = true;
    let requestActive = false;
    let refreshQueued = false;
    const load = async (force = false) => {
      if (requestActive) {
        if (force) refreshQueued = true;
        return;
      }
      const generation = cacheGeneration;
      requestActive = true;
      if (active) setIsRefreshing(true);
      try {
        const result = await loadApiQuery<T>(path, force);
        if (active && generation === cacheGeneration) {
          setResult({ data: result, path, generation });
          setFailure(undefined);
        }
      } catch (cause) {
        if (active && generation === cacheGeneration)
          setFailure({
            message: cause instanceof Error ? cause.message : "Request failed",
            path,
            status: cause instanceof TowbarApiError ? cause.status : undefined,
          });
      } finally {
        requestActive = false;
        if (active) setIsRefreshing(false);
        if (active && refreshQueued) {
          refreshQueued = false;
          void load(true);
        }
      }
    };
    const handleRefresh = () => void load(true);
    const handleClear = () => {
      setResult(undefined);
      setFailure(undefined);
      setRevision((value) => value + 1);
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) void load(true);
    };
    void load(revision > 0);
    const timer = pollingMs
      ? setInterval(() => {
          if (!document.hidden) void load(true);
        }, pollingMs)
      : undefined;
    window.addEventListener("towbar:refresh", handleRefresh);
    window.addEventListener("towbar:clear-private-data", handleClear);
    if (pollingMs)
      document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
      window.removeEventListener("towbar:refresh", handleRefresh);
      window.removeEventListener("towbar:clear-private-data", handleClear);
      if (pollingMs)
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
    };
  }, [path, pollingMs, revision]);
  const availableResult =
    result?.generation === cacheGeneration ? result : undefined;
  const currentData =
    availableResult?.path === path
      ? availableResult.data
      : getCachedApiQuery<T>(path);
  const isPreviousData =
    currentData === undefined &&
    availableResult !== undefined &&
    canKeepQueryData(availableResult.path, path, keepPreviousData);
  const currentFailure = failure?.path === path ? failure : undefined;
  const stale =
    currentData !== undefined &&
    currentFailure !== undefined &&
    canUseStaleData(currentFailure.status);
  useEffect(() => {
    const id = failureId.current;
    setRefreshFailure(id, stale && path ? { path, retry: refresh } : undefined);
    return () => setRefreshFailure(id);
  }, [stale, path, refresh]);
  return {
    data: currentData ?? (isPreviousData ? availableResult?.data : undefined),
    isPreviousData,
    error: currentFailure && !stale ? currentFailure.message : undefined,
    refreshError: stale ? currentFailure.message : undefined,
    isRefreshing,
    refresh,
  };
}
