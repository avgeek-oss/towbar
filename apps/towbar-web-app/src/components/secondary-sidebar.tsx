"use client";

import type { ComponentProps } from "react";
import { SecondaryItems as LibrarySecondaryItems } from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  SquareActivityIcon,
  CleanIcon,
  Delete02Icon,
  Menu01Icon,
  DashboardCircleIcon,
  Settings01Icon,
  Key01Icon,
  SourceCodeIcon,
  ReloadIcon,
  Rocket01Icon,
  PlugSocketIcon,
  ServerStack01Icon,
  Notification01Icon,
  GitBranchIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";

export {
  DetailSettingsContext,
  SecondarySidebarLayout,
  SecondarySection,
  SecondaryEntityHeader,
  type SecondaryItem,
} from "@avgeek-oss/design-system/navigation/secondary-sidebar";

export const menuIcons: Record<string, typeof Menu01Icon> = {
  credentials: Key01Icon,
  monitoring: SquareActivityIcon,
  cleanup: CleanIcon,
  danger: Delete02Icon,
  backups: ReloadIcon,
  backup: ReloadIcon,
  restore: Undo02Icon,
  preview: Rocket01Icon,
  keys: Key01Icon,
  "private-keys": Key01Icon,
  api: SourceCodeIcon,
  mcp: SourceCodeIcon,
  configuration: Settings01Icon,
  connection: PlugSocketIcon,
  "auto-deploy": Rocket01Icon,
  secrets: Key01Icon,
  manifest: SourceCodeIcon,
  "sync-history": ReloadIcon,
  "source-control": GitBranchIcon,
  cloud: ServerStack01Icon,
  notifications: Notification01Icon,
};

export function SecondaryItems({
  items,
  ...props
}: ComponentProps<typeof LibrarySecondaryItems>) {
  return (
    <LibrarySecondaryItems
      {...props}
      items={items.map((item) => ({
        ...item,
        icon: item.icon ?? (
          <HugeiconsIcon
            aria-hidden="true"
            icon={menuIcons[item.id] ?? DashboardCircleIcon}
          />
        ),
      }))}
    />
  );
}
