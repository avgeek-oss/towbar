import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { CpuIcon, RamMemoryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Server } from "@workspace/towbar-web-client";
import { formatBytes } from "./runtime-operations";
import { CloudProviderLogo } from "./cloud-provider-logo";

export function ServerHardwareDescription({
  hardware,
  showProvider = true,
}: {
  hardware?: Server["hardware"];
  showProvider?: boolean;
}) {
  if (hardware?.instance?.type)
    return (
      <ServerInstanceDescription
        instance={hardware.instance}
        showProvider={showProvider}
      />
    );
  if (!hardware?.cpuCount && !hardware?.memoryBytes)
    return hardware?.instance ? (
      <ServerInstanceDescription
        instance={hardware.instance}
        showProvider={showProvider}
      />
    ) : (
      <span>Unknown Instance Type</span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {hardware.instance && showProvider ? (
        <ServerProviderLogo provider={hardware.instance.provider} />
      ) : null}
      {hardware.cpuCount ? (
        <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3.5 shrink-0"
            icon={CpuIcon}
          />
          {hardware.cpuCount} vCPU
        </span>
      ) : null}
      {hardware.memoryBytes ? (
        <span
          aria-label={`Memory: ${formatBytes(hardware.memoryBytes)}`}
          className="inline-flex items-center gap-0.5 whitespace-nowrap"
        >
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3.5 shrink-0"
            icon={RamMemoryIcon}
          />
          {formatBytes(hardware.memoryBytes)}
        </span>
      ) : null}
    </span>
  );
}

const providerNames = {
  aws: "Amazon Web Services",
  azure: "Microsoft Azure",
  gcp: "Google Cloud",
  oracle: "Oracle Cloud",
  hetzner: "Hetzner",
  digitalocean: "DigitalOcean",
  linode: "Akamai / Linode",
  alibaba: "Alibaba Cloud",
} as const;

function ServerInstanceDescription({
  instance,
  showProvider,
}: {
  showProvider: boolean;
  instance: NonNullable<NonNullable<Server["hardware"]>["instance"]>;
}) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle">
      {showProvider ? (
        <ServerProviderLogo provider={instance.provider} />
      ) : null}
      <TooltipText
        className="min-w-0 truncate"
        tooltip={instance.type ?? providerNames[instance.provider]}
      >
        {instance.type ?? providerNames[instance.provider]}
      </TooltipText>
    </span>
  );
}

export function ServerProviderLogo({
  provider,
}: {
  provider: keyof typeof providerNames;
}) {
  return (
    <TooltipText
      className="inline-flex shrink-0 items-center"
      tooltip={providerNames[provider]}
    >
      <CloudProviderLogo
        alt={providerNames[provider]}
        provider={provider}
        size={provider === "aws" ? 24 : 16}
        className="h-[1em] w-auto"
      />
    </TooltipText>
  );
}
