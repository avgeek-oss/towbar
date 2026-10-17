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
import { useRouter } from "@/hooks/use-guarded-router";
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
  const router = useRouter();
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
          onSelect={(value) => router.push(`/settings/${value}`)}
          items={group.pages.map((id) => ({
            id,
            label: titles[id],
            icon: <HugeiconsIcon icon={icons[id]} />,
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
