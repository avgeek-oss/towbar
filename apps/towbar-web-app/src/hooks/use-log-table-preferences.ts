"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import {
  logTablePreferencesSchema,
  type LogTablePreferences,
} from "@workspace/towbar-contracts";
import { api } from "@/lib/api";
import { defaultLogColumns } from "@/components/log-explorer-model";

const endpoint = "/v1/core/profile/preferences/logs-table";
const pendingWrites = new Map<string, Promise<void>>();
const defaults: LogTablePreferences = {
  visibleColumns: defaultLogColumns,
  columnWidths: {},
  customColumns: [],
};

function persist(userId: string, preferences: LogTablePreferences) {
  let valid = true;
  const invalidate = () => {
    valid = false;
  };
  window.addEventListener("towbar:clear-private-data", invalidate);
  // Serialize snapshots so a slower request cannot replace a newer layout.
  const write = (pendingWrites.get(userId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      if (valid) await api.put(endpoint, preferences);
    })
    .finally(() => {
      window.removeEventListener("towbar:clear-private-data", invalidate);
      if (pendingWrites.get(userId) === write) pendingWrites.delete(userId);
    });
  pendingWrites.set(userId, write);
  return write;
}

export function useLogTablePreferences(userId: string | undefined) {
  const [saved, setSaved] = useState<{
    userId: string;
    value: LogTablePreferences;
  }>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const current = useRef(defaults);
  const generation = useRef(0);
  const active = useRef(false);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const clear = () => {
      generation.current++;
      setSaved(undefined);
      current.current = defaults;
      reload();
    };
    window.addEventListener("towbar:clear-private-data", clear);
    return () => window.removeEventListener("towbar:clear-private-data", clear);
  }, [reload]);
  useEffect(() => {
    if (!userId) return;
    let valid = true;
    const request = ++generation.current;
    setSaved(undefined);
    setError(undefined);
    const load = async () => {
      await pendingWrites.get(userId)?.catch(() => undefined);
      if (!valid || generation.current !== request) return;
      const result = await api.get<{ preferences: LogTablePreferences | null }>(
        endpoint,
      );
      if (!valid || generation.current !== request) return;
      const value =
        result.preferences === null
          ? defaults
          : logTablePreferencesSchema.parse(result.preferences);
      current.current = value;
      setSaved({ userId, value });
    };
    void load().catch((cause: unknown) => {
      if (valid && generation.current === request)
        setError(
          cause instanceof Error ? cause.message : "Could not load log columns",
        );
    });
    return () => {
      valid = false;
    };
  }, [userId, revision]);
  const ready = !!saved && saved.userId === userId;
  function update(
    change: (value: LogTablePreferences) => LogTablePreferences,
    save = true,
  ) {
    if (!ready || !userId) return;
    const next = change(current.current);
    current.current = next;
    setSaved({ userId, value: next });
    if (save) {
      const request = generation.current;
      void persist(userId, next).catch((cause: unknown) => {
        if (active.current && request === generation.current)
          toast.danger("Couldn't save log columns", {
            description:
              cause instanceof Error
                ? cause.message
                : "Try changing the columns again.",
          });
      });
    }
  }
  return {
    preferences: ready ? saved.value : defaults,
    ready,
    error,
    reload,
    update,
  };
}
