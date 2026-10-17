import {
  ContainerIcon,
  FileCodeIcon,
  InternetIcon,
  Layers01Icon,
  PackageIcon,
  TrainIcon,
  DashboardCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Image from "next/image";
import type { App } from "@workspace/towbar-web-client";

const deploymentLabels = {
  buildpack: "Buildpacks",
  dockerfile: "Dockerfile",
  image: "OCI image",
  nixpacks: "Nixpacks",
  railpack: "Railpack",
  static: "Static site",
} as const;

export function serviceTypeLabel(app: App): string {
  if (app.config.kind === "compose") return "Compose";
  return deploymentLabels[app.config.deployment?.type ?? "dockerfile"];
}

const deploymentIcons = {
  buildpack: Layers01Icon,
  dockerfile: FileCodeIcon,
  image: ContainerIcon,
  nixpacks: PackageIcon,
  railpack: TrainIcon,
  static: InternetIcon,
} as const;

const deploymentLogos: Partial<
  Record<keyof typeof deploymentIcons | "compose", string>
> = {
  compose: "/service-type-logos/compose.png",
  dockerfile: "/resource-logos/docker.webp",
  image: "/service-type-logos/oci.svg",
  nixpacks: "/service-type-logos/nixpacks.ico",
};

export function ServiceType({ app }: { app: App }) {
  const type =
    app.config.kind === "compose"
      ? "compose"
      : (app.config.deployment?.type ?? "dockerfile");
  const logo = deploymentLogos[type];
  const icon =
    app.config.kind === "compose"
      ? DashboardCircleIcon
      : deploymentIcons[app.config.deployment?.type ?? "dockerfile"];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {logo ? (
        <Image
          src={logo}
          alt=""
          aria-hidden="true"
          width={16}
          height={16}
          unoptimized
          className={`size-4 shrink-0 object-contain ${type === "image" ? "dark:invert" : ""}`}
        />
      ) : (
        <HugeiconsIcon
          icon={icon}
          className="size-4 shrink-0 text-muted"
          aria-hidden="true"
        />
      )}
      {serviceTypeLabel(app)}
    </span>
  );
}
