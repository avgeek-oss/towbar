import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  Alert02Icon,
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  InformationCircleIcon,
  PlayIcon,
  Rocket01Icon,
  ServerStack01Icon,
  BanIcon,
  RefreshIcon,
  CrownIcon,
  EyeIcon,
  UserShield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import type { ReactNode } from "react";

const success = new Set([
  "active",
  "approved",
  "connected",
  "configured",
  "clean",
  "current",
  "success",
  "healthy",
  "in_sync",
  "online",
  "recovered",
  "live",
  "passed",
  "published",
  "ready",
  "restore_ready",
  "succeeded",
  "synced",
  "trusted",
  "verified",
]);
const warning = new Set([
  "building",
  "deleting",
  "checking_health",
  "checking_public_endpoint",
  "checking_server",
  "cleaning_up",
  "configuring_routing",
  "fetching_source",
  "preparing",
  "provisioning_tls",
  "queued",
  "resolving_secrets",
  "running",
  "running_post_deploy",
  "running_pre_deploy",
  "starting_candidate",
  "switching_traffic",
  "transferring",
  "validating_credentials",
  "degraded",
  "drifted",
  "connecting",
  "reconnecting",
  "succeeded_with_warnings",
  "unverified",
  "untrusted",
  "waiting",
  "waiting_for_server",
  "waiting_for_server_capacity",
  "waiting_for_server_check",
  "waiting_for_server_operation",
  "waiting_for_server_preparation",
  "server_setup_pending",
  "pending",
  "stale",
  "delivering",
  "findings",
  "warning",
  "attention",
  "offline",
  "retrying",
]);
const destructive = new Set([
  "blocked",
  "critical",
  "decommissioned",
  "error",
  "failed",
  "cleanup_failed",
  "suspended",
  "unhealthy",
  "not_checked",
  "not_restore_ready",
  "two_factor_disabled",
]);

const progress = new Set([
  "queued",
  "pending",
  "waiting",
  "waiting_for_server",
  "waiting_for_server_capacity",
  "waiting_for_server_check",
  "waiting_for_server_operation",
  "waiting_for_server_preparation",
  "starting",
  "installing",
  "uninstalling",
  "syncing",
  "in_progress",
  "building",
  "deleting",
  "checking_health",
  "checking_public_endpoint",
  "checking_server",
  "cleaning_up",
  "configuring_routing",
  "fetching_source",
  "preparing",
  "provisioning_tls",
  "resolving_secrets",
  "running",
  "running_post_deploy",
  "running_pre_deploy",
  "starting_candidate",
  "switching_traffic",
  "transferring",
  "validating_credentials",
  "connecting",
  "reconnecting",
  "delivering",
  "retrying",
]);

export function StatusBadge({
  status,
  context,
  icon,
  label,
  tooltip,
}: {
  status: string;
  context?: "runtime";
  icon?: ReactNode;
  label?: string;
  tooltip?: ReactNode;
}) {
  const variant =
    success.has(status) || (context === "runtime" && status === "running")
      ? "success"
      : warning.has(status) || progress.has(status)
        ? "warning"
        : destructive.has(status)
          ? "danger"
          : "default";
  const statusIcon =
    status === "admin"
      ? CrownIcon
      : status === "member"
        ? UserShield01Icon
        : status === "viewer"
          ? EyeIcon
          : status === "preview"
            ? Rocket01Icon
            : status === "production"
              ? ServerStack01Icon
              : status === "restarted"
                ? RefreshIcon
                : status === "running" && context === "runtime"
                  ? PlayIcon
                  : status === "stopped" || status === "cancelled"
                    ? BanIcon
                    : variant === "success"
                      ? CheckmarkCircle01Icon
                      : variant === "danger"
                        ? AlertCircleIcon
                        : status === "queued" ||
                            status === "pending" ||
                            status.startsWith("waiting")
                          ? Clock01Icon
                          : variant === "warning"
                            ? progress.has(status)
                              ? RefreshIcon
                              : Alert02Icon
                            : InformationCircleIcon;
  return (
    <TooltipText
      className="inline-flex"
      tooltip={tooltip ?? statusTooltip(status, context)}
    >
      <Chip color={variant}>
        <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
          {progress.has(status) &&
          !(status === "running" && context === "runtime") ? (
            <Spinner
              aria-hidden="true"
              color="current"
              size="sm"
              className="size-3.5 shrink-0"
            />
          ) : (
            (icon ?? <HugeiconsIcon aria-hidden icon={statusIcon} />)
          )}
          {label ?? formatStatus(status)}
        </Chip.Label>
      </Chip>
    </TooltipText>
  );
}

