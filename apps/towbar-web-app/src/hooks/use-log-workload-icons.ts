"use client";
import { useEffect, useState } from "react";
import { DashboardCircleIcon } from "@hugeicons/core-free-icons";

import type { App, Resource } from "@workspace/towbar-web-client";
import { api } from "@/lib/api";
import { resourceImageBrand } from "@/components/resource-image-brand";
import bundledFavicons from "@/components/service-favicon-catalog.json";

export const fallbackLogWorkloadIcon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#71717a" stroke-width="1.5">${DashboardCircleIcon.map(([, attributes]) => `<path d="${attributes.d}"/>`).join("")}</svg>`)}`;

export function useLogWorkloadIcons(
  apps: App[] | undefined,
  resources: Resource[] | undefined,
) {
  const [favicons, setFavicons] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    void Promise.allSettled(
      (apps ?? []).map(async (app) => {
        const result = await api.get<{ icon: string | null }>(
          `/v1/core/apps/${app.id}/favicon`,
        );
        return result.icon ? ([app.id, result.icon] as const) : null;
      }),
    ).then((results) => {
      if (active)
        setFavicons(
          Object.fromEntries(
            results.flatMap((result) =>
              result.status === "fulfilled" && result.value
                ? [result.value]
                : [],
            ),
          ),
        );
    });
    return () => {
      active = false;
    };
  }, [apps]);
  const icons: Record<string, string> = { ...favicons };
  for (const app of apps ?? []) {
    const deployment =
      "deployment" in app.config ? app.config.deployment : undefined;
    const brand =
      deployment?.type === "image"
        ? resourceImageBrand("image", deployment.image)
        : null;
    const domain = app.config.domains?.primary;
    const bundled = domain
      ? (bundledFavicons as Record<string, string>)[domain]
      : undefined;
    const source = brand?.label !== "Image" ? brand?.logo : undefined;
    if (source || icons[app.id] || bundled)
      icons[app.id] = source ?? icons[app.id] ?? bundled!;
  }
  for (const resource of resources ?? [])
    icons[resource.id] = resourceImageBrand(
      resource.kind,
      resource.config.image,
    ).logo;
  return icons;
}
