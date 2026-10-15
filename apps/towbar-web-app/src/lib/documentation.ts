import type {
  HeadingDocumentation,
  HeadingKind,
} from "@avgeek-oss/design-system/overlays/heading-help";

const docsOrigin = "https://www.towbar.dev";
function guide(path: string, description: string): HeadingDocumentation {
  return {
    href: `${docsOrigin}/docs${path.startsWith("#") ? "" : "/"}${path}`,
    description,
  };
}

export const documentationTopics = {
  auditLogs: guide(
    "team-settings#audit-logs",
    "Browse captured team activity by event and user. Open an event to inspect its target, attribution, and metadata.",
  ),
  deliveries: guide(
    "integrations/notifications#delivery-history",
    "Review notification delivery status across providers, including attempts, errors, and retry times.",
  ),
  overview: guide(
    "#start-with-the-overview",
    "Check workload health, recent deployments, server capacity, and incidents across your team.",
  ),
  repositories: guide(
    "repositories",
    "Connect GitHub repositories, map environments to branches, and sync the services and datastores declared in Git.",
  ),
  sync: guide(
    "repositories#change-configuration",
    "Review the commit, imported inventory, changes, and validation issues from one repository sync.",
  ),
  apps: guide(
    "services",
    "Services build from source or run a prebuilt image on a prepared server. Choose an environment to view its current state.",
  ),
  resources: guide(
    "datastores",
    "Datastores run managed database and cache engines on your servers.",
  ),
  deployments: guide(
    "deployments",
    "A deployment records one attempt to build or pull an image, check its health, and put it into service.",
  ),
  progress: guide(
    "deployments#read-the-final-result",
    "Follow recorded deployment stages and their duration. A queued request is still waiting to run.",
  ),
  centralizedLogs: guide(
    "operate/centralized-logs",
    "Search retained workload logs in external ClickHouse, inspect collection, and control access with your current role.",
  ),
  logs: guide(
    "troubleshooting#collect-useful-diagnostics",
    "Read captured output for this operation or workload. Logs can help explain build, startup, and health-check failures.",
  ),
  previews: guide(
    "previews",
    "Run isolated service instances for eligible pull requests, with separate preview secrets and automatic cleanup.",
  ),
  domains: guide(
    "domains-tls",
    "Review primary domains, alternate redirects, and Compose service routes. Domain and TLS settings are configured in the service manifest.",
  ),
  servers: guide(
    "servers",
    "Register an Ubuntu server, configure trusted SSH access, and prepare it to run services and datastores.",
  ),
  logCollection: guide(
    "operate/log-collection#enable-a-server-collector",
    "Install and manage Towbar’s native collector for this server. Logs are stored in your external ClickHouse database and searched in Monitor → Logs.",
  ),
  preparation: guide(
    "servers/setup",
    "Follow connection checks and prerequisite installation. Expand a step for its details and duration.",
  ),
  credentials: guide(
    "servers/register",
    "Choose a stored SSH key, verify the connection, and trust the server's host fingerprint before preparation.",
  ),
  capacity: guide(
    "servers#read-capacity-and-health",
    "Compare current CPU, memory, and disk use with the server's capacity. Missing measurements do not mean zero usage.",
  ),
  cleanup: guide(
    "servers/operations#clean-up-leftover-workloads",
    "Review containers, images, and volumes left behind on this server before choosing what to remove.",
  ),
  removal: guide(
    "servers/remove",
    "Remove this server from Towbar after reviewing affected workloads and any data you need to keep.",
  ),
  analytics: guide(
    "analytics",
    "Turn on request analytics and optional website pageviews for a service.",
  ),
  performance: guide(
    "operate/performance",
    "Review Scout measurements over a selected time range. Gaps mean no sample was recorded.",
  ),
  scout: guide(
    "scout",
    "Scout Agent collects server and workload measurements for performance charts, alerts, and deployment comparisons.",
  ),
  alerts: guide(
    "scout-alerts#create-a-rule",
    "Choose a metric, threshold, and severity. Towbar opens an incident when a fresh reading meets the rule.",
  ),
  incidents: guide(
    "operate/incidents",
    "Investigate a triggered alert, its measurements, resolution, and notification delivery history.",
  ),
  comparison: guide(
    "deployment-comparisons",
    "Compare resource use during equal observation windows after two deployments become ready.",
  ),
  vulnerabilities: guide(
    "vulnerability-scanning",
    "Inspect image findings by severity and package. Scan status is separate from deployment success and runtime health.",
  ),
  backups: guide(
    "backups",
    "Review backup schedules, storage destinations, and saved recovery points for PostgreSQL and Redis.",
  ),
  restores: guide(
    "restores",
    "Choose a compatible backup and review the restore plan before replacing database contents.",
  ),
  secrets: guide(
    "secrets",
    "Set declared build, runtime, and hook secrets. Values stay masked unless your role permits revealing them.",
  ),
  automation: guide(
    "repositories#control-automatic-deployment",
    "Pause or enable automatic work for this environment. Syncing configuration and deploying are separate actions.",
  ),
  manifest: guide(
    "deployment-manifest",
    "Git stores workload configuration. The dashboard shows the last successfully synced manifest for this environment.",
  ),
  github: guide(
    "integrations/github",
    "Configure the GitHub App in the Towbar environment, install it on the intended account, and grant repository access.",
  ),
  gitlab: guide(
    "integrations/gitlab",
    "Configure the GitLab OAuth application in the Towbar environment, then authorize the account Towbar should use.",
  ),
  registry: guide(
    "integrations/oci-registry",
    "Configure one OCI registry in the Towbar environment for private images and build transfers.",
  ),
  externalSecrets: guide(
    "secrets/external",
    "Reference secrets from a configured Infisical or Doppler provider without storing their values in manifests.",
  ),
  infisical: guide(
    "integrations/infisical",
    "Configure a scoped Infisical machine identity in Towbar's runtime YAML and verify a secret reference.",
  ),
  doppler: guide(
    "integrations/doppler",
    "Configure a Doppler service token in Towbar's runtime YAML and verify a secret reference.",
  ),
  cloudflare: guide(
    "integrations/cloudflare",
    "Configure Cloudflare in the Towbar environment for DNS operations, tunnel ingress, and Cloudflare TLS.",
  ),
  aws: guide(
    "integrations/aws",
    "Enable AWS credentials in the Towbar environment for database backups in S3.",
  ),
  gcp: guide(
    "integrations/gcp",
    "Enable a service account in the Towbar environment for Cloud Storage backups and restores.",
  ),
  s3Compatible: guide(
    "integrations/s3-compatible",
    "Configure S3-compatible storage in the Towbar environment for backups and restores.",
  ),
  r2: guide(
    "integrations/r2",
    "Configure Cloudflare R2 object storage and verify a datastore backup and restore.",
  ),
  notifications: guide(
    "integrations/notifications",
    "Review the providers and category routes enabled by the Towbar runtime environment.",
  ),
  slack: guide(
    "integrations/notifications/slack",
    "Configure a Slack bot token in the Towbar runtime and add category channel destinations in the dashboard.",
  ),
  email: guide(
    "integrations/notifications/email",
    "Configure SMTP delivery in the Towbar runtime and recipient destinations in the dashboard.",
  ),
  discord: guide(
    "integrations/notifications/discord",
    "Configure Discord webhook ID and token pairs in the Towbar runtime, then choose categories in the dashboard.",
  ),
  telegram: guide(
    "integrations/notifications/telegram",
    "Configure a Telegram bot in the Towbar runtime, then add chat and optional topic destinations in the dashboard.",
  ),
  webhook: guide(
    "integrations/notifications/webhook",
    "Send event JSON to the public HTTPS webhook route configured for each category.",
  ),
  system: guide(
    "operate/health",
    "Check Towbar's API, database, workflow engine, and worker. These checks are separate from workload health.",
  ),
  keys: guide(
    "ssh-keys",
    "Generate or store SSH private keys once, then select them in server credentials. Only admins can manage these keys.",
  ),
  team: guide(
    "team-settings",
    "Admins manage the team name, members, invitations, and team-owned API keys here.",
  ),
  members: guide(
    "team-settings#members",
    "Invite people by email and manage Admin, Member, or Viewer access.",
  ),
  profile: guide(
    "personal-settings#profile",
    "Update the display name shown for your account in the sidebar and member list.",
  ),
  preferences: guide(
    "personal-settings#preferences",
    "Choose how Towbar displays dates and times, and the time zone used for your account and personal API keys.",
  ),
  emailPassword: guide(
    "personal-settings#email-and-password",
    "Confirm a new sign-in email address or change your password. Save each form separately.",
  ),
  repositoryRemoval: guide(
    "repositories#delete-a-repository",
    "Remove this repository and its imported inventory from Towbar. Running services and Docker data require separate cleanup.",
  ),
  sessions: guide(
    "personal-settings#sessions",
    "Review active browser sessions and revoke sessions you no longer recognize or need.",
  ),
  security: guide(
    "personal-settings#passkeys",
    "Manage passkeys and one-use recovery codes for your account.",
  ),
  apiKeys: guide(
    "api/authentication#keys-and-permissions",
    "Create a personal or team key with limited access and an expiry. Copy the token once when it is created.",
  ),
  mcp: guide(
    "api/mcp",
    "Connect an MCP client by signing in to Towbar and approving its OAuth access. Tools follow the approved permissions and your current team role.",
  ),
} satisfies Record<string, HeadingDocumentation>;