function statusTooltip(status: string, context?: "runtime") {
  if (status === "running" && context === "runtime")
    return "The workload is currently running.";
  return (
    {
      active: "This item is enabled and available for use.",
      admin: "Admins can manage every team and deployment setting.",
      approved: "This change has been approved.",
      archived: "This item is retained for history and cannot run new work.",
      blocked: "Progress is stopped until the blocking condition is resolved.",
      building: "The deployment image is being built.",
      cancelled: "The operation was cancelled before completion.",
      checking_health: "Towbar is waiting for the workload health check.",
      checking_public_endpoint: "Towbar is validating the public endpoint.",
      checking_server:
        "Towbar is checking the server configuration and capacity.",
      clean: "The observed configuration matches the desired configuration.",
      cleanup_failed: "Cleanup stopped before every item could be removed.",
      cleaning_up:
        "Towbar is removing deployment artifacts and runtime objects.",
      connected: "The integration is connected and ready to use.",
      connecting: "Towbar is establishing the connection.",
      critical: "This condition requires immediate attention.",
      current: "This is the session currently in use.",
      degraded: "The item is operating with a condition that needs attention.",
      decommissioned: "This item has been permanently taken out of service.",
      deleting: "Deletion is currently in progress.",
      delivering: "The notification is being sent to its destination.",
      disabled: "This capability is currently turned off.",
      disconnected: "The connection has been removed or is unavailable.",
      drifted:
        "The observed configuration differs from the desired configuration.",
      error: "The latest operation ended with an error.",
      expired:
        "This credential can no longer be used because its expiry time passed.",
      failed: "The latest operation did not complete successfully.",
      findings: "The latest scan found issues that need review.",
      healthy: "The latest health check passed.",
      inactive: "This item is not currently active.",
      in_sync:
        "The applied configuration matches the current source configuration.",
      live: "This revision is currently serving traffic.",
      member:
        "Members can update secret values and alert rules, and manage their own access.",
      not_restore_ready: "The available backup cannot currently be restored.",
      not_checked: "Health checks cannot run until server setup is complete.",
      offline: "No recent report has been received.",
      online: "Recent reports are arriving normally.",
      passed: "The latest check completed successfully.",
      pending: "Towbar is waiting for required work or checks to finish.",
      preparing:
        "Towbar is installing and validating the server prerequisites.",
      preview: "This deployment belongs to a pull-request preview environment.",
      production: "This deployment belongs to the production environment.",
      published: "This item has been published successfully.",
      queued: "The operation is waiting for an available worker.",
      ready: "Setup is complete and the item can accept work.",
      reconnecting: "Towbar is restoring the connection.",
      recovered: "The triggering condition cleared and the incident recovered.",
      restarted: "The workload process restarted at this point.",
      restore_ready:
        "The backup has the metadata and credentials needed for restore.",
      retrying: "Towbar is retrying after a failed attempt.",
      revoked: "This credential has been revoked and can no longer be used.",
      running: "The operation is currently in progress.",
      server_setup_pending:
        "Complete server setup before workloads can run here.",
      stale:
        "The most recent result is older than the expected reporting window.",
      stopped: "The workload is not currently running.",
      succeeded: "The latest operation completed successfully.",
      succeeded_with_warnings:
        "The operation completed, but some items need review.",
      suspended: "This item has been prevented from running.",
      synced: "The latest source synchronization completed successfully.",
      trusted: "This identity has been explicitly trusted.",
      two_factor_disabled: "Two-factor authentication is not enabled.",
      unhealthy: "The latest health check failed.",
      not_deployed: "This workload has not been deployed yet.",
      unknown:
        "Towbar does not have enough recent information to determine the state.",
      untrusted: "This identity has not been trusted yet.",
      unverified: "This item has not completed verification.",
      verified: "The latest verification completed successfully.",
      viewer: "Viewers have read-only access.",
      waiting: "The operation is waiting for a prerequisite.",
      waiting_for_server: "The operation is waiting for a server assignment.",
      waiting_for_server_capacity:
        "The assigned server does not currently have enough free capacity.",
      waiting_for_server_check:
        "The operation is waiting for a successful server check.",
      waiting_for_server_operation:
        "Another server operation must finish first.",
      waiting_for_server_preparation:
        "The operation is waiting for server setup to complete.",
      warning: "This condition needs attention but is not currently critical.",
    } as Record<string, string | undefined>
  )[status];
}

export function formatStatus(status: string) {
  if (status === "none") return "No health check";
  if (status === "not_checked") return "Not checked";
  if (status === "not_deployed") return "Not deployed";
  return status
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
