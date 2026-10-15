"use client";

import {
  TableCellStack,
  TableCellDescription,
  tableCellDescriptionClassName,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import Image, { type ImageLoaderProps } from "next/image";
import { useState } from "react";
import { useApiQuery } from "@/hooks/use-api-query";
import bundledFavicons from "./service-favicon-catalog.json";
import {
  resourceImageBrand,
  resourceImageDescription,
  type ResourceBrand,
} from "./resource-image-brand";
import {
  DashboardCircleIcon,
  DatabaseIcon,
  HeartPulseIcon,
  InternetIcon,
  WebhookIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { App, Resource } from "@workspace/towbar-web-client";
import {
  Tooltip,
  TooltipText,
} from "@avgeek-oss/design-system/overlays/tooltip";
import { InlineLink } from "./page-parts";
import { DomainLink } from "./domain-link";

function externalImageLoader({ src }: ImageLoaderProps) {
  return src;
}

export function AppIdentity({
  app,
  healthStatus = app.runtimeState.healthStatus,
}: {
  app: App;
  healthStatus?: App["runtimeState"]["healthStatus"];
}) {
  const domains = [
    ...new Set(
      [
        app.config.domains?.primary,
        ...(app.config.domains?.redirects.map(({ host }) => host) ?? []),
      ].filter((domain): domain is string => Boolean(domain)),
    ),
  ];
  const primaryDomain = domains[0];

  return (
    <span className="flex w-full min-w-0 items-center gap-3">
      <ServiceLogo app={app} />
      <TableCellStack className="flex-1">
        <DeployableName
          autoDeploy={Boolean(app.config.autoDeploy)}
          name={app.name}
          href={`/services/${app.id}`}
          exposed={domains.length > 0}
          health={healthStatus}
        />
        {primaryDomain && domains.length === 1 ? (
          <TooltipText
            className={`${tableCellDescriptionClassName} flex max-w-64 min-w-0 items-center gap-0.5 truncate`}
            tooltip={primaryDomain}
          >
            <DomainLink
              className="truncate"
              domain={primaryDomain}
              showTooltip={false}
            >
              {primaryDomain}
            </DomainLink>
          </TooltipText>
        ) : primaryDomain ? (
          <Tooltip>
            <Tooltip.Trigger
              render={(props) => <span {...props} />}
              aria-label={`Domains: ${domains.join(", ")}`}
              className={`${tableCellDescriptionClassName} flex max-w-64 min-w-0 items-center gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm`}
            >
              <DomainLink
                className="truncate"
                domain={primaryDomain}
                showTooltip={false}
              >
                {primaryDomain}
              </DomainLink>
              {domains.length > 1 ? (
                <span className="shrink-0 tabular-nums">
                  +{domains.length - 1}
                </span>
              ) : null}
            </Tooltip.Trigger>
            <Tooltip.Content
              className="max-w-64 whitespace-normal break-normal text-xs [overflow-wrap:normal] [word-break:normal]"
              placement="top"
              showArrow
            >
              <Tooltip.Arrow />
              <span className="grid gap-1">
                {domains.map((domain) => (
                  <DomainLink
                    className="whitespace-nowrap"
                    domain={domain}
                    key={domain}
                    showTooltip={false}
                  >
                    {domain}
                  </DomainLink>
                ))}
              </span>
            </Tooltip.Content>
          </Tooltip>
        ) : (
          <TableCellDescription>Not publicly exposed</TableCellDescription>
        )}
      </TableCellStack>
    </span>
  );
}

export function AppLogo({
  domain,
  appId,
  deploymentId,
  size = "default",
}: {
  domain: string | undefined;
  appId?: string;
  deploymentId?: string;
  size?: "default" | "small" | "compact";
}) {
  const bundled = domain
    ? (bundledFavicons as Record<string, string>)[domain]
    : undefined;
  const query = useApiQuery<{ icon: string | null; expiresAt: number }>(
    deploymentId
      ? `/v1/core/deployments/${deploymentId}/favicon`
      : appId
        ? `/v1/core/apps/${appId}/favicon`
        : null,
    60_000,
    { keepPreviousData: false },
  );
  return (
    <AppLogoImage
      key={`${deploymentId ?? appId ?? domain}:${query.data?.expiresAt ?? "pending"}`}
      sources={[query.data?.icon, bundled].filter((src): src is string =>
        Boolean(src),
      )}
      size={size}
    />
  );
}

function AppLogoImage({
  sources,
  size,
}: {
  sources: string[];
  size: "default" | "small" | "compact";
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const [loadedSource, setLoadedSource] = useState<string>();
  const src = sources.find((source) => !failed.includes(source));
  const loaded = Boolean(src && loadedSource === src);
  const pixels = size === "compact" ? 16 : size === "small" ? 24 : 32;
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-sm ${size === "compact" ? "size-4" : size === "small" ? "size-6" : "size-8"}`}
    >
      {!loaded ? (
        <HugeiconsIcon
          aria-hidden="true"
          className={
            size === "compact"
              ? "size-4"
              : size === "small"
                ? "size-5"
                : "size-6"
          }
          icon={DashboardCircleIcon}
        />
      ) : null}
      {src ? (
        <Image
          key={src}
          alt=""
          className={`object-contain ${size === "compact" ? "size-4" : size === "small" ? "size-6" : "size-8"} ${loaded ? "" : "absolute opacity-0"}`}
          height={pixels}
          loader={externalImageLoader}
          loading="eager"
          decoding="sync"
          unoptimized
          width={pixels}
          src={src}
          onError={() => {
            setFailed((previous) => [...previous, src]);
          }}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setLoadedSource(src);
            } else {
              setFailed((previous) => [...previous, src]);
            }
          }}
          referrerPolicy="no-referrer"
        />
      ) : null}
    </span>
  );
}

export function ServiceLogo({
  app,
  size = "default",
}: {
  app: App;
  size?: "default" | "small" | "compact";
}) {
  const deployment =
    "deployment" in app.config ? app.config.deployment : undefined;
  if (deployment?.type === "image") {
    const brand = resourceImageBrand("image", deployment.image);
    if (brand.label !== "Image")
      return <ResourceLogo brand={brand} size={size} />;
  }
  const domain =
    app.config.domains?.primary ?? app.config.domains?.redirects[0]?.host;
  return <AppLogo key={app.id} appId={app.id} domain={domain} size={size} />;
}

function DeployableName({
  autoDeploy,
  name,
  href,
  exposed,
  health,
}: {
  autoDeploy: boolean;
  name: string;
  href: string;
  exposed: boolean;
  health: App["runtimeState"]["healthStatus"];
}) {
  const indicators = [
    {
      icon: WebhookIcon,
      positive: autoDeploy,
      label: autoDeploy ? "Auto-deploy enabled" : "Auto-deploy disabled",
    },
    {
      icon: InternetIcon,
      positive: exposed,
      label: exposed
        ? "Publicly exposed to the internet"
        : "Not publicly exposed",
    },
    {
      icon: HeartPulseIcon,
      positive: health === "healthy",
      label: {
        healthy: "Healthy",
        unhealthy: "Unhealthy",
        starting: "Health check starting",
        unknown: "Health unknown",
        none: "No health status reported",
      }[health],
    },
  ];
  return (
    <span className="flex max-w-full min-w-0 items-center gap-2">
      <InlineLink className="min-w-0" href={href}>
        <TooltipText className="block truncate" tabIndex={-1} tooltip={name}>
          {name}
        </TooltipText>
      </InlineLink>
      <span className="inline-flex shrink-0 items-center gap-0.5">
        {indicators.map(({ icon, positive, label }) => (
          <TooltipText
            key={label}
            aria-label={label}
            tooltip={label}
            className={`inline-flex size-5 shrink-0 items-center justify-center leading-none ${positive ? "text-success-soft-foreground" : "text-danger-soft-foreground"}`}
            role="img"
          >
            <HugeiconsIcon aria-hidden="true" className="size-4" icon={icon} />
          </TooltipText>
        ))}
      </span>
    </span>
  );
}

export function ResourceIdentity({
  resource,
  healthStatus = resource.runtimeState.healthStatus,
}: {
  resource: Resource;
  healthStatus?: Resource["runtimeState"]["healthStatus"];
}) {
  const type = resourceImageBrand(resource.kind, resource.config.image);
  return (
    <span className="flex w-full min-w-0 items-center gap-3">
      <ResourceLogo key={type.logo} brand={type} />
      <TableCellStack className="flex-1">
        <DeployableName
          autoDeploy={Boolean(resource.config.autoDeploy)}
          name={resource.name}
          href={`/datastores/${resource.id}`}
          exposed={Boolean(resource.config.domains?.primary)}
          health={healthStatus}
        />
        <TableCellDescription>
          {resourceImageDescription(resource.kind, resource.config.image)}
        </TableCellDescription>
      </TableCellStack>
    </span>
  );
}

export function ResourceLogo({
  brand,
  size = "default",
}: {
  brand: ResourceBrand;
  size?: "default" | "small" | "compact";
}) {
  const [failed, setFailed] = useState(false);
  const logo = brand.logo;
  const dark = brand.logoDark;
  if (failed || logo === "/resource-types/image.png") {
    return (
      <HugeiconsIcon
        aria-hidden="true"
        icon={DatabaseIcon}
        className={`shrink-0 ${size === "compact" ? "size-4" : size === "small" ? "size-6" : "size-8"}`}
      />
    );
  }
  const pixels = size === "compact" ? 16 : size === "small" ? 24 : 32;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${size === "compact" ? "size-4" : size === "small" ? "size-6" : "size-8"} ${brand.darkBackground && !failed ? "rounded-sm bg-zinc-800 p-0.5" : ""} ${brand.darkPlate && !failed ? "rounded-sm dark:bg-white dark:p-0.5" : ""}`}
    >
      <Image
        alt=""
        className={`block max-h-full max-w-full object-contain ${size === "compact" ? "size-4" : size === "small" ? "size-6" : "size-8"} ${dark ? "dark:hidden" : ""}`}
        height={pixels}
        width={pixels}
        src={logo}
        loading="eager"
        decoding="sync"
        unoptimized
        onError={() => setFailed(true)}
      />
      {dark ? (
        <Image
          alt=""
          className={`hidden max-h-full max-w-full object-contain dark:block ${size === "compact" ? "size-4" : size === "small" ? "size-6" : "size-8"}`}
          height={pixels}
          width={pixels}
          src={dark}
          loading="eager"
          decoding="sync"
          unoptimized
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}
