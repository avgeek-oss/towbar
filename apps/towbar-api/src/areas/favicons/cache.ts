import { loadIcon } from "./discovery.js";

export type WorkloadIconResult = { icon: string | null; expiresAt: number };

export function createIconCache(load = loadIcon, now = Date.now) {
  const cached = new Map<string, WorkloadIconResult>();
  const pending = new Map<string, Promise<WorkloadIconResult>>();
  const waiting: Array<() => void> = [];
  let running = 0;
  function acquire() {
    if (running < 8) {
      running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  }
  return async (
    workspaceId: string,
    source: string | null,
  ): Promise<WorkloadIconResult> => {
    const missing = () => ({ icon: null, expiresAt: now() + 30_000 });
    if (!source) return missing();
    const key = `${workspaceId}:${source}`;
    const previous = cached.get(key);
    if (previous && previous.expiresAt > now()) return previous;
    const active = pending.get(key);
    if (active) return active;
    if (pending.size >= 128) return missing();
    const request = (async () => {
      await acquire();
      let icon: string | null;
      try {
        icon = await load(source);
      } catch {
        icon = null;
      } finally {
        const next = waiting.shift();
        if (next) next();
        else running--;
      }
      const result = { icon, expiresAt: now() + (icon ? 300_000 : 30_000) };
      cached.delete(key);
      if (cached.size >= 128) cached.delete(cached.keys().next().value!);
      cached.set(key, result);
      return result;
    })();
    pending.set(key, request);
    try {
      return await request;
    } finally {
      pending.delete(key);
    }
  };
}

export const cachedIcon = createIconCache();