type Topic = keyof typeof documentationTopics;

const integrationDocumentationTopics: Record<string, Topic> = {
  aws: "aws",
  cloudflare: "cloudflare",
  discord: "discord",
  doppler: "doppler",
  email: "email",
  gcp: "gcp",
  github: "github",
  gitlab: "gitlab",
  infisical: "infisical",
  r2: "r2",
  registry: "registry",
  s3: "s3Compatible",
  slack: "slack",
  telegram: "telegram",
  webhook: "webhook",
};

function integrationDocumentationTopic(path: string) {
  const provider = path.split("/").at(-1);
  return integrationDocumentationTopics[provider ?? ""] ?? "github";
}

export function documentationTopic(pathname: string): Topic | undefined {
  const path = pathname.replace(/\/$/, "") || "/";
  if (path === "/") return "overview";
  if (path === "/team-settings/audit-logs") return "auditLogs";
  if (
    path === "/manage/notifications/deliveries" ||
    path === "/manage/integrations/deliveries" ||
    path === "/team-settings/integrations/deliveries"
  )
    return "deliveries";
  if (/\/deployments\/[^/]+/.test(path)) {
    if (path.endsWith("/vulnerabilities")) return "vulnerabilities";
    if (path.endsWith("/logs")) return "logs";
    if (path.endsWith("/progress")) return "progress";
    return "deployments";
  }
  if (/\/syncs\/[^/]+/.test(path)) return "sync";
  if (path === "/team-settings/ssh-keys") return "keys";
  if (path === "/team-settings/shared-secrets") return "secrets";
  if (path.startsWith("/team-settings/integrations"))
    return integrationDocumentationTopic(path);
  if (path.startsWith("/team-settings"))
    return path.endsWith("/api-keys")
      ? "apiKeys"
      : path.endsWith("/members")
        ? "members"
        : "team";
  if (path.startsWith("/settings") || path.startsWith("/account/")) {
    if (path.endsWith("/preferences")) return "preferences";
    if (path.endsWith("/api-keys")) return "apiKeys";
    if (path.endsWith("/mcp")) return "mcp";
    if (path.endsWith("/email-password")) return "emailPassword";
    if (path.endsWith("/sessions")) return "sessions";
    if (/\/(passkeys|2fa|security)$/.test(path)) return "security";
    return "profile";
  }
  if (path === "/manage/ssh-keys" || path === "/manage/private-keys")
    return "keys";
  if (path === "/manage/shared-secrets") return "secrets";
  if (path.startsWith("/manage/notifications")) {
    const provider = path.split("/")[3];
    return ["slack", "email", "discord", "telegram", "webhook"].includes(
      provider ?? "",
    )
      ? (provider as Topic)
      : "notifications";
  }
  if (path.startsWith("/manage/integrations"))
    return integrationDocumentationTopic(path);
  if (path.startsWith("/repositories/") && /\/(danger|danger-zone)$/.test(path))
    return "repositoryRemoval";
  if (path === "/system-health") return "system";
  if (path === "/monitoring/logs") return "centralizedLogs";
  if (path === "/deployments") return "deployments";
  const parts = path.split("/").filter(Boolean);
  const section = parts.at(-1);
  const sections: Record<string, Topic> = {
    analytics: "analytics",
    performance: "performance",
    alerts: "alerts",
    incidents: "incidents",
    comparison: "comparison",
    "compare-deployments": "comparison",
    vulnerabilities: "vulnerabilities",
    previews: "previews",
    domains: "domains",
    deployments: "deployments",
    logs: "logs",
    secrets: "secrets",
    "shared-secrets": "secrets",
    "auto-deploy": "automation",
    manifest: "manifest",
    "sync-history": "sync",
    notifications: "notifications",
    credentials: "credentials",
    configuration: "credentials",
    "logs-collection": "logCollection",
    "scout-agent": "scout",
    "monitoring-agent": "scout",
    monitoring: "scout",
    checks: "capacity",
    cleanup: "cleanup",
    "danger-zone": "removal",
    danger: "removal",
    preparation: "preparation",
    backup: "backups",
    restore: "restores",
  };
  if (section && sections[section]) return sections[section];
  if (parts.includes("services")) return "apps";
  if (parts.includes("datastores")) return "resources";
  if (parts[0] === "servers") return "servers";
  if (parts[0] === "repositories") return "repositories";
  return undefined;
}

