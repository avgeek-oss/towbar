"use client";

import {
  BookOpen01Icon,
  Key01Icon,
  Logout01Icon,
  Mail01Icon,
  Message01Icon,
  News01Icon,
  Settings01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "@/hooks/use-guarded-router";

import { repositoryUrl } from "@workspace/towbar-contracts/repository-identity";

import type { TowbarUser } from "@workspace/towbar-web-client";
import { SidebarAccountMenu } from "@avgeek-oss/design-system";

const changelogUrl = `${repositoryUrl}/blob/main/CHANGELOG.md`;
const documentationUrl = "https://www.towbar.dev/docs";

export function AccountMenu({
  user,
  onLogoutRequest,
}: {
  user: TowbarUser;
  onLogoutRequest: () => void;
}) {
  const router = useRouter();

  const onAction = (key: React.Key) => {
    switch (key) {
      case "profile":
      case "preferences":
      case "email-password":
      case "api-keys":
        router.push(`/settings/${key}`);
        break;
      case "changelog":
        window.open(changelogUrl, "_blank", "noopener,noreferrer");
        break;
      case "documentation":
        window.open(documentationUrl, "_blank", "noopener,noreferrer");
        break;
      case "feedback":
        window.open(
          `${repositoryUrl}/issues/new`,
          "_blank",
          "noopener,noreferrer",
        );
        break;
      case "logout":
        onLogoutRequest();
        break;
    }
  };

  const icon = (value: typeof UserAccountIcon) => (
    <HugeiconsIcon icon={value} />
  );
  return (
    <SidebarAccountMenu
      name={user.name}
      email={user.email}
      teamName={user.teamName}
      avatarUrl={user.avatarUrl}
      onAction={onAction}
      groups={[
        {
          id: "account",
          label: "Account",
          items: [
            { id: "profile", label: "Profile", icon: icon(UserAccountIcon) },
            {
              id: "preferences",
              label: "Preferences",
              icon: icon(Settings01Icon),
            },
            {
              id: "email-password",
              label: "Email & Password",
              icon: icon(Mail01Icon),
            },
            { id: "api-keys", label: "API Keys", icon: icon(Key01Icon) },
          ],
        },
        {
          id: "towbar",
          label: "Towbar",
          items: [
            { id: "changelog", label: "Changelog", icon: icon(News01Icon) },
            {
              id: "documentation",
              label: "Documentation",
              icon: icon(BookOpen01Icon),
            },
            {
              id: "feedback",
              label: "Leave Feedback",
              icon: icon(Message01Icon),
            },
          ],
        },
        {
          id: "session",
          label: "Session",
          items: [
            {
              id: "logout",
              label: "Sign out",
              icon: icon(Logout01Icon),
              destructive: true,
            },
          ],
        },
      ]}
    />
  );
}
