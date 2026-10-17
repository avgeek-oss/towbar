"use client";

import {
  TableCellStack,
  TableCellDescription,
  tableCellDescriptionClassName,
} from "@avgeek-oss/design-system/data-display/table-cell-text";

import Image, { type ImageLoaderProps } from "next/image";
import { useState, type ReactNode } from "react";
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
  InternetIcon,
  WebhookIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  App,
  Resource,
  RuntimeCapacity,
} from "@workspace/towbar-web-client";
import {
  Tooltip,
  TooltipText,
} from "@avgeek-oss/design-system/overlays/tooltip";
import { InlineLink } from "./page-parts";
import { DomainLink } from "./domain-link";
import { CapacityPressureIndicator } from "./capacity-pressure-indicator";

function externalImageLoader({ src }: ImageLoaderProps) {
  return src;
}

export function AppIdentity({
  app,
  showIndicators = true,
  runtime,
}: {
  app: App;
  showIndicators?: boolean;
  runtime?: RuntimeCapacity["runtimes"][number];
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
          showIndicators={showIndicators}
          pressureIndicator={
            <CapacityPressureIndicator
              limits={app.config.container.resources}
              runtime={runtime}
            />
          }
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
          <TableCellDescription className="opacity-50">
            Not publicly exposed
          </TableCellDescription>
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
      key={`${deploymentId ?? appId ?? "domain"}:${domain ?? ""}`}
      retryAt={query.data?.expiresAt}
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
  retryAt,
}: {
  sources: string[];
  size: "default" | "small" | "compact";
  retryAt?: number;
}) {
  const [failure, setFailure] = useState<{
    retryAt?: number;
    sources: string[];
  }>({ retryAt, sources: [] });
  const [loadedSource, setLoadedSource] = useState<string>();
  const failed = failure.retryAt === retryAt ? failure.sources : [];
  const src = sources.find((source) => !failed.includes(source));
  function markFailed(source: string) {
    setLoadedSource((previous) => (previous === source ? undefined : previous));
    setFailure((previous) => ({
      retryAt,
      sources: [
        ...(previous.retryAt === retryAt ? previous.sources : []),
        source,
      ],
    }));
  }
  const visibleSource =
    loadedSource && (src || sources.includes(loadedSource))
      ? loadedSource
      : undefined;
  const imageSources = [
    ...new Set(
      [visibleSource, src].filter((source): source is string =>
        Boolean(source),
      ),
    ),
  ];
  const pixels = size === "compact" ? 16 : size === "small" ? 24 : 32;
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-sm ${size === "compact" ? "size-4" : size === "small" ? "size-6" : "size-8"}`}
    >
      {!visibleSource ? (
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
      {imageSources.map((source) => (
        <Image
          key={source}
          alt=""
          className={`object-contain ${size === "compact" ? "size-4" : size === "small" ? "size-6" : "size-8"} ${visibleSource === source ? "" : "absolute opacity-0"}`}
          height={pixels}
          loader={externalImageLoader}
          loading="eager"
          decoding="sync"
          unoptimized
          width={pixels}
          src={source}
          onError={() => markFailed(source)}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setLoadedSource(source);
            } else {
              markFailed(source);
            }
          }}
          referrerPolicy="no-referrer"
        />
      ))}
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
  showIndicators,
  pressureIndicator,
}: {
  autoDeploy: boolean;
  name: string;
  href: string;
  exposed: boolean;
  showIndicators: boolean;
  pressureIndicator: ReactNode;
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
  ];
  return (
    <span className="flex max-w-full min-w-0 items-center gap-2">
      <InlineLink className="min-w-0" href={href}>
        <TooltipText className="block truncate" tabIndex={-1} tooltip={name}>
          {name}
        </TooltipText>
      </InlineLink>
      {showIndicators ? (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          {indicators.map(({ icon, positive, label }) => (
            <TooltipText
              key={label}
              aria-label={label}
              tooltip={label}
              className={`inline-flex size-5 shrink-0 items-center justify-center leading-none ${positive ? "text-success-soft-foreground" : "text-danger-soft-foreground"}`}
              role="img"
            >
              <HugeiconsIcon
                aria-hidden="true"
                className="size-4"
                icon={icon}
              />
            </TooltipText>
          ))}
          {pressureIndicator}
        </span>
      ) : null}
    </span>
  );
}

export function ResourceIdentity({
  resource,
  showIndicators = true,
  runtime,
}: {
  resource: Resource;
  showIndicators?: boolean;
  runtime?: RuntimeCapacity["runtimes"][number];
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
          showIndicators={showIndicators}
          pressureIndicator={
            <CapacityPressureIndicator
              limits={resource.config.container.resources}
              runtime={runtime}
            />
          }
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