export const widgetDocumentation: Record<string, HeadingDocumentation> = {
  "database storage": guide(
    "monitoring#data-and-log-storage",
    "See what Towbar Data and Monitoring Data include, how often they are sampled, and what the chart excludes.",
  ),
  "data storage": guide(
    "monitoring#data-and-log-storage",
    "Understand PostgreSQL table sizes, sampling, and the 90-day storage history.",
  ),
  "log storage": guide(
    "monitoring#data-and-log-storage",
    "Track ClickHouse log storage and check the metadata permissions required for sampling.",
  ),
  "server setup": documentationTopics.preparation,
  "server inspection": guide(
    "servers#prepare-the-runtime",
    "Check SSH access and inspect the operating system and permissions before installing services.",
  ),
  prerequisites: guide(
    "servers#prepare-the-runtime",
    "Install or validate system packages, Docker, Caddy, deployment access, and the final server checks.",
  ),
  "host capacity": documentationTopics.capacity,
  "server credentials": documentationTopics.credentials,
  connection: guide(
    "servers#register-and-trust-the-host",
    "View this server's SSH address, port, user, and provider details.",
  ),
  operations: guide(
    "servers#read-capacity-and-health",
    "Review setup readiness, the latest server check, installed software, and build concurrency limits.",
  ),
  "connection and capacity": guide(
    "servers#set-concurrency",
    "Update the SSH connection and the maximum number of simultaneous builds on this server.",
  ),
  "server identity and capacity": documentationTopics.servers,
  "scout agent": documentationTopics.scout,
  "centralized logs": documentationTopics.centralizedLogs,
  "otel logs collector": documentationTopics.logCollection,
  "docker logs": documentationTopics.logCollection,
  "unused docker objects": documentationTopics.cleanup,
  performance: documentationTopics.performance,
  "cpu usage": guide(
    "monitoring#performance-history",
    "CPU consumption over the selected time range. Compare the measurement with the workload's allocation or host capacity.",
  ),
  "memory usage": guide(
    "monitoring#performance-history",
    "Recorded memory consumption over the selected time range. The chart's axis shows whether values are bytes or percentages.",
  ),
  "memory used": documentationTopics.performance,
  "docker disk usage": documentationTopics.performance,
  "swap used": documentationTopics.performance,
  "load average (5 minutes)": documentationTopics.performance,
  "load average (15 minutes)": documentationTopics.performance,
  "network received": documentationTopics.performance,
  "network sent": documentationTopics.performance,
  "disk read": documentationTopics.performance,
  "disk written": documentationTopics.performance,
  "block read": documentationTopics.performance,
  "block written": documentationTopics.performance,
  "container restarts": documentationTopics.incidents,
  "no scout report for": documentationTopics.alerts,
  "public http endpoint": guide(
    "scout-alerts#public-http-checks",
    "Check a public HTTP endpoint from the control plane. These checks do not need an installed Scout Agent.",
  ),
  "root disk usage": guide(
    "scout-alerts#measurements-and-incident-states",
    "The percentage of the server's root disk in use. Incident charts show the alert threshold alongside the readings.",
  ),
  "network traffic": guide(
    "monitoring#performance-history",
    "Network receive and transmit rates over the selected time range.",
  ),
  "disk i/o": guide(
    "monitoring#performance-history",
    "Disk read and write rates reported by Scout Agent.",
  ),
  "incident details": documentationTopics.incidents,
  "active incidents": documentationTopics.incidents,
  "deployments trend": guide(
    "#start-with-the-overview",
    "Daily deployment requests, successes, and failures, with the recent success rate and duration summary.",
  ),
  "deployment queue": guide(
    "deployments#browse-deployment-history",
    "Requests that are queued or running. Open a deployment to follow its progress.",
  ),
  notifications: guide(
    "integrations/notifications#delivery-history",
    "Review operational notifications. Opening an event takes you to the affected workload or incident.",
  ),
  "last deployment attempt": guide(
    "deployments#read-the-final-result",
    "The most recent deployment attempt can differ from the release that is currently serving traffic.",
  ),
  "auto-deploy": documentationTopics.automation,
  "environment automation": documentationTopics.automation,
  "preview configuration": documentationTopics.previews,
  "build configuration": guide(
    "services/manifest",
    "The Dockerfile, build context, source revision, and build settings read from the service manifest.",
  ),
  "image configuration": guide(
    "services/modes/image",
    "The container image and source configuration selected for this service.",
  ),
  "container configuration": guide(
    "services/manifest#field-map",
    "Ports, network, CPU, memory, and storage settings declared for the container.",
  ),
  "deployment configuration": guide(
    "deployments#deployment-hooks",
    "Health checks and deployment hooks control when a candidate is ready and which commands run around promotion.",
  ),
  "connection details": guide(
    "datastores#connect-privately",
    "Use the container network for private workload traffic or an SSH tunnel for local database access.",
  ),
  deployment: documentationTopics.deployments,
  target: guide(
    "deployments#read-the-final-result",
    "The workload, environment, commit, and image recorded for this deployment attempt.",
  ),
  "pull request": documentationTopics.previews,
  progress: documentationTopics.progress,
  sync: documentationTopics.sync,
  revision: guide(
    "repositories#change-configuration",
    "The commit and manifest identity read during this sync. They identify the exact configuration that was imported.",
  ),
  "imported inventory": documentationTopics.sync,
  "restore progress": documentationTopics.restores,
  "aws credentials": documentationTopics.aws,
  "google cloud credentials": documentationTopics.gcp,
  "restore source": documentationTopics.restores,
  "latest log capture": documentationTopics.logs,
  "github app": documentationTopics.github,
  "github app configuration": documentationTopics.github,
  "github connection": guide(
    "integrations/github#verify-access",
    "The GitHub account and installation that grant Towbar access to selected repositories.",
  ),
  "control plane": documentationTopics.system,
  integrations: guide(
    "monitoring#system-health",
    "Connection checks for the external providers configured in this Towbar installation.",
  ),
  "team details": guide(
    "team-settings#general",
    "Set the team name shown in the sidebar and an optional description for the workspace.",
  ),
  appearance: guide(
    "personal-settings#profile",
    "Change your display name and open Gravatar to edit the image associated with your email.",
  ),
  "email address": guide(
    "personal-settings#change-your-email",
    "Confirm a link sent to the new address before it replaces your sign-in email.",
  ),
  "change password": guide(
    "personal-settings#change-your-password",
    "Use your current password to set a new one with at least 15 characters.",
  ),

  passkeys: guide(
    "personal-settings#passkeys",
    "Sign in using a device or password manager, with its PIN, fingerprint, or face verification.",
  ),
  "connect your mcp client": documentationTopics.mcp,
};

