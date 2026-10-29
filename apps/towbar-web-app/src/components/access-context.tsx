"use client";
import { createContext, useContext } from "react";
import type { TowbarUser } from "@workspace/towbar-web-client";
import type { Scope } from "@workspace/towbar-access";
export const AccessContext = createContext<TowbarUser | null>(null);
export function useAccess() {
  const user = useContext(AccessContext);
  return {
    user,
    can: (permission: Scope) =>
      user?.capabilities?.includes(permission) === true,
  };
}
export function routePermission(pathname: string): Scope | null {
  if (["/conflicts", "/retirements"].includes(pathname)) return "viewer";
  if (pathname === "/monitoring/logs") return "viewer";
  if (pathname === "/servers/new") return "admin";
  if (
    pathname.startsWith("/manage/integrations") ||
    pathname.startsWith("/team-settings/integrations")
  )
    return "admin";
  if (
    pathname.startsWith("/manage/ssh-keys") ||
    pathname.startsWith("/team-settings/ssh-keys")
  )
    return "admin";
  if (
    pathname.startsWith("/manage/shared-secrets") ||
    pathname.startsWith("/team-settings/shared-secrets") ||
    pathname.startsWith("/team-settings/workspace-secrets")
  )
    return "member";
  if (pathname.startsWith("/team-settings")) return "admin";
  if (pathname.startsWith("/manage/notifications")) return "admin";
  if (pathname.startsWith("/system-health")) return "admin";
  if (
    pathname.startsWith("/manage/private-keys") ||
    pathname.startsWith("/manage/api-mcp/private-keys")
  )
    return "admin";
  if (pathname.startsWith("/manage/api-mcp/team-keys")) return "admin";
  const section = pathname.split("/").filter(Boolean).at(-1);
  if (section === "auto-deploy") return "admin";
  if (section === "notifications") return "admin";
  if (section === "secrets") return "member";
  if (pathname.startsWith("/servers/")) {
    if (section === "logs-collection") return "admin";
    if (["credentials", "configuration"].includes(section ?? ""))
      return "admin";
    if (["cleanup", "danger", "danger-zone"].includes(section ?? ""))
      return "admin";
  }
  if (pathname.startsWith("/repositories/") && section === "danger")
    return "admin";
  if (pathname.startsWith("/datastores/") && section === "restore")
    return "admin";
  return null;
}
