"use client";

import { usePathname, useSearchParams } from "next/navigation";

import { useRouter } from "./use-guarded-router";

export function useDetailNavigation() {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const match = pathname.match(
    /^(\/(?:services|datastores)\/[^/]+\/deployments\/[^/]+|\/(?:services|datastores)\/[^/]+|\/repositories\/[^/]+\/syncs\/[^/]+|\/servers\/[^/]+|\/repositories\/[^/]+)(?:\/(.*))?$/,
  );
  const base = match?.[1];
  const parts = match?.[2]?.split("/") ?? [];
  const section = parts[0] ?? search.get("section");
  const settings = parts[0] === "settings" ? parts[1] : search.get("settings");
  function href(
    nextSection: string,
    nextSettings?: string,
    preserveQuery = false,
  ) {
    const params = new URLSearchParams(preserveQuery ? search.toString() : "");
    params.delete("section");
    params.delete("settings");
    params.delete("source-information");
    const query = params.toString();
    return `${base}/${nextSection}${nextSettings ? `/${nextSettings}` : ""}${query ? `?${query}` : ""}`;
  }
  return { base, section, settings, subpage: parts[1], href, router, pathname };
}