export function headingDocumentation(
  pathname: string,
  title: string,
  kind: HeadingKind,
): HeadingDocumentation | undefined {
  const topic = documentationTopic(pathname);
  if (!topic) return undefined;
  if (kind === "page") return documentationTopics[topic];
  const name = title.trim().toLowerCase();
  if (
    name === "connection details" &&
    pathname.includes("/integrations/github")
  )
    return documentationTopics.github;
  if (topic === "comparison" && /cpu|memory|network|block|disk/i.test(name))
    return documentationTopics.comparison;
  if (name.includes("backup")) return documentationTopics.backups;
  if (["disk usage", "load average (1 minute)", "block i/o"].includes(name))
    return documentationTopics.performance;
  if (name.endsWith("secrets")) return documentationTopics.secrets;
  if (
    [
      "credentials",
      "channels",
      "configuration",
      "categories",
      "topics",
    ].includes(name) &&
    (pathname.startsWith("/manage/notifications") ||
      pathname.startsWith("/manage/integrations") ||
      pathname.startsWith("/team-settings/integrations"))
  )
    return documentationTopics[topic];
  if (name === "current state")
    return guide(
      topic === "resources" ? "datastores" : "services",
      "Lifecycle, runtime health, and configuration drift describe different parts of this workload's state. Check each before deploying.",
    );
  if (name === "danger zone")
    return pathname.startsWith("/repositories")
      ? guide(
          "repositories#delete-a-repository",
          "Delete this repository's inventory and history from Towbar. Running containers and data need a separate cleanup.",
        )
      : documentationTopics.removal;
  if (/^(aws s3|google cloud storage) configuration$/.test(name))
    return documentationTopics.backups;
  if (["critical", "high", "medium", "low", "unknown"].includes(name))
    return documentationTopics.vulnerabilities;
  if (["apps", "resources", "servers"].includes(name))
    return documentationTopics[name as "apps" | "resources" | "servers"];
  return widgetDocumentation[name];
}
