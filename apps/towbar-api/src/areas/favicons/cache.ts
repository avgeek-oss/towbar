import { discoverIcon } from "./discovery.js";

export type FaviconResult = { icon: string | null; expiresAt: number };

export function createIconCache(discover = discoverIcon, now = Date.now) {
  const cached = new Map<string, FaviconResult>();
  const pending = new Map<string, Promise<FaviconResult>>();
  return async (
    workspaceId: string,
    domain: string | null,
  ): Promise<FaviconResult> => {
    const missing = () => ({ icon: null, expiresAt: now() + 30_000 });
    if (!domain) return missing();
    const key = `${workspaceId}:${domain}`;
    const previous = cached.get(key);
    if (previous && previous.expiresAt > now()) return previous;
    const active = pending.get(key);
    if (active) return active;
    if (pending.size >= 8) return missing();
    const request = (async () => {
      let icon: string | null;
      try {
        icon = await discover(domain);
      } catch {
        icon = null;
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
