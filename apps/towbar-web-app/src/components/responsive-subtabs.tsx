"use client";
import { routePermission, useAccess } from "./access-context";

import { HugeiconsIcon } from "@hugeicons/react";
import { menuIcons } from "./secondary-sidebar";
import { useDetailNavigation } from "@/hooks/use-detail-navigation";
import { PageSelectionTitle } from "./page-selection-title";
import { useContext, useEffect, type Key, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@avgeek-oss/design-system/lib/utils";
import { DetailSettingsContext, SecondaryItems } from "./secondary-sidebar";

type ResponsiveSubtab = {
  actions?: ReactNode;
  badge?: ReactNode;
  titleBadge?: ReactNode;
  content: ReactNode;
  destructive?: boolean;
  group?: string;
  disabledReason?: string;
  isDisabled?: boolean;
  icon?: ReactNode;
  label: string;
  value: string;
};

export function ResponsiveSubtabs({
  ariaLabel,
  defaultSelectedKey,
  onSelectionChange,
  panelClassName,
  selectedKey,
  tabs,
}: {
  ariaLabel: string;
  collapseOnMobile?: boolean;
  defaultSelectedKey: string;
  layout?: "inline" | "sidebar";
  onSelectionChange?: (key: Key) => void;
  panelClassName?: string;
  selectedKey?: string;
  sidebarWidth?: "default" | "wide";
  tabs: ResponsiveSubtab[];
}) {
  const detail = useDetailNavigation();
  const { can } = useAccess();
  tabs = tabs.filter((tab) => {
    const permission = routePermission(
      detail.base ? detail.href("settings", tab.value) : tab.value,
    );
    return !permission || can(permission);
  });
  const detailSettings = useContext(DetailSettingsContext);
  const pathname = usePathname();
  const search = useSearchParams();
  const parameter = ariaLabel.endsWith("settings")
    ? "settings"
    : ariaLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const requested =
    selectedKey ??
    (detailSettings !== null
      ? detail.settings
      : detail.base && detail.section === "info"
        ? (detail.subpage ?? search.get(parameter))
        : search.get(parameter)) ??
    defaultSelectedKey;
  const active =
    tabs.find((tab) => tab.value === requested && !tab.isDisabled) ??
    tabs.find((tab) => !tab.isDisabled);
  const routeSection =
    detailSettings !== null
      ? "settings"
      : detail.base && detail.section === "info"
        ? "info"
        : null;
  useEffect(() => {
    if (
      detail.base &&
      routeSection &&
      detailSettings !== false &&
      active &&
      (!detail.subpage || active.value !== requested)
    ) {
      window.history.replaceState(
        null,
        "",
        detail.href(routeSection, active.value, true),
      );
    }
  }, [detail, routeSection, detailSettings, active, requested]);
  function select(key: string) {
    if (routeSection && detail.base) {
      window.history.pushState(null, "", detail.href(routeSection, key));
      window.scrollTo(0, 0);
      onSelectionChange?.(key);
      return;
    }
    if (selectedKey === undefined) {
      const params = new URLSearchParams(search.toString());
      params.set(parameter, key);
      if (detailSettings !== null) params.set("section", "settings");
      window.history.pushState(null, "", `${pathname}?${params}`);
    }
    onSelectionChange?.(key);
  }
  return (
    <>
      {detailSettings !== false && active ? (
        <PageSelectionTitle
          actions={active.actions}
          badge={active.titleBadge}
          label={active.label}
          icon={
            active.icon ??
            (menuIcons[active.value] ? (
              <HugeiconsIcon
                aria-hidden="true"
                icon={menuIcons[active.value]!}
              />
            ) : undefined)
          }
          keepEntityName={!!detail.base}
        />
      ) : null}
      {Array.from(new Set(tabs.map((tab) => tab.group))).map((group) => (
        <SecondaryItems
          key={group ?? ariaLabel}
          title={group ?? (detailSettings !== null ? "Settings" : ariaLabel)}
          selected={detailSettings === false ? "" : (active?.value ?? "")}
          onSelect={select}
          items={tabs
            .filter((tab) => tab.group === group)
            .map((tab) => ({
              id: tab.value,
              label: tab.label,
              icon: tab.icon,
              badge: tab.badge,
              destructive: tab.destructive,
              disabled: tab.isDisabled,
              disabledReason: tab.disabledReason,
            }))}
        />
      ))}
      {detailSettings !== false ? (
        <DetailSettingsContext.Provider value={null}>
          <div className={cn("min-w-0", panelClassName)}>{active?.content}</div>
        </DetailSettingsContext.Provider>
      ) : null}
    </>
  );
}
