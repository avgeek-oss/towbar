"use client";
import {
  McpServerIcon,
  ComputerIcon,
  Key01Icon,
  UserAccountIcon,
  FingerPrintIcon,
  Mail01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { settingsPageLabels } from "@avgeek-oss/design-system/patterns/settings/page-title";
import { HugeiconsIcon } from "@hugeicons/react";
import { DashboardPage } from "./page-parts";
import { SecondaryItems } from "./secondary-sidebar";
import { ApiMcpSettings } from "./api-mcp-settings";
import { PasskeySettings } from "./passkey-settings";
import { DateTimePreferencesSettings } from "./date-time-preferences";
import {
  ProfileSettings,
  EmailPasswordSettings,
  SessionSettings,
} from "./settings-pages";
import { canShowApiMcpSettings } from "@/lib/config";

type AccountSettingsPage =
  | "profile"
  | "preferences"
  | "email-password"
  | "sessions"
  | "passkeys"
  | "mcp-connections"
  | "api-keys"
  | "mcp";

export function AccountSettings({ page }: { page: AccountSettingsPage }) {
  const accountSettingsGroups: ReadonlyArray<{
    title: string;
    pages: readonly AccountSettingsPage[];
  }> = [
    { title: "Account", pages: ["profile", "preferences"] },
    { title: "Security", pages: ["email-password", "passkeys", "sessions"] },
    ...(canShowApiMcpSettings()
      ? [
          {
            title: "API & MCP",
            pages: ["api-keys", "mcp-connections", "mcp"] as const,
          },
        ]
      : []),
  ];
  const titles = settingsPageLabels;
  const icons = {
    profile: UserAccountIcon,
    preferences: Settings01Icon,
    "email-password": Mail01Icon,
    sessions: ComputerIcon,
    passkeys: FingerPrintIcon,
    "api-keys": Key01Icon,
    "mcp-connections": McpServerIcon,
    mcp: McpServerIcon,
  };
  return (
    <DashboardPage
      title={titles[page]}
      breadcrumbAncestors={[
        { label: "Account Settings", href: "/settings/profile" },
      ]}
      icon={icons[page]}
      contentOwnsTitle={page === "passkeys"}
    >
      {accountSettingsGroups.map((group) => (
        <SecondaryItems
          key={group.title}
          title={group.title}
          selected={page}
          items={group.pages.map((id) => ({
            id,
            href: `/settings/${id}`,
            label: titles[id],
            icon: <HugeiconsIcon aria-hidden="true" icon={icons[id]} />,
          }))}
        />
      ))}
      {page === "profile" ? (
        <ProfileSettings />
      ) : page === "preferences" ? (
        <DateTimePreferencesSettings />
      ) : page === "email-password" ? (
        <EmailPasswordSettings />
      ) : page === "passkeys" ? (
        <PasskeySettings />
      ) : page === "sessions" ? (
        <SessionSettings />
      ) : (
        <ApiMcpSettings
          section={page === "api-keys" ? "personal-keys" : page}
        />
      )}
    </DashboardPage>
  );
}
