"use client";
import { QueryRefreshNotice } from "./query-refresh-notice";
import { UnsavedChangesBoundary } from "./unsaved-changes-boundary";
import { NextNavigationProvider } from "@avgeek-oss/design-system/adapters/next";
import { DemoBoundary, isPublicDemo } from "./demo-session";
import { groupDeployableInstances } from "@/lib/deployable-groups";
import { ReauthenticationDialog } from "./reauthentication-dialog";
import { AccessContext, routePermission } from "./access-context";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { ThemeSwitcher } from "@avgeek-oss/design-system/controls/theme-switcher";
import { AlertDialog } from "@avgeek-oss/design-system/overlays/alert-dialog";
import {
  clearApiQueryCache,
  prefetchApiQueries,
  refreshApiQueries,
} from "@/hooks/use-api-query";
import { SecondarySidebarLayout } from "./secondary-sidebar";

import { useCallback, useEffect, useRef, useState } from "react";
import { Logout01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { usePathname } from "next/navigation";
import { useRouter } from "@/hooks/use-guarded-router";

import type {
  App,
  Deployment,
  Resource,
  Server,
  Source,
  TowbarUser,
  TowbarUpdateInfo,
} from "@workspace/towbar-web-client";
import { AppLayout } from "@avgeek-oss/design-system/navigation/app-layout";
import {
  AppShell,
  ApplicationNavbar,
  ApplicationSidebar,
  usePersistentAppSidebar,
} from "@avgeek-oss/design-system/layouts/app-shell";
import { BackendUnavailable } from "@avgeek-oss/design-system/patterns/feedback/backend-unavailable";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { Toast } from "@avgeek-oss/design-system/overlays/toast";

import { api } from "@/lib/api";
import { createSessionRefresh } from "@/lib/session-refresh";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  applicationHeader,
  applicationPolicy,
  createApplicationSidebar,
} from "@/lib/application-layout";
import { RelativeTimeProvider } from "./last-synced-time";
import { getActiveDeploymentStates } from "@/lib/inventory-status";
import { NotificationCenter } from "@/components/notification-center";
import { AccountMenu } from "@/components/account-menu";
import { HeadingHelpContext } from "@avgeek-oss/design-system/overlays/heading-help";
import { headingDocumentation } from "@/lib/documentation";

export function ApplicationFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (isPublicDemo && pathname === "/demo") return children;
  const frame = (
    <UnsavedChangesBoundary>
      <AuthenticatedFrame>{children}</AuthenticatedFrame>
    </UnsavedChangesBoundary>
  );
  return (
    <NextNavigationProvider>
      {isPublicDemo ? <DemoBoundary>{frame}</DemoBoundary> : frame}
    </NextNavigationProvider>
  );
}

const navigationPrefetchPaths: Record<string, string[]> = {
  "/": [
    "/v1/core/apps",
    "/v1/core/resources",
    "/v1/core/servers",
    "/v1/core/deployments",
    "/v1/core/deployments/history?page=1&limit=6",
  ],
  "/deployments": [
    "/v1/core/servers",
    "/v1/core/deployments/history?page=1&limit=10&",
  ],
  "/servers": ["/v1/core/servers", "/v1/core/apps", "/v1/core/resources"],
  "/repositories": ["/v1/core/sources"],
  "/services": [
    "/v1/core/apps",
    "/v1/core/deployments",
    "/v1/core/sources",
    "/v1/core/servers",
  ],
  "/datastores": [
    "/v1/core/resources",
    "/v1/core/deployments",
    "/v1/core/sources",
    "/v1/core/servers",
  ],
  "/monitoring/incidents": [
    "/v1/core/monitoring/incidents?state=active&severity=all&limit=20",
  ],
  "/monitoring/vulnerabilities": [
    "/v1/core/monitoring/vulnerabilities?severity=all&page=1&limit=20",
  ],
  "/manage/ssh-keys": ["/v1/core/settings/private-keys"],
  "/manage/shared-secrets": ["/v1/core/settings/secrets"],
  "/manage/notifications": ["/v1/core/notifications/providers"],
  "/manage/integrations": ["/v1/core/integrations"],
  "/team-settings": ["/v1/core/team"],
  "/system-health": ["/v1/core/system-health"],
};

function AuthenticatedFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const navigationSequence = useRef(0);
  const navigate = useCallback(
    (href: string) => {
      const sequence = ++navigationSequence.current;
      const paths = navigationPrefetchPaths[href];
      if (!paths) {
        router.push(href);
        return;
      }
      void (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            prefetchApiQueries(paths).catch(() => undefined),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, 800);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        if (sequence === navigationSequence.current) router.push(href);
      })();
    },
    [router],
  );
  const [user, setUser] = useState<TowbarUser | null>();
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const [isSignOutConfirming, setIsSignOutConfirming] = useState(false);
  const apps = useApiQuery<{ apps: App[] }>(
    user && !user.mustChangePassword ? "/v1/core/apps" : null,
    30_000,
  );
  const resources = useApiQuery<{ resources: Resource[] }>(
    user && !user.mustChangePassword ? "/v1/core/resources" : null,
    30_000,
  );
  const servers = useApiQuery<{ servers: Server[] }>(
    user && !user.mustChangePassword ? "/v1/core/servers" : null,
    30_000,
  );
  const sources = useApiQuery<{ sources: Source[] }>(
    user && !user.mustChangePassword ? "/v1/core/sources" : null,
    30_000,
  );
  const manifestLifecycle = useApiQuery<
    import("@workspace/towbar-contracts").ManifestLifecycleResponse
  >(
    user && !user.mustChangePassword
      ? "/v1/core/manifest-lifecycle?limit=1"
      : null,
    (data) => (data?.counts.removing ? 3_000 : 30_000),
  );
  const monitoring = useApiQuery<{
    activeIncidents: number;
    criticalVulnerabilities: number;
  }>(
    user && !user.mustChangePassword ? "/v1/core/monitoring/summary" : null,
    30_000,
  );
  const version = useApiQuery<TowbarUpdateInfo>(
    user && !user.mustChangePassword ? "/v1/core/version" : null,
    15 * 60_000,
  );
  const deployments = useApiQuery<{ deployments: Deployment[] }>(
    user && !user.mustChangePassword ? "/v1/core/deployments" : null,
    5_000,
  );
  const sidebarState = usePersistentAppSidebar("towbar-sidebar");
  const isLogin = pathname === "/login" || pathname === "/setup";
  const isPublicAuth =
    isLogin ||
    pathname.startsWith("/invite/") ||
    [
      "/oauth/consent",
      "/forgot-password",
      "/verification",
      "/reset-password",
      "/verify-email",
      "/confirm-email-change",
      "/first-password",
    ].includes(pathname);
  const userRef = useRef(user);
  userRef.current = user;
  const isSessionTransition = pathname === "/logout";
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "towbar:preferences-revision") refreshApiQueries();
    };
    window.addEventListener("towbar:preferences-changed", refreshApiQueries);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(
        "towbar:preferences-changed",
        refreshApiQueries,
      );
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  useEffect(() => {
    if (isSessionTransition) return;
    const session = createSessionRefresh({
      // Public auth state also supports verified invitees without a membership.
      load: () => api.get<{ user: TowbarUser | null }>("/v1/public/auth/state"),
      onUser: (nextUser) => {
        setSessionUnavailable(false);
        if (JSON.stringify(userRef.current) !== JSON.stringify(nextUser)) {
          clearApiQueryCache();
          userRef.current = nextUser;
          setUser(nextUser);
        }
      },
      onUnavailable: () => setSessionUnavailable(true),
    });
    const refresh = () => void session.refresh();
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("towbar:access-error", refresh);
    window.addEventListener("towbar:identity-changed", refresh);
    window.addEventListener("towbar:refresh", refresh);
    return () => {
      session.stop();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("towbar:access-error", refresh);
      window.removeEventListener("towbar:identity-changed", refresh);
      window.removeEventListener("towbar:refresh", refresh);
    };
  }, [isSessionTransition, pathname]);
  useEffect(() => {
    if (isSessionTransition || user === undefined) return;
    if (user?.mustChangePassword && pathname !== "/first-password") {
      router.replace("/first-password");
      return;
    }
    if (isLogin && user) {
      router.replace("/");
      return;
    }
    if (!isPublicAuth && user === null)
      router.replace(
        isPublicDemo
          ? "/demo?ended=1"
          : `/login?next=${encodeURIComponent(pathname)}`,
      );
  }, [isLogin, isPublicAuth, isSessionTransition, pathname, router, user]);

  if (isSessionTransition) return children;
  if (isPublicAuth)
    return (
      <AccessContext.Provider value={user ?? null}>
        {children}
        <Toast.Provider placement="bottom" />
      </AccessContext.Provider>
    );
  if ((!user || user.mustChangePassword) && sessionUnavailable)
    return <BackendUnavailable appName="Towbar" />;
  if (!user || user.mustChangePassword) {
    return (
      <div className="grid min-h-dvh place-items-center p-6" aria-busy="true">
        <Spinner aria-label="Loading Towbar" color="warning" />
      </div>
    );
  }
  const baseSidebar = createApplicationSidebar(
    {
      apps: apps.data
        ? groupDeployableInstances(apps.data.apps).length
        : undefined,
      resources: resources.data
        ? groupDeployableInstances(resources.data.resources).length
        : undefined,
      conflicts: manifestLifecycle.data?.counts.conflicts,
      retirements: manifestLifecycle.data?.counts.retirements,
      servers: servers.data?.servers.length,
      sources: sources.data?.sources.length,
    },
    monitoring.error ? undefined : monitoring.data,
    user,
  );
  const sidebar = {
    ...baseSidebar,
    groups: baseSidebar.groups.map((group) => ({
      ...group,
      items: group.items.map((item) =>
        item.kind === "link" &&
        item.id === "deployments" &&
        deployments.data &&
        getActiveDeploymentStates(deployments.data.deployments).size > 0
          ? {
              ...item,
              trailing: (
                <Spinner
                  aria-label="Deployments in progress"
                  className="ms-auto shrink-0 text-warning-soft-foreground"
                  color="current"
                  size="sm"
                />
              ),
            }
          : item,
      ),
    })),
    ...(version.data ? { brandVersion: version.data.installedVersion } : {}),
    brandUpdateHref: "/system-health",
    brandUpdateVersion:
      !version.error && version.data?.status === "available"
        ? (version.data.latestVersion ?? undefined)
        : undefined,
    footerContent: (
      <AccountMenu
        user={user}
        onLogoutRequest={() => setIsSignOutConfirming(true)}
      />
    ),
  };
  return (
    <AccessContext.Provider value={user}>
      <HeadingHelpContext.Provider
        value={(title, kind) => headingDocumentation(pathname, title, kind)}
      >
        <AppShell contentWidth="full" policy={applicationPolicy}>
          <AppLayout
            navigate={navigate}
            navbar={
              <ApplicationNavbar
                actions={
                  <div className="flex items-center gap-2">
                    <NotificationCenter />
                    <div className="flex items-center gap-1">
                      <ThemeSwitcher />
                    </div>
                  </div>
                }
                config={applicationHeader}
                hasSidebar
                sidebarOpen={sidebarState.sidebarOpen}
                onSidebarToggle={() =>
                  sidebarState.onSidebarOpenChange(!sidebarState.sidebarOpen)
                }
              />
            }
            scrollMode="page"
            sidebar={<ApplicationSidebar config={sidebar} />}
            sidebarCollapsible="icon"
            toggleShortcut
            {...sidebarState}
          >
            <SecondarySidebarLayout>
              <AppShell.Content
                className={
                  pathname === "/monitoring/logs"
                    ? "px-0 pt-0 pb-0 sm:pt-0 sm:pb-0"
                    : "pt-0 pb-20 sm:pt-0 sm:pb-20"
                }
                variant={pathname === "/monitoring/logs" ? "full" : "broad"}
              >
                <RelativeTimeProvider>
                  <QueryRefreshNotice />
                  {routePermission(pathname) &&
                  !user.capabilities?.includes(routePermission(pathname)!) ? (
                    <EmptyState>
                      <EmptyState.Header>
                        <EmptyState.Title>Access restricted</EmptyState.Title>
                        <EmptyState.Description>
                          Your current role does not have access to this page.
                          Contact a team admin if you need access.
                        </EmptyState.Description>
                      </EmptyState.Header>
                      <EmptyState.Content>
                        <Button onPress={() => navigate("/")}>
                          Back to overview
                        </Button>
                      </EmptyState.Content>
                    </EmptyState>
                  ) : (
                    children
                  )}
                </RelativeTimeProvider>
              </AppShell.Content>
            </SecondarySidebarLayout>
          </AppLayout>
        </AppShell>
        <SignOutConfirmation
          isOpen={isSignOutConfirming}
          onOpenChange={setIsSignOutConfirming}
          onSignOut={() => router.push("/logout")}
        />
        <ReauthenticationDialog />
      </HeadingHelpContext.Provider>
    </AccessContext.Provider>
  );
}

function SignOutConfirmation({
  isOpen,
  onOpenChange,
  onSignOut,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSignOut: () => void;
}) {
  return (
    <AlertDialog.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Heading>Sign out of Towbar?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            This ends the current Towbar session on this browser. To manage
            other sessions, check your personal settings.
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button onPress={() => onOpenChange(false)} variant="secondary">
              Stay signed in
            </Button>
            <Button
              onPress={() => {
                onOpenChange(false);
                onSignOut();
              }}
              variant="danger"
            >
              <HugeiconsIcon
                aria-hidden="true"
                className="size-4"
                icon={Logout01Icon}
              />
              Sign out
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
