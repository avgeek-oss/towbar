"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import {
  dateTimeLabel,
  localizationGeneration,
  localizationRevision,
  serverLocalizationRevision,
  subscribeLocalization,
} from "@/lib/date-time-display";

const pending = new Map<string, Promise<unknown>>();
function requestLabels(timestamps: string[]) {
  const key = `${localizationGeneration()}:${JSON.stringify(timestamps)}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = api
    .post("/v1/core/date-time/localize", { timestamps })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export function useLocalizedTimestamps(values: Array<string | number>) {
  useSyncExternalStore(
    subscribeLocalization,
    localizationRevision,
    serverLocalizationRevision,
  );
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const generation = localizationGeneration();
  useEffect(() => {
    const refresh = () => setRetry((value) => value + 1);
    window.addEventListener("towbar:refresh", refresh);
    return () => window.removeEventListener("towbar:refresh", refresh);
  }, []);
  const missing = JSON.stringify(
    [
      ...new Set(
        values
          .filter((value) => !dateTimeLabel(value))
          .map((value) =>
            typeof value === "number" ? new Date(value).toISOString() : value,
          ),
      ),
    ].sort(),
  );
  useEffect(() => {
    let active = true;
    const timestamps = JSON.parse(missing) as string[];
    if (!timestamps.length) {
      setError(undefined);
      return;
    }
    const load = async () => {
      for (let offset = 0; active && offset < timestamps.length; offset += 2000)
        await requestLabels(timestamps.slice(offset, offset + 2000));
    };
    void load()
      .then(() => {
        if (active) setError(undefined);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load date labels",
          );
      });
    return () => {
      active = false;
    };
  }, [missing, generation, retry]);
  return { error };
}

export function useLocalizedChartTicks(start: number, end: number) {
  const ticks = useMemo(() => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    if (end <= start) return [start];
    const intervals = [
      30_000, 60_000, 300_000, 900_000, 3600_000, 10800_000, 43200_000,
      86400_000, 432000_000, 864000_000,
    ];
    const interval =
      intervals.find((value) => value >= (end - start) / 4) ??
      Math.ceil((end - start) / 4);
    const values = [];
    for (
      let tick = Math.ceil(start / interval) * interval;
      tick <= end;
      tick += interval
    )
      values.push(tick);
    return values.length >= 2 ? values : [start, end];
  }, [start, end]);
  const { error } = useLocalizedTimestamps(ticks);
  return { ticks, error };
}
