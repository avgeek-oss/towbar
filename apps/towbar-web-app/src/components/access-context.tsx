"use client";
import { createContext, useContext } from "react";
import type { TowbarUser } from "@workspace/towbar-web-client";
import type { Action } from "@workspace/towbar-access";
export const AccessContext = createContext<TowbarUser | null>(null);
export function useAccess() {
  const user = useContext(AccessContext);
  return {
    user,
    can: (permission: Action) =>
      user?.capabilities?.includes(permission) === true,
  };
}
export function routePermission(pathname: string): Action | null {
  if (pathname === "/monitoring/logs") return "logs.read";
  if (pathname === "/servers/new") return "server.update";
  if (
    pathname.startsWith("/manage/integrations") ||
    pathname.startsWith("/team-settings/integrations")
  )
    return "integration.manage";
  if (
    pathname.startsWith("/manage/ssh-keys") ||
    pathname.startsWith("/team-settings/ssh-keys")
  )
    return "privateKey.manage";
  if (
    pathname.startsWith("/manage/shared-secrets") ||
    pathname.startsWith("/team-settings/shared-secrets")
  )
    return "sharedSecret.list";
  if (pathname.startsWith("/team-settings")) return "team.read";
  if (pathname.startsWith("/manage/notifications"))
    return "notification.manage";
  if (pathname.startsWith("/system-health")) return "system.read";
  if (
    pathname.startsWith("/manage/private-keys") ||
    pathname.startsWith("/manage/api-mcp/private-keys")
  )
    return "privateKey.manage";
  if (pathname.startsWith("/manage/api-mcp/team-keys")) return "apikey.read";
  const section = pathname.split("/").filter(Boolean).at(-1);
  if (section === "auto-deploy") return "deployment.create";
  if (section === "notifications") return "notification.manage";
  if (section === "secrets")
    return pathname.startsWith("/repositories/")
      ? "sharedSecret.list"
      : "secret.list";
  if (pathname.startsWith("/servers/")) {
    if (section === "logs-collection") return "server.collectLogs";
    if (["credentials", "configuration"].includes(section ?? ""))
      return "server.credentials";
    if (["cleanup", "danger", "danger-zone"].includes(section ?? ""))
      return "server.remove";
  }
  if (pathname.startsWith("/repositories/") && section === "danger")
    return "repository.disconnect";
  if (pathname.startsWith("/datastores/") && section === "restore")
    return "resource.restore";
  return null;
}
