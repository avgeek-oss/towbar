import type { Action } from "@workspace/towbar-access";
import type { TowbarUser } from "@workspace/towbar-web-client";
import {
  AlignLeftIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  AlertCircleIcon,
  DashboardCircleIcon,
  DiscoverSquareIcon,
  Delete02Icon,
  DatabaseIcon,
  GitBranchIcon,
  HealthIcon,
  Notification01Icon,
  PlugSocketIcon,
  Rocket01Icon,
  SecurityCheckIcon,
  ServerStack01Icon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { createElement } from "react";

import packageManifest from "../../../../package.json";
import { TowbarBrandLogo } from "@workspace/towbar-web-ui/brand";
import type {
  ApplicationPolicy,
  HeaderConfig,
  SidebarConfig,
} from "@avgeek-oss/design-system/layouts/application-shell-types";
import { defineSidebarIcons } from "@avgeek-oss/design-system/layouts/sidebar-icons";

const sidebarIcons = defineSidebarIcons({
  incidents: AlertCircleIcon,
  apps: DashboardCircleIcon,
  deployments: Rocket01Icon,
  health: HealthIcon,
  overview: DiscoverSquareIcon,
  profile: UserAccountIcon,
  resources: DatabaseIcon,
  vulnerabilities: SecurityCheckIcon,
  servers: ServerStack01Icon,
  sessions: ComputerIcon,
  sources: GitBranchIcon,
});

export type ApplicationSidebarCounts = Partial<
  Record<
    "apps" | "resources" | "servers" | "sources" | "conflicts" | "retirements",
    number
  >
>;

const inventorySingularLabels = {
  conflicts: "conflict",
  retirements: "retirement",
  apps: "service",
  resources: "datastore",
  servers: "server",
  sources: "repository",
} as const;

const inventoryPluralLabels = {
  conflicts: "conflicts",
  retirements: "retirements",
  apps: "services",
  resources: "datastores",
  servers: "servers",
  sources: "repositories",
} as const;

const brand = {
  accessibleLabel: "Towbar home",
  id: "towbar",
  logo: createElement(TowbarBrandLogo),
  title: "Towbar",
} as const;

export const applicationHeader = {
  brand,
  homeHref: "/",
} satisfies HeaderConfig;

const sidebar = {
  accessibleLabel: "Towbar navigation",
  brand,
  brandVersion: packageManifest.version,
  homeHref: "/",
  groups: [
    {
      id: "overview",
      label: "Dashboard",
      items: [
        {
          kind: "link",
          id: "overview",
          label: "Overview",
          href: "/",
          icon: sidebarIcons.overview,
        },
        {
          kind: "link",
          id: "conflicts",
          label: "Conflicts",
          href: "/conflicts",
          icon: AlertCircleIcon,
        },
        {
          kind: "link",
          id: "retirements",
          label: "Retirements",
          href: "/retirements",
          icon: Delete02Icon,
        },
        {
          kind: "link",
          id: "deployments",
          label: "Deployments",
          href: "/deployments",
          icon: sidebarIcons.deployments,
        },
      ],
    },
    {
      id: "operate",
      label: "Operate",
      items: [
        {
          kind: "link",
          id: "servers",
          label: "Servers",
          href: "/servers",
          icon: sidebarIcons.servers,
        },
        {
          kind: "link",
          id: "sources",
          label: "Repositories",
          href: "/repositories",
          icon: sidebarIcons.sources,
        },
        {
          kind: "link",
          id: "apps",
          label: "Services",
          href: "/services",
          icon: sidebarIcons.apps,
        },
        {
          kind: "link",
          id: "resources",
          label: "Datastores",
          href: "/datastores",
          icon: sidebarIcons.resources,
        },
      ],
    },
    {
      id: "monitoring",
      label: "Monitor",
      items: [
        {
          kind: "link",
          id: "logs",
          label: "Logs",
          href: "/monitoring/logs",
          icon: AlignLeftIcon,
        },
        {
          kind: "link",
          id: "incidents",
          label: "Incidents",
          href: "/monitoring/incidents",
          icon: sidebarIcons.incidents,
        },
        {
          kind: "link",
          id: "vulnerabilities",
          label: "Vulnerabilities",
          href: "/monitoring/vulnerabilities",
          icon: sidebarIcons.vulnerabilities,
        },
      ],
    },
    {
      id: "workspace",
      label: "Manage",
      items: [
        {
          kind: "link",
          id: "ssh-keys",
          label: "SSH keys",
          href: "/manage/ssh-keys",
          icon: ComputerTerminal01Icon,
        },
        {
          kind: "link",
          id: "notifications",
          label: "Notifications",
          href: "/manage/notifications",
          icon: Notification01Icon,
        },
        {
          kind: "link",
          id: "integrations",
          label: "Integrations",
          href: "/manage/integrations",
          preserveSubroute: true,
          icon: PlugSocketIcon,
        },
      ],
    },
    {
      id: "settings",
      label: "Settings",
      items: [
        {
          kind: "link",
          id: "account-settings",
          label: "Account Settings",
          href: "/settings/profile",
          activePath: "/settings",
          icon: sidebarIcons.profile,
        },
        {
          kind: "link",
          id: "team-settings",
          label: "Team Settings",
          href: "/team-settings/general",
          activePath: "/team-settings",
          icon: UserGroupIcon,
        },
        {
          kind: "link",
          id: "health",
          label: "System health",
          href: "/system-health",
          icon: sidebarIcons.health,
        },
      ],
    },
  ],
  persistenceKey: "towbar-sidebar",
} satisfies SidebarConfig;

export function createApplicationSidebar(
  counts: ApplicationSidebarCounts = {},
  monitoring?: {
    activeIncidents: number;
    criticalVulnerabilities: number;
  },
  user?: TowbarUser,
) {
  return {
    ...sidebar,
    groups: sidebar.groups
      .map((group) => ({
        ...group,
        items: group.items
          .map((item) =>
            item.id === "team-settings" &&
            user &&
            !user.capabilities?.includes("team.read")
              ? { ...item, href: "/team-settings/workspace-secrets" }
              : item,
          )
          .filter((item) => {
            if (item.id === "conflicts" || item.id === "retirements")
              return (counts[item.id] ?? 0) > 0;
            const permissions: Record<string, Action> = {
              health: "system.read",
              integrations: "integration.manage",
              notifications: "notification.manage",
              "ssh-keys": "privateKey.manage",
            };
            if (item.id === "team-settings")
              return (
                !user ||
                user.capabilities?.includes("team.read") ||
                user.capabilities?.includes("sharedSecret.list")
              );
            return (
              !user ||
              !permissions[item.id] ||
              user.capabilities?.includes(permissions[item.id]!)
            );
          }),
      }))
      .filter((group) => group.items.length > 0)
      .map((group) =>
        group.id === "operate" || group.id === "overview"
          ? {
              ...group,
              items: group.items.map((item) => {
                const id = item.id as keyof ApplicationSidebarCounts;
                const value = counts[id];
                const singular = inventorySingularLabels[id];
                const plural = inventoryPluralLabels[id];
                return value === undefined || value < 1 || !singular
                  ? item
                  : {
                      ...item,
                      badge: {
                        label: `${value} ${value === 1 ? singular : plural}`,
                        value,
                        ...(id === "conflicts" || id === "retirements"
                          ? { tone: "danger" as const }
                          : {}),
                      },
                    };
              }),
            }
          : group.id === "monitoring"
            ? {
                ...group,
                items: group.items.map((item) => {
                  const value =
                    item.id === "incidents"
                      ? monitoring?.activeIncidents
                      : item.id === "vulnerabilities"
                        ? monitoring?.criticalVulnerabilities
                        : undefined;
                  return !value
                    ? item
                    : {
                        ...item,
                        badge: {
                          value,
                          tone: "danger" as const,
                          label:
                            item.id === "incidents"
                              ? `${value} active incident${value === 1 ? "" : "s"}`
                              : `${value} critical or high vulnerabilit${value === 1 ? "y" : "ies"}`,
                        },
                      };
                }),
              }
            : group,
      ),
  } satisfies SidebarConfig;
}

export const applicationPolicy = {
  kind: "internal",
  themeControl: "header",
  toasts: true,
} satisfies ApplicationPolicy;
