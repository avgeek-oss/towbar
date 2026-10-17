"use client";
import { useSyncExternalStore } from "react";

const failures = new Map<symbol, { path: string; retry: () => void }>();
const listeners = new Set<() => void>();
let revision = 0;
export function setRefreshFailure(
  id: symbol,
  failure?: { path: string; retry: () => void },
) {
  if (failure) failures.set(id, failure);
  else if (!failures.delete(id)) return;
  revision++;
  for (const listener of listeners) listener();
}
export function useRefreshFailures() {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => revision,
    () => 0,
  );
  return [...failures.values()];
}
