import { createServerCleanupFixture } from "./server-cleanup-fixture.ts";
import packageManifest from "../../../package.json" with { type: "json" };
import { repositoryUrl } from "@workspace/towbar-core/repository-identity";
import {
  createUpgradeFixture,
  type UpgradeScenario,
} from "./upgrade-fixture.ts";
import {
  type NormalizedApp,
  appDeploymentSchema,
  rolloutStrategySchema,
  managedResourceCompatibility,
} from "@workspace/towbar-core";
import { analyticsFixture } from "./analytics-fixture.ts";
import { eventHistoryFixture } from "./event-history-fixture.ts";
import { terminalFixture } from "./terminal-fixture.ts";
import {
  createTeamAccessFixture,
  type TeamFixtureOptions,
} from "./team-access-fixture.ts";
import { fixtureJson, useFixtureLocalization } from "./fixture-localization.ts";
import { roleActions, isWorkspaceRole } from "@workspace/towbar-access";
import { createDeclaredSecretsFixture } from "./declared-secrets-fixture.ts";
import {
  createSourceConnectionFixture,
  FixtureEnvironmentError,
} from "./source-connection-fixture.ts";
import {
  workloadFilters,
  serverFilters,
  sourceFilters,
  filterWorkloads,
  filterServers,
  filterSources,
} from "@workspace/towbar-core/inventory";
import { createLogsFixture } from "./logs-fixture.ts";
import { createScoutFixture } from "./scout-fixture.ts";
import {
  fixtureServerMonitoringSummary,
  fixtureMonitoringAgent,
  fixtureMonitoringHistory,
} from "./monitoring-fixture.ts";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

import type {
  App,
  BackupAssurance,
  AppSecretsResponse,
  AutoDeployControlResponse,
  Deployment,
  DeploymentEvent,
  DeploymentLog,
  DeploymentPullRequest,
  DeploymentState,
  DeploymentStep,
  GitHubConnection,
  GitHubRepository,
  NotificationDestination,
  NotificationEvent,
  OrphanItem,
  PreviewEnvironment,
  PreviewReportingHealth,
  Release,
  Resource,
  ResourceOperation,
  ResourceOperationEvent,
  RuntimeCapacity,
  Server,
  ServerCheck,
  ServerPreparation,
  Source,
  SourceBackup,
  SourceSync,
  SystemHealth,
  TowbarUser,
  TowbarUpdateInfo,
  TrustedHostKey,
  UserSession,
  VulnerabilityFinding,
  VulnerabilityFindingSummary,
  VulnerabilityScan,
} from "@workspace/towbar-web-client";

export const fixtureIds = {
  domainlessApp: "31111111-1111-4111-8111-aaaaaaaaaaaa",
  composeApp: "31111111-1111-4111-8111-999999999999",
  faviconApp: "31111111-1111-4111-8111-555555555555",
  stagingApp: "31111111-1111-4111-8111-666666666666",
  storageApp: "31111111-1111-4111-8111-888888888888",
  stagingResource: "41111111-1111-4111-8111-666666666666",
  app: "31111111-1111-4111-8111-222222222222",
  deployment: "61111111-1111-4111-8111-111111111111",
  preview: "b1111111-1111-4111-8111-111111111111",
  previewDeployment: "61111111-1111-4111-8111-444444444444",
  resource: "41111111-1111-4111-8111-111111111111",
  secondaryPostgres: "41111111-1111-4111-8111-333333333333",
  secondaryServer: "21111111-1111-4111-8111-222222222222",
  server: "21111111-1111-4111-8111-111111111111",
  source: "11111111-1111-4111-8111-111111111111",
  docsSource: "11111111-1111-4111-8111-222222222222",
  analyticsSource: "11111111-1111-4111-8111-333333333333",
  sandboxSource: "11111111-1111-4111-8111-444444444444",
  sync: "91111111-1111-4111-8111-111111111111",
  previousSync: "92222222-1111-4111-8111-222222222222",
  legacySync: "93333333-1111-4111-8111-333333333333",
} as const;

type FixtureApp = App & {
  serverId: string;
};

type FixtureResource = Resource & {
  serverId: string;
  serverSsh: { port: number; username: string };
};

const fixtureNow = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
const systemHealthFixtureNow = new Date().toISOString();
const commitSha = "c".repeat(40);
const manifestDigest = "d".repeat(64);
const simulatedDeployments = new WeakSet<Deployment>();
const terminalStates = new Set<DeploymentState>([
  "cancelled",
  "failed",
  "skipped",
  "succeeded",
  "succeeded_with_warnings",
]);

const user: TowbarUser = {
  email: "praveen@avgeek.ltd",
  id: "71111111-1111-4111-8111-111111111111",
  name: "Towbar Admin",
  workspaceId: "81111111-1111-4111-8111-111111111111",
  workspaceRole: "admin",
  teamName: "Towbar team",
  capabilities: roleActions("admin"),
  mustChangePassword: false,
  passwordSetupRequired: false,
  emailVerified: true,
  twoFactorEnabled: false,
};

const source: Source = {
  createdAt: fixtureNow,
  id: fixtureIds.source,
  provider: "github",
  repositoryName: "platform",
  repositoryOwner: "example-inc",
  repositoryUrl: "https://github.com/example-inc/platform",
  status: "active",
  updatedAt: fixtureNow,
};

const sources: Source[] = [
  source,
  {
    ...source,
    id: fixtureIds.docsSource,
    provider: "gitlab",
    repositoryName: "documentation",
    repositoryOwner: "example-inc/docs",
    repositoryUrl: "https://gitlab.example.com/example-inc/docs/documentation",
  },
  {
    ...source,
    id: fixtureIds.analyticsSource,
    repositoryName: "analytics",
    repositoryUrl: "https://github.com/example-inc/analytics",
  },
  {
    ...source,
    id: fixtureIds.sandboxSource,
    repositoryName: "sandbox",
    repositoryUrl: "https://github.com/example-inc/sandbox",
  },
];

const sourceAutoDeployControl = createAutoDeployControlFixture("source");
const deployableAutoDeployControls = new Map<
  string,
  AutoDeployControlResponse["autoDeploy"]
>();

const servers: Server[] = [
  createServerFixture(fixtureIds.server, "192.0.2.10", "ubuntu", false),
  createServerFixture(fixtureIds.secondaryServer, "192.0.2.11", "deploy", true),
];

const additionalServers = [
  {
    provider: "aws",
    type: "m7i.xlarge",
    name: "Production · Mumbai",
    cpu: 4,
    memory: 16,
    username: "ubuntu",
  },
  {
    provider: "gcp",
    type: "e2-standard-4",
    name: "Analytics · Singapore",
    cpu: 4,
    memory: 16,
    username: "deploy",
  },
  {
    provider: "azure",
    type: "Standard_D4s_v5",
    name: "Shared services · London",
    cpu: 4,
    memory: 16,
    username: "azureuser",
  },
  {
    provider: "digitalocean",
    type: "s-4vcpu-8gb",
    name: "Shared services · Amsterdam",
    cpu: 4,
    memory: 8,
    username: "root",
  },
  {
    provider: "linode",
    type: "g6-standard-4",
    name: "Shared services · Frankfurt",
    cpu: 4,
    memory: 8,
    username: "deploy",
  },
  {
    provider: "alibaba",
    type: "ecs.g7.xlarge",
    name: "APAC · Hong Kong",
    cpu: 4,
    memory: 16,
    username: "root",
  },
] as const;
servers[0]!.name = "Core services · Hyderabad";
servers[1]!.name = "Web services · Helsinki";
for (const [index, spec] of additionalServers.entries()) {
  const server = createServerFixture(
    `21111111-1111-4111-8111-${String(index + 3).repeat(12)}`,
    `192.0.2.${12 + index}`,
    spec.username,
    true,
  );
  server.name = spec.name;
  server.hardware = {
    instance: { provider: spec.provider, type: spec.type },
    cpuCount: spec.cpu,
    memoryBytes: spec.memory * 1024 ** 3,
  };
  server.config.buildConcurrency = index === 2 ? 4 : 2;
  server.config.ssh.port = index === 4 ? 2222 : 22;
  servers.push(server);
}

const apps: FixtureApp[] = [
  createAppFixture(
    "31111111-1111-4111-8111-111111111111",
    "Towbar API",
    "towbar-api",
    servers[0]!,
    "unhealthy",
  ),
  createAppFixture(
    fixtureIds.app,
    "Example Website",
    "example-website",
    servers[1]!,
  ),
  createAppFixture(
    "31111111-1111-4111-8111-333333333333",
    "Example Admin",
    "example-admin",
    servers[1]!,
  ),
];
apps[1]!.config.deploymentInputs = [
  ".dockerignore",
  ".npmrc",
  "Dockerfile",
  "content/**",
  "data/**",
  "next.config.ts",
  "package.json",
  "patches/**",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "postcss.config.mjs",
  "public/**",
  "src/**",
  "tsconfig.json",
];
apps[0]!.config.domains = {
  primary: "example.com",
  redirects: [],
};
apps[2]!.config.externalSecrets = {
  integration: "infisical",
  project: "00000000-0000-4000-8000-000000000001",
  environmentSlug: "prod",
  secretPath: "example-admin",
};
apps[1]!.config.notifications = {
  email: [
    {
      address: "website-ops@example.com",
      deployments: true,
      deploymentFailures: true,
      backupsAndRestores: false,
      alertsAndIncidents: true,
    },
  ],
  slack: [
    {
      channelId: "C12345678",
      deployments: true,
      deploymentFailures: false,
      backupsAndRestores: false,
      alertsAndIncidents: true,
    },
  ],
  discord: [
    {
      webhookId: "123456789012345678",
      deployments: false,
      deploymentFailures: true,
      backupsAndRestores: false,
      alertsAndIncidents: true,
    },
  ],
  telegram: [
    {
      chatId: "-1001234567890",
      messageThreadId: 42,
      deployments: true,
      deploymentFailures: false,
      backupsAndRestores: false,
      alertsAndIncidents: false,
    },
  ],
};
const resources: FixtureResource[] = [
  createResourceFixture(
    fixtureIds.resource,
    "Primary Postgres",
    "primary-postgres",
    "postgres",
    servers[0]!,
  ),
  createResourceFixture(
    "41111111-1111-4111-8111-222222222222",
    "Application Redis",
    "application-redis",
    "redis",
    servers[1]!,
  ),
  createResourceFixture(
    fixtureIds.secondaryPostgres,
    "Analytics Postgres",
    "analytics-postgres",
    "postgres",
    servers[1]!,
  ),
  createResourceFixture(
    "41111111-1111-4111-8111-777777777771",
    "Commerce MySQL",
    "commerce-mysql",
    "mysql",
    servers[1]!,
  ),
  createResourceFixture(
    "41111111-1111-4111-8111-777777777772",
    "Billing MariaDB",
    "billing-mariadb",
    "mariadb",
    servers[1]!,
  ),
  createResourceFixture(
    "41111111-1111-4111-8111-777777777773",
    "Events MongoDB",
    "events-mongodb",
    "mongodb",
    servers[1]!,
  ),
  createResourceFixture(
    "41111111-1111-4111-8111-777777777774",
    "Session Dragonfly",
    "session-dragonfly",
    "dragonfly",
    servers[1]!,
  ),
  createResourceFixture(
    "41111111-1111-4111-8111-777777777775",
    "Queue KeyDB",
    "queue-keydb",
    "keydb",
    servers[1]!,
  ),
  createResourceFixture(
    "41111111-1111-4111-8111-777777777776",
    "Analytics ClickHouse",
    "analytics-clickhouse",
    "clickhouse",
    servers[1]!,
  ),
];
resources[2]!.config.externalSecrets = {
  integration: "doppler",
  project: "example-analytics",
  config: "prd",
};
resources[0]!.config.notifications = {
  email: [
    {
      address: "database-ops@example.com",
      deployments: false,
      deploymentFailures: true,
      backupsAndRestores: true,
      alertsAndIncidents: true,
    },
  ],
};

apps.push({
  ...createAppFixture(
    "31111111-1111-4111-8111-444444444444",
    "Documentation",
    "documentation",
    servers[1]!,
  ),
  sourceId: fixtureIds.docsSource,
});
const faviconApp = createAppFixture(
  fixtureIds.faviconApp,
  "Wikipedia",
  "wikipedia",
  servers[1]!,
);
faviconApp.sourceId = fixtureIds.docsSource;
faviconApp.config.domains = {
  primary: "www.wikipedia.org",
  redirects: [],
};
apps.push(faviconApp);
const storageApp = createAppFixture(
  fixtureIds.storageApp,
  "File uploads",
  "file-uploads",
  servers[1]!,
);
storageApp.sourceId = fixtureIds.docsSource;
storageApp.config.container.volumes = [
  { name: "uploads", mountPath: "/app/uploads" },
];
storageApp.config.jobs = [
  {
    name: "daily-report",
    description: "Summarize uploaded files",
    command: ["node", "scripts/report.js"],
    schedule: { cron: "0 2 * * *", timezone: "UTC" },
    timeoutSeconds: 300,
    enabled: true,
  },
];
apps.push(storageApp);
const composeApp: FixtureApp = {
  ...createAppFixture(
    fixtureIds.composeApp,
    "Compose storefront",
    "compose-storefront",
    servers[1]!,
  ),
  config: {
    autoDeploy: true,
    container: { port: 0, volumes: [] },
    context: ".",
    deploymentInputs: ["deploy/compose.yml", "deploy/compose.production.yml"],
    description: "Multi-service storefront fixture",
    file: "deploy/compose.yml",
    health: { path: "/", timeoutSeconds: 300 },
    hooks: {},
    id: "compose-storefront",
    kind: "compose",
    name: "Compose storefront",
    overrides: ["deploy/compose.production.yml"],
    profiles: ["production"],
    server: servers[1]!.canonicalIp,
    services: {
      api: {
        domains: [
          "api.storefront.example.com",
          "events.storefront.example.com",
        ],
        port: 8080,
        tls: { mode: "cloudflare-dns" },
      },
      admin: {
        domains: ["admin.storefront.example.com"],
        port: 3001,
        ingress: {
          type: "cloudflare-tunnel",
          integration: "cloudflare",
          access: false,
        },
      },
      cache: {},
      web: {
        domains: ["storefront.example.com", "shop.example.com"],
        port: 3000,
      },
    },
    sourceBranch: "main",
    strategy: "maintenance",
    vulnerabilityScanning: false,
  },
  kind: "compose",
};
apps.push(composeApp);

resources.push({
  ...createResourceFixture(
    "41111111-1111-4111-8111-555555555555",
    "Reporting Postgres",
    "reporting-postgres",
    "postgres",
    servers[1]!,
  ),
  sourceId: fixtureIds.analyticsSource,
});

const serviceDomains = [
  "www.towbar.dev",
  "nextjs.org",
  "directus.io",
  "docs.docker.com",
  "www.wikipedia.org",
  "nextcloud.com",
  "shopware.com",
];
for (const [index, app] of apps.entries()) {
  app.config.domains = { primary: serviceDomains[index]!, redirects: [] };
  if (app.kind === "app")
    (app.config as NormalizedApp).tls = { mode: "direct" };
  app.description = app.config.description = [
    "Control plane API with rolling releases, health checks, and vulnerability scans.",
    "Customer website with pull-request previews and deployment notifications.",
    "Internal administration with secrets supplied by Infisical.",
    "Static documentation built from the documentation repository.",
    "Public knowledge base with a recognizable site favicon.",
    "Persistent file uploads with scheduled reports and a migration hook.",
    "Storefront and cache deployed together using Docker Compose.",
  ][index]!;
}
apps[1]!.config.domains = {
  primary: "website.example.com",
  redirects: [
    { host: "www.website.example.com", status: 301 },
    { host: "legacy.website.example.com", status: 302 },
  ],
};
const domainlessApp = createAppFixture(
  fixtureIds.domainlessApp,
  "Background worker",
  "background-worker",
  servers[1]!,
);
domainlessApp.config.container = {
  ...domainlessApp.config.container,
  port: 4318,
  entrypoint: "/bin/sh",
  command: ["-ec", "exec collector --config=/etc/collector/configuration.yaml"],
  configFiles: [
    {
      source: "observability/collector/configuration.yaml",
      mountPath: "/etc/collector/configuration.yaml",
    },
    {
      source: "observability/collector/health-check",
      mountPath: "/app/bin/health-check",
      mode: "0555",
    },
  ],
};
domainlessApp.config.health = { path: "/", port: 13133, timeoutSeconds: 60 };
domainlessApp.config.deployment = {
  type: "image",
  image: "signoz/signoz-otel-collector:v0.144.12",
  platform: "linux/arm64",
  pullPolicy: "if-not-present",
};
domainlessApp.config.rollout = {
  type: "recreate",
  maintenanceMode: true,
  reason: "Collector keeps a singleton network alias",
  terminationSeconds: 30,
};
domainlessApp.config.hooks = {
  preDeploy: {
    entrypoint: "/bin/sh",
    command: ["-ec", "initialize && migrate"],
    timeoutSeconds: 300,
  },
};
apps.push(domainlessApp);
(apps[0]!.config as NormalizedApp).analytics = {
  enabled: true,
  pageviews: true,
  visitorIdentity: true,
  retentionDays: 30,
  excludePaths: [],
};
(apps[1]!.config as NormalizedApp).analytics = {
  enabled: true,
  pageviews: false,
  visitorIdentity: false,
  retentionDays: 30,
  excludePaths: [],
};
(apps[0]!.config as NormalizedApp).buildServer = {
  ip: servers[4]!.canonicalIp,
  transfer: "direct",
  allowRuntimeFallback: false,
  architecture: "arm64",
};
(apps[0]!.config as NormalizedApp).rollout = rolloutStrategySchema.parse({
  type: "rolling",
  replicas: 3,
});
apps[1]!.config.hooks = {
  preDeploy: { command: ["node", "scripts/migrate.js"], timeoutSeconds: 120 },
  postDeploy: { command: ["node", "scripts/smoke.js"], timeoutSeconds: 60 },
};
const docsApp = apps.find(
  (app) => app.manifestId === "documentation",
)! as FixtureApp & { config: NormalizedApp };
docsApp.config.deployment = appDeploymentSchema.parse({
  type: "static",
  output: "dist",
  buildCommand: ["npm", "run", "build"],
  nodeImage:
    "node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81",
  spaFallback: true,
});
delete docsApp.config.dockerfile;

storageApp.config.rollout = rolloutStrategySchema.parse({
  type: "recreate",
  reason: "Single writer for persistent uploads",
  maintenanceMode: true,
});
storageApp.config.hooks = {
  preDeploy: { command: ["node", "scripts/migrate.js"], timeoutSeconds: 120 },
};
const imageServices = [
  {
    name: "Umami Analytics",
    slug: "umami",
    image: "ghcr.io/umami-software/umami:postgresql-v2.19.0",
    domain: "umami.is",
    port: 3000,
    data: "/app/data",
    sourceId: fixtureIds.analyticsSource,
  },
  {
    name: "Grafana Dashboards",
    slug: "grafana",
    image: "grafana/grafana:12.1.0",
    domain: "grafana.com",
    port: 3000,
    data: "/var/lib/grafana",
    sourceId: fixtureIds.analyticsSource,
  },
  {
    name: "Gitea",
    slug: "gitea",
    image: "gitea/gitea:1.24.6",
    domain: "about.gitea.com",
    port: 3000,
    data: "/data",
    sourceId: fixtureIds.source,
  },
  {
    name: "n8n Automations",
    slug: "n8n",
    image: "n8nio/n8n:1.109.2",
    domain: "n8n.io",
    port: 5678,
    data: "/home/node/.n8n",
    sourceId: fixtureIds.source,
  },
  {
    name: "Uptime Kuma",
    slug: "uptime-kuma",
    image: "louislam/uptime-kuma:1.23.16",
    domain: "uptime.kuma.pet",
    port: 3001,
    data: "/app/data",
    sourceId: fixtureIds.source,
  },
  {
    name: "Ghost Publishing",
    slug: "ghost",
    image: "ghost:6.0.6",
    domain: "ghost.org",
    port: 2368,
    data: "/var/lib/ghost/content",
    sourceId: fixtureIds.docsSource,
  },
  {
    name: "Metabase",
    slug: "metabase",
    image: "metabase/metabase:v0.56.3",
    domain: "www.metabase.com",
    port: 3000,
    data: "/metabase-data",
    sourceId: fixtureIds.analyticsSource,
  },
  {
    name: "SigNoz",
    slug: "signoz",
    image: "signoz/signoz:v0.144.0",
    domain: "signoz.example.com",
    port: 8080,
    data: "/var/lib/signoz",
    sourceId: fixtureIds.analyticsSource,
  },
  {
    name: "SigNoz Keeper",
    slug: "keeper",
    image: "clickhouse/clickhouse-keeper:25.12.5",
    domain: "",
    port: 9181,
    data: "/var/lib/clickhouse",
    sourceId: fixtureIds.analyticsSource,
  },
  {
    name: "OpenTelemetry Collector",
    slug: "otel-collector",
    image: "otel/opentelemetry-collector-contrib:0.148.0",
    domain: "",
    port: 4318,
    data: "/var/lib/otelcol",
    sourceId: fixtureIds.analyticsSource,
  },
];
for (const [index, spec] of imageServices.entries()) {
  const app = createAppFixture(
    `31111111-1111-4111-8111-${String(index + 20).padStart(12, "0")}`,
    spec.name,
    spec.slug,
    servers[(index % 6) + 2]!,
  );
  app.sourceId = spec.sourceId;
  app.description =
    app.config.description = `${spec.name} with persistent data, health checks, and image-based deployments.`;
  app.config.deployment = appDeploymentSchema.parse({
    type: "image",
    image: spec.image,
  });
  delete app.config.dockerfile;

  app.config.container.port = spec.port;
  app.config.container.volumes = [
    { name: `${spec.slug}-data`, mountPath: spec.data },
  ];
  if (spec.domain) app.config.domains = { primary: spec.domain, redirects: [] };
  app.config.health = { path: "/", timeoutSeconds: 60 };
  app.config.rollout = rolloutStrategySchema.parse({
    type: "recreate",
    reason: "Persistent application data",
    maintenanceMode: true,
  });
  apps.push(app);
}
for (const [index, resource] of resources.entries()) {
  if (index < 3) continue;
  const server = servers[2 + (index % 6)]!;
  resource.serverId = server.id;
  resource.serverIp = resource.config.server = server.canonicalIp;
  resource.serverSsh = {
    port: server.config.ssh.port,
    username: server.config.ssh.username,
  };
}

const buildServices = [
  {
    name: "Node.js API",
    domain: "nodejs.org",
    deployment: appDeploymentSchema.parse({
      type: "railpack",
      image:
        "ghcr.io/railwayapp/railpack-frontend@sha256:b9166320856c8bbb88789e89077d5a66a7d4cef8afa2e1e232307fb9a92c094e",
      version: "0.36.1",
    }),
  },
  {
    name: "Python API",
    domain: "www.python.org",
    deployment: appDeploymentSchema.parse({
      type: "nixpacks",
      image:
        "ghcr.io/railwayapp/nixpacks@sha256:9fc9a803373dfdde5b0bab48f26e4d9104f721865d108316eb655ee0214c3e91",
      version: "1.41.0",
    }),
  },
  {
    name: "Buildpack Worker",
    domain: "buildpacks.io",
    deployment: appDeploymentSchema.parse({
      type: "buildpack",
      packImage:
        "buildpacksio/pack@sha256:a53c4d6c297e10e680404cffda32e557b79a26d1ee4b7e6b18c0d175cb274621",
      builder:
        "heroku/builder@sha256:84d80b3c0d242961414a3c4d0a00c3518e6de01ef936423cfbaf1b0aa0f9155c",
    }),
  },
];
for (const [index, spec] of buildServices.entries()) {
  const app = createAppFixture(
    `31111111-1111-4111-8111-${String(index + 30).padStart(12, "0")}`,
    spec.name,
    `${spec.deployment.type}-service`,
    servers[index + 2]!,
  );
  app.config.deployment = spec.deployment;
  delete app.config.dockerfile;
  app.config.domains = { primary: spec.domain, redirects: [] };
  app.description =
    app.config.description = `${spec.name} built from source with ${spec.deployment.type}.`;
  apps.push(app);
}

const environmentMappings = sources
  .filter((item) => item.id !== fixtureIds.sandboxSource)
  .flatMap((item) =>
    (item.id === fixtureIds.source
      ? ["production", "staging"]
      : ["production"]
    ).map((name) => ({
      id: `${name === "staging" ? "a" : "c"}${item.id.slice(1)}`,
      sourceId: item.id,
      name,
      branch: name === "staging" ? "develop" : "main",
      mappingRevision: `${name === "staging" ? "a" : "c"}${item.id.slice(1)}`,
      previewsEnabled: name === "staging",
      latestSyncStatus: "succeeded" as const,
      latestSyncFinishedAt: fixtureNow,
      latestSuccessfulSyncId: fixtureIds.sync,
      disconnectedAt: null,
    })),
  );
for (const item of [...apps, ...resources]) {
  item.entityId = item.id;
  item.environment = environmentMappings.find(
    (environment) =>
      environment.sourceId === item.sourceId &&
      environment.name === "production",
  )!;
}
const stagingEnvironment = environmentMappings.find(
  (environment) =>
    environment.sourceId === fixtureIds.source &&
    environment.name === "staging",
)!;
apps.push({
  ...structuredClone(apps.find((item) => item.id === fixtureIds.app)!),
  id: fixtureIds.stagingApp,
  environment: stagingEnvironment,
});
resources.push({
  ...structuredClone(
    resources.find((item) => item.id === fixtureIds.resource)!,
  ),
  id: fixtureIds.stagingResource,
  environment: stagingEnvironment,
});

const fixtureSecretKeys = new Map<string, string[]>();
const fixtureSecretVersions = new Map<string, string>();
const fixtureSecretValues = new Map<string, Record<string, string>>();
for (const app of apps) {
  if (app.id === apps[2]!.id) continue;
  fixtureSecretKeys.set(`${app.id}:production:deployment`, [
    "DATABASE_URL",
    "SESSION_SECRET",
  ]);
  fixtureSecretVersions.set(
    `${app.id}:production:deployment`,
    crypto.randomUUID(),
  );
}
fixtureSecretKeys.set(`${source.id}:production:build`, [
  "PACKAGE_REGISTRY_TOKEN",
]);
fixtureSecretVersions.set(`${source.id}:production:build`, crypto.randomUUID());
fixtureSecretKeys.set(`${user.workspaceId}:production:build`, [
  "GLOBAL_PACKAGE_TOKEN",
]);
fixtureSecretVersions.set(
  `${user.workspaceId}:production:build`,
  crypto.randomUUID(),
);
fixtureSecretKeys.set(`${user.workspaceId}:preview:build`, [
  "GLOBAL_PREVIEW_TOKEN",
]);
fixtureSecretVersions.set(
  `${user.workspaceId}:preview:build`,
  crypto.randomUUID(),
);
fixtureSecretKeys.set(`${source.id}:preview:build`, ["SOURCE_PREVIEW_TOKEN"]);
fixtureSecretVersions.set(`${source.id}:preview:build`, crypto.randomUUID());

for (const deployable of [...apps, ...resources]) {
  const environment = deployable.environment?.name ?? "production";
  const keys: Record<string, string> =
    deployable.kind === "app" || deployable.kind === "compose"
      ? {
          DATABASE_URL:
            "postgresql://demo:demo-only-password@primary-postgres:5432/app",
          SESSION_SECRET: "demo-only-session-secret",
        }
      : Object.fromEntries(
          {
            postgres: ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"],
            mysql: ["MYSQL_ROOT_PASSWORD", "MYSQL_DATABASE"],
            mariadb: ["MARIADB_ROOT_PASSWORD", "MARIADB_DATABASE"],
            mongodb: [
              "MONGO_INITDB_ROOT_USERNAME",
              "MONGO_INITDB_ROOT_PASSWORD",
            ],
            redis: ["REDIS_PASSWORD"],
            dragonfly: ["REDIS_PASSWORD"],
            keydb: ["REDIS_PASSWORD"],
            clickhouse: [
              "CLICKHOUSE_USER",
              "CLICKHOUSE_PASSWORD",
              "CLICKHOUSE_DB",
            ],
          }[deployable.kind].map((key) => [
            key,
            key.endsWith("PASSWORD") ? "demo-only-database-password" : "demo",
          ]),
        );
  applyFixtureSecretMutation(`${deployable.id}:${environment}:deployment`, {
    set: keys,
  });
  if (
    deployable.kind === "app" &&
    deployable.config.deployment?.type !== "image"
  ) {
    applyFixtureSecretMutation(`${deployable.id}:${environment}:build`, {
      set: { PACKAGE_REGISTRY_TOKEN: "demo-only-registry-token" },
    });
    if (deployable.config.hooks.preDeploy)
      applyFixtureSecretMutation(`${deployable.id}:${environment}:pre_deploy`, {
        set: { MIGRATION_DATABASE_URL: keys.DATABASE_URL! },
      });
    if (deployable.config.hooks.postDeploy)
      applyFixtureSecretMutation(
        `${deployable.id}:${environment}:post_deploy`,
        { set: { SMOKE_TEST_TOKEN: "demo-only-smoke-token" } },
      );
  }
}

const platformApps = apps
  .filter(
    (app) =>
      app.sourceId === source.id && app.environment?.name === "production",
  )
  .slice(0, 4);

const deploymentFixtureNow = Date.now();
const deploymentDayOffsets = [6, 6, 5, 5, 5, 4, 3, 3, 2, 2, 2, 1, 0, 0];

const deployments: Deployment[] = [
  createDeploymentFixture(
    fixtureIds.deployment,
    apps[1]!,
    servers[1]!,
    "building",
  ),
  createDeploymentFixture(
    "61111111-1111-4111-8111-222222222222",
    resources[0]!,
    servers[0]!,
    "checking_health",
  ),
  createDeploymentFixture(
    "61111111-1111-4111-8111-333333333333",
    apps[2]!,
    servers[1]!,
    "queued",
  ),
  ...Array.from({ length: 14 }, (_, index) => {
    const deployable = platformApps[index % platformApps.length]!;
    const server = servers.find(
      (item) => item.canonicalIp === deployable.serverIp,
    )!;
    const createdAt = new Date(
      deploymentFixtureNow - deploymentDayOffsets[index]! * 86_400_000,
    ).toISOString();
    return createDeploymentFixture(
      `51111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      deployable,
      server,
      index % 5 === 0 ? "failed" : "succeeded",
      createdAt,
      (["manual", "auto_deploy", "rollback"] as const)[
        Math.floor(index / platformApps.length) % 3
      ]!,
    );
  }),
  ...Array.from({ length: 12 }, (_, index) => {
    const createdAt = new Date(
      deploymentFixtureNow - (index + 1) * 43_200_000,
    ).toISOString();
    return createDeploymentFixture(
      `52111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      resources[0]!,
      servers[0]!,
      index % 6 === 0 ? "failed" : "succeeded",
      createdAt,
      index % 3 === 0 ? "auto_deploy" : index % 5 === 0 ? "rollback" : "manual",
    );
  }),
];

deployments.push(
  createDeploymentFixture(
    "61111111-1111-4111-8111-666666666666",
    apps.find((item) => item.id === fixtureIds.stagingApp)!,
    servers[1]!,
    "queued",
  ),
  createDeploymentFixture(
    "62111111-1111-4111-8111-666666666666",
    resources.find((item) => item.id === fixtureIds.stagingResource)!,
    servers[0]!,
    "queued",
  ),
);

for (const deployable of [...apps, ...resources]) {
  if (!deployments.some((item) => item.appId === deployable.id))
    deployments.push(
      createDeploymentFixture(
        randomUUID(),
        deployable,
        servers.find((server) => server.id === deployable.serverId)!,
        "succeeded",
        new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      ),
    );
}

const previewDeployment: Deployment = {
  ...createDeploymentFixture(
    fixtureIds.previewDeployment,
    apps[1]!,
    servers[1]!,
    "succeeded",
    fixtureNow,
    "auto_deploy",
  ),
  environment: "preview",
  gitRef: "refs/pull/42/head",
  githubDeploymentId: "123456789",
  hostname:
    "example-website-feature-preview-fixture-a1b2c3d4.preview.example.com",
};
deployments.push(previewDeployment);

const vulnerabilityFindings: VulnerabilityFinding[] = [
  {
    advisoryId: "CVE-2026-12001",
    fixedVersion: "3.2.4-r1",
    id: "a1111111-1111-4111-8111-111111111111",
    installedVersion: "3.2.3-r0",
    packageName: "libxml2",
    severity: "high",
    target: "node:24-alpine (alpine 3.23.1)",
  },
  {
    advisoryId: "CVE-2026-12002",
    fixedVersion: "1.2.14-r0",
    id: "a1111111-1111-4111-8111-222222222222",
    installedVersion: "1.2.13-r0",
    packageName: "zlib",
    severity: "medium",
    target: "node:24-alpine (alpine 3.23.1)",
  },
];

const emptySeverityTotals = {
  critical: 0,
  high: 0,
  low: 0,
  medium: 0,
  unknown: 0,
};

const securityScanProfiles = [
  {
    findings: [
      {
        advisoryId: "CVE-2026-21001",
        fixedVersion: "3.5.1-r0",
        id: "a1111111-1111-4111-8111-555555555555",
        installedVersion: "3.5.0-r0",
        packageName: "openssl",
        severity: "critical",
        target: "node:24-alpine (alpine 3.23.1)",
      },
      {
        advisoryId: "CVE-2026-21002",
        fixedVersion: "1.4.3-r0",
        id: "a1111111-1111-4111-8111-666666666666",
        installedVersion: "1.4.2-r1",
        packageName: "busybox",
        severity: "critical",
        target: "node:24-alpine (alpine 3.23.1)",
      },
      ...vulnerabilityFindings,
      {
        advisoryId: "CVE-2026-21003",
        fixedVersion: null,
        id: "a1111111-1111-4111-8111-444444444444",
        installedVersion: "2.31.0",
        packageName: "esbuild",
        severity: "low",
        target: "node:24-alpine (alpine 3.23.1)",
      },
    ],
    severityTotals: {
      critical: 2,
      high: 1,
      low: 3,
      medium: 1,
      unknown: 0,
    },
    state: "findings",
    vulnerabilityDatabaseUpdatedAt: "2026-08-14T00:00:00.000Z",
  },
  {
    findings: vulnerabilityFindings,
    severityTotals: { critical: 0, high: 1, low: 2, medium: 1, unknown: 0 },
    state: "stale",
    vulnerabilityDatabaseUpdatedAt: "2026-07-01T00:00:00.000Z",
  },
  {
    findings: [] as VulnerabilityFinding[],
    severityTotals: emptySeverityTotals,
    state: "clean",
    vulnerabilityDatabaseUpdatedAt: "2026-08-14T00:00:00.000Z",
  },
] as const;

function latestScannedDeploymentForApp(
  app: FixtureApp,
): Deployment | undefined {
  return deployments
    .filter(
      (deployment) =>
        deployment.appId === app.id &&
        deployment.environment !== "preview" &&
        ["succeeded", "succeeded_with_warnings"].includes(deployment.state),
    )
    .at(-1);
}

type FixtureScanSummary = VulnerabilityScan & {
  appArchivedAt: string | null;
  appName: string;
  deploymentId: string;
  serverId: string;
  serverName: string;
  sourceId: string;
  sourceName: string | null;
};

const securityScanSummaries: FixtureScanSummary[] = apps.flatMap(
  (app, index) => {
    const deployment = latestScannedDeploymentForApp(app);
    if (!deployment?.vulnerabilityScan) return [];
    const profile = securityScanProfiles[index % securityScanProfiles.length]!;
    const sourceForApp = sources.find((item) => item.id === app.sourceId);
    const serverForApp = servers.find((item) => item.id === app.serverId);
    deployment.vulnerabilityScan = {
      ...deployment.vulnerabilityScan,
      errorCode: null,
      errorMessage: null,
      severityTotals: { ...profile.severityTotals },
      state: profile.state,
      vulnerabilityDatabaseUpdatedAt: profile.vulnerabilityDatabaseUpdatedAt,
    };
    return [
      {
        ...deployment.vulnerabilityScan,
        appArchivedAt: app.archivedAt,
        appName: app.name,
        deploymentId: deployment.id,
        serverId: app.serverId,
        serverName: serverForApp?.canonicalIp ?? app.serverIp,
        sourceId: app.sourceId,
        sourceName: sourceForApp
          ? `${sourceForApp.repositoryOwner}/${sourceForApp.repositoryName}`
          : null,
      },
    ];
  },
);

const vulnerabilityFindingsByDeployment = new Map<
  string,
  VulnerabilityFinding[]
>(
  securityScanSummaries.map((scan, index) => [
    scan.deploymentId,
    [...securityScanProfiles[index % securityScanProfiles.length]!.findings],
  ]),
);

const appIdByScanId = new Map<string, string>(
  securityScanSummaries.map((scan) => [
    scan.id,
    deployments.find((item) => item.id === scan.deploymentId)?.appId ?? "",
  ]),
);

const severityRank = ["critical", "high", "medium", "low", "unknown"] as const;

const securityFindingRows: VulnerabilityFindingSummary[] =
  securityScanSummaries.flatMap((scan, index) =>
    securityScanProfiles[index % securityScanProfiles.length]!.findings.map(
      (finding) => ({
        ...finding,
        appArchivedAt: scan.appArchivedAt,
        appId: appIdByScanId.get(scan.id)!,
        appName: scan.appName,
        deploymentId: scan.deploymentId,
        imageDigest: scan.imageDigest,
        scanState: scan.state,
        scannedAt: scan.completedAt,
        serverId: scan.serverId,
        serverName: scan.serverName,
        sourceId: scan.sourceId,
        sourceName: scan.sourceName,
      }),
    ),
  );

function getSecurityScansFixture(searchParams: URLSearchParams) {
  const severityParam = searchParams.get("severity") ?? "all";
  const severity: "all" | (typeof severityRank)[number] =
    severityParam === "all" ||
    (severityRank as readonly string[]).includes(severityParam)
      ? (severityParam as "all" | (typeof severityRank)[number])
      : "all";
  const appId = searchParams.get("appId");
  const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);
  const limit = Math.min(
    50,
    Math.max(1, Number(searchParams.get("limit") ?? 20) || 20),
  );
  const filtered = securityFindingRows
    .filter((finding) => !appId || finding.appId === appId)
    .filter((finding) => severity === "all" || finding.severity === severity)
    .sort((left, right) => {
      const severityDifference =
        severityRank.indexOf(left.severity) -
        severityRank.indexOf(right.severity);
      if (severityDifference !== 0) return severityDifference;
      const advisoryDifference = left.advisoryId.localeCompare(
        right.advisoryId,
      );
      if (advisoryDifference !== 0) return advisoryDifference;
      return left.appName.localeCompare(right.appName);
    });
  const start = (page - 1) * limit;
  const scoped = securityScanSummaries.filter(
    (scan) => !appId || appIdByScanId.get(scan.id) === appId,
  );
  const summary = {
    activeScans: scoped.filter((scan) =>
      ["pending", "running"].includes(scan.state),
    ).length,
    cleanScans: scoped.filter((scan) => scan.state === "clean").length,
    critical: sumSeverity(scoped, "critical"),
    failedScans: scoped.filter((scan) => scan.state === "failed").length,
    high: sumSeverity(scoped, "high"),
    low: sumSeverity(scoped, "low"),
    medium: sumSeverity(scoped, "medium"),
    scansWithFindings: scoped.filter((scan) => scan.state === "findings")
      .length,
    unknown: sumSeverity(scoped, "unknown"),
  };
  return {
    findings: filtered.slice(start, start + limit),
    nextPage: start + limit < filtered.length ? page + 1 : null,
    page,
    summary,
  };
}

function sumSeverity(
  scans: FixtureScanSummary[],
  severity: (typeof severityRank)[number],
) {
  return scans.reduce(
    (total, scan) => total + scan.severityTotals[severity],
    0,
  );
}

const previews: PreviewEnvironment[] = [
  {
    appId: apps[1]!.id,
    appName: apps[1]!.name,
    branch: "feature/preview-fixture",
    cleanupAttempts: 0,
    createdAt: fixtureNow,
    errorMessage: null,
    expiresAt: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
    gitRef: "refs/heads/feature/preview-fixture",
    hostname: previewDeployment.hostname!,
    id: fixtureIds.preview,
    latestCommitSha: commitSha,
    latestDeploymentId: previewDeployment.id,
    nextCleanupAttemptAt: null,
    pullRequestNumber: 42,
    pullRequestUrl: `${repositoryUrl}/pull/42`,
    sourceId: source.id,
    status: "healthy",
    updatedAt: fixtureNow,
  },
  {
    appId: apps[1]!.id,
    appName: apps[1]!.name,
    branch: "fix/preview-cleanup",
    cleanupAttempts: 2,
    createdAt: fixtureNow,
    errorMessage: "The server could not be reached over SSH",
    expiresAt: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
    gitRef: "refs/heads/fix/preview-cleanup",
    hostname: "example-website-pr-43.preview.example.com",
    id: "b1111111-1111-4111-8111-222222222222",
    latestCommitSha: "e".repeat(40),
    latestDeploymentId: null,
    nextCleanupAttemptAt: "2026-08-28T04:15:00.000Z",
    pullRequestNumber: 43,
    pullRequestUrl: `${repositoryUrl}/pull/43`,
    sourceId: source.id,
    status: "cleanup_failed",
    updatedAt: fixtureNow,
  },
];

const releases: Release[] = [...apps, ...resources].map(
  (deployable, index) => ({
    appId: deployable.id,
    commitSha,
    composeServices:
      deployable.config.kind === "compose"
        ? Object.keys(deployable.config.services)
        : [],
    containerName: `towbar-${deployable.manifestId}`,
    deploymentId:
      deployments.find((item) => item.appId === deployable.id)?.id ??
      deployments[0]!.id,
    id: `a1111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    imageTag: `towbar/${deployable.manifestId}:${commitSha.slice(0, 12)}`,
    imageDigest: `sha256:${"e".repeat(64)}`,
    imagePlatform: "linux/arm64",
    promotedAt: fixtureNow,
    status: "current",
    supersededAt: null,
  }),
);

const sourceSyncEnvironment = environmentMappings.find(
  (environment) =>
    environment.sourceId === source.id && environment.name === "production",
)!;
const sourceSync: SourceSync = {
  environment: {
    id: sourceSyncEnvironment.id,
    name: sourceSyncEnvironment.name,
    branch: sourceSyncEnvironment.branch,
  },
  mappingRevision: sourceSyncEnvironment.mappingRevision,
  commitSha,
  createdAt: fixtureNow,
  finishedAt: fixtureNow,
  id: fixtureIds.sync,
  issues: [],
  manifestDigest,
  reconciliation: { apps: 3, resources: 2 },
  startedAt: fixtureNow,
  status: "succeeded",
};
const stagingSyncEnvironment = environmentMappings.find(
  (environment) =>
    environment.sourceId === source.id && environment.name === "staging",
)!;
const sourceSyncs: SourceSync[] = [
  sourceSync,
  {
    ...sourceSync,
    id: fixtureIds.previousSync,
    environment: {
      id: stagingSyncEnvironment.id,
      name: stagingSyncEnvironment.name,
      branch: stagingSyncEnvironment.branch,
    },
    mappingRevision: stagingSyncEnvironment.mappingRevision,
    createdAt: new Date(Date.parse(fixtureNow) - 3_600_000).toISOString(),
    startedAt: new Date(Date.parse(fixtureNow) - 3_600_000).toISOString(),
    finishedAt: new Date(Date.parse(fixtureNow) - 3_590_000).toISOString(),
    status: "failed",
    issues: [
      {
        path: ["services", "website"],
        message: "The service image is required.",
      },
    ],
  },
  {
    ...sourceSync,
    id: fixtureIds.legacySync,
    environment: null,
    mappingRevision: null,
    createdAt: new Date(Date.parse(fixtureNow) - 7_200_000).toISOString(),
    startedAt: new Date(Date.parse(fixtureNow) - 7_200_000).toISOString(),
    finishedAt: new Date(Date.parse(fixtureNow) - 7_190_000).toISOString(),
  },
];

const githubConnection: GitHubConnection = {
  accountLogin: "example-inc",
  accountType: "Organization",
  id: "b1111111-1111-4111-8111-111111111111",
  installationId: "12345678",
  permissionReadiness: {
    contents: "read",
    deployments: "write",
    preview: "ready",
    pullRequests: "write",
    status: "available",
  },
  suspendedAt: null,
  updatedAt: fixtureNow,
};

const previewReporting: PreviewReportingHealth = {
  failedCount: 1,
  lastError: "GitHub temporarily rejected the Preview status update",
  lastFailedAt: fixtureNow,
};

const githubRepositories: GitHubRepository[] = [
  {
    defaultBranch: "main",
    fullName: "example-inc/platform",
    id: "10001",
    name: "platform",
    owner: "example-inc",
    private: true,
  },
  {
    defaultBranch: "main",
    fullName: "example-inc/example-service",
    id: "10002",
    name: "example-service",
    owner: "example-inc",
    private: true,
  },
  ...[
    "analytics",
    "documentation",
    "identity-service",
    "internal-api",
    "internal-web",
    "monitoring",
    "notification-worker",
    "reference-data",
    "shared-config",
    "shared-design-system",
    "shared-observability",
    "website",
  ].map((name, index) => ({
    defaultBranch: "main",
    fullName: `example-inc/${name}`,
    id: String(10003 + index),
    name,
    owner: "example-inc",
    private: true,
  })),
];

const discoveredHostKey = {
  algorithm: "ssh-ed25519",
  fingerprint: "SHA256:TowbarFixtureHostKey",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITowbarFixtureHostKey",
};

const hostKeysByServer = new Map<string, TrustedHostKey[]>([
  [fixtureIds.server, []],
  [
    fixtureIds.secondaryServer,
    [
      {
        algorithm: "ssh-ed25519",
        createdAt: fixtureNow,
        fingerprint: "SHA256:TowbarFixtureTrustedHostKey",
        id: "c1111111-1111-4111-8111-222222222222",
      },
    ],
  ],
]);

for (const server of servers.slice(2))
  hostKeysByServer.set(server.id, [
    {
      algorithm: "ssh-ed25519",
      createdAt: fixtureNow,
      fingerprint: "SHA256:DemoOnlyHostKey",
      id: randomUUID(),
    },
  ]);

const userSessions: UserSession[] = [
  {
    createdAt: fixtureNow,
    expiresAt: "2026-09-21T09:00:00.000Z",
    id: "d1111111-1111-4111-8111-111111111111",
    lastSeenAt: fixtureNow,
    revokedAt: null,
  },
  {
    createdAt: "2026-08-20T09:00:00.000Z",
    expiresAt: "2026-09-19T09:00:00.000Z",
    id: "d1111111-1111-4111-8111-222222222222",
    lastSeenAt: "2026-08-22T08:30:00.000Z",
    revokedAt: null,
  },
];

const serverChecks: ServerCheck[] = [
  {
    createdAt: fixtureNow,
    errorCode: "HOST_KEY_NOT_TRUSTED",
    errorMessage: "The server SSH host key has not been explicitly trusted",
    finishedAt: fixtureNow,
    id: "f1111111-1111-4111-8111-000000000000",
    result: { discoveredHostKeys: [discoveredHostKey] },
    startedAt: fixtureNow,
    status: "failed",
  },
  {
    createdAt: fixtureNow,
    errorCode: null,
    errorMessage: null,
    finishedAt: fixtureNow,
    id: "f1111111-1111-4111-8111-111111111111",
    result: {
      architecture: "x86_64",
      dockerVersion: "28.3.3",
      operatingSystem: "Ubuntu 24.04 LTS",
    },
    startedAt: fixtureNow,
    status: "succeeded",
  },
];

type FixtureCredentialVerification = ServerCheck;
const requestedServerChecks = new Map<string, ServerCheck[]>();

const credentialVerifications = new Map<
  string,
  FixtureCredentialVerification
>();

let systemHealth: SystemHealth = {
  checkedAt: systemHealthFixtureNow,
  checks: [
    {
      checkedAt: systemHealthFixtureNow,
      description:
        "The API is responding and the current database schema is queryable.",
      id: "api-database",
      remediationHref: null,
      remediationLabel: null,
      status: "healthy",
      title: "API and database",
    },
    {
      checkedAt: systemHealthFixtureNow,
      description:
        "Temporal accepted a signal for the durable maintenance workflow.",
      id: "temporal",
      remediationHref: null,
      remediationLabel: null,
      status: "healthy",
      title: "Temporal",
    },
    {
      checkedAt: systemHealthFixtureNow,
      description:
        "The worker completed a scheduled maintenance sweep through Temporal.",
      id: "worker",
      remediationHref: null,
      remediationLabel: null,
      status: "healthy",
      title: "Worker and maintenance",
    },
  ],
  databaseStorage: Array.from({ length: 90 }, (_, index) => ({
    sampledAt: new Date(
      Date.parse(systemHealthFixtureNow) - (89 - index) * 86_400_000,
    ).toISOString(),
    towbarBytes: Math.round(
      96_000_000 + index * 520_000 + Math.sin(index / 7) * 3_000_000,
    ),
    monitoringBytes: Math.round(
      12_000_000 + index * 340_000 + Math.sin(index / 5) * 2_000_000,
    ),
    analyticsBytes: Math.round(
      6_000_000 + index * 260_000 + Math.sin(index / 6) * 1_000_000,
    ),
    logsBytes: Math.round(
      320_000_000 + index * 11_000_000 + Math.sin(index / 4) * 90_000_000,
    ),
    logsError: null,
  })),
  status: "healthy",
  version: packageManifest.version,
};

function fixtureSystemHealth(): SystemHealth {
  return {
    ...systemHealth,
    checks: [...systemHealth.checks],
  };
}

const towbarUpdates: TowbarUpdateInfo = {
  checkedAt: systemHealthFixtureNow,
  installedVersion: packageManifest.version,
  latestVersion: packageManifest.version,
  releaseUrl: `${repositoryUrl}/releases/tag/v${packageManifest.version}`,
  status: "current",
};

const runtimeCapacity: RuntimeCapacity[] = [
  {
    checkedAt: systemHealthFixtureNow,
    cpu: { loadAverage1m: 1.7, logicalCount: 4, usagePercent: 38.4 },
    disk: {
      availableBytes: 12_884_901_888,
      totalBytes: 107_374_182_400,
      usedPercent: 88,
    },
    id: fixtureIds.server,
    ip: servers[0]!.canonicalIp,
    latestCheckStatus: "succeeded",
    memory: {
      availableBytes: 5_583_457_280,
      totalBytes: 17_179_869_184,
      usedPercent: 67.5,
    },
    runtimes: [
      {
        cpuPercent: 4.7,
        healthStatus: "healthy",
        id: apps[0]!.id,
        kind: "app",
        memoryLimitBytes: 4_294_967_296,
        memoryUsageBytes: 734_003_200,
        name: apps[0]!.name,
        observedState: "running",
        restartCount: 2,
        sourceId: source.id,
        startedAt: "2026-08-21T09:00:00.000Z",
      },
      {
        cpuPercent: 1.2,
        healthStatus: "healthy",
        id: resources[0]!.id,
        kind: "postgres",
        memoryLimitBytes: 4_294_967_296,
        memoryUsageBytes: 1_342_177_280,
        name: resources[0]!.name,
        observedState: "running",
        restartCount: 0,
        sourceId: source.id,
        startedAt: "2026-08-20T09:00:00.000Z",
      },
    ],
    status: "attention",
    uptimeSeconds: 1_236_420,
  },
  {
    checkedAt: systemHealthFixtureNow,
    cpu: { loadAverage1m: 0.8, logicalCount: 8, usagePercent: 22.6 },
    disk: {
      availableBytes: 73_014_444_032,
      totalBytes: 107_374_182_400,
      usedPercent: 32,
    },
    id: fixtureIds.secondaryServer,
    ip: servers[1]!.canonicalIp,
    latestCheckStatus: "succeeded",
    memory: {
      availableBytes: 22_548_578_304,
      totalBytes: 34_359_738_368,
      usedPercent: 34.4,
    },
    runtimes: [
      ...apps.slice(1).map((app, index) => ({
        cpuPercent: 1.4 + index,
        healthStatus: "healthy" as const,
        id: app.id,
        kind: "app" as const,
        memoryLimitBytes: 4_294_967_296,
        memoryUsageBytes: 314_572_800 + index * 52_428_800,
        name: app.name,
        observedState: "running" as const,
        restartCount: 0,
        sourceId: app.sourceId,
        startedAt: "2026-08-22T07:00:00.000Z",
      })),
      ...resources.slice(1).map((resource, index) => ({
        cpuPercent: 0.8 + index,
        healthStatus: "healthy" as const,
        id: resource.id,
        kind: resource.kind,
        memoryLimitBytes: 4_294_967_296,
        memoryUsageBytes: 262_144_000 + index * 78_643_200,
        name: resource.name,
        observedState: "running" as const,
        restartCount: 0,
        sourceId: resource.sourceId,
        startedAt: "2026-08-22T07:00:00.000Z",
      })),
    ],
    status: "healthy",
    uptimeSeconds: 923_580,
  },
];

for (const server of servers.slice(2)) {
  const memory = server.hardware!.memoryBytes!;
  runtimeCapacity.push({
    ...emptyRuntimeCapacity(server),
    checkedAt: fixtureNow,
    latestCheckStatus: "succeeded",
    status: "healthy",
    cpu: {
      loadAverage1m: 0.7,
      logicalCount: server.hardware!.cpuCount!,
      usagePercent: 24,
    },
    memory: {
      availableBytes: Math.round(memory * 0.65),
      totalBytes: memory,
      usedPercent: 35,
    },
    disk: {
      availableBytes: 80 * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
      usedPercent: 20,
    },
    uptimeSeconds: 864_000,
  });
}
for (const capacity of runtimeCapacity) {
  capacity.runtimes = [...apps, ...resources]
    .filter((item) => item.serverId === capacity.id)
    .map((item, index) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      sourceId: item.sourceId,
      healthStatus: item.runtimeState.healthStatus,
      observedState: item.runtimeState.observedState,
      cpuPercent: 1.5 + index,
      memoryLimitBytes: 1024 ** 3,
      memoryUsageBytes: 256 * 1024 ** 2,
      restartCount: 0,
      startedAt: fixtureNow,
    }));
}

const preparationStepResults: Record<
  ServerPreparation["steps"][number]["id"],
  { message: string; log: string }
> = {
  connecting: {
    message:
      "SSH connection successfully tested as root using private key “Production servers”. The server identity matched a trusted host key.",
    log: "[stdout] Testing SSH access using stored private key “Production servers”.\n[stdout] Pinned host key matched. SSH authentication succeeded. Remote command: true (exit 0).\n",
  },
  inspecting: {
    message:
      "Ubuntu 24.04 LTS is supported. Checked the Ubuntu release and confirmed root access for the SSH user.",
    log: "[stderr] Operating system: Ubuntu 24.04 LTS\n[stderr] Administrative access: root\n[stdout] Ubuntu 24.04 LTS\n",
  },
  installing_prerequisites: {
    message:
      "Python 3.12.3 is available. Updated the APT package index and installed HTTPS transport, CA certificates, curl, GnuPG, archive keyrings, coreutils, and sudo.",
    log: "[stderr] Reading package lists...\n[stderr] ca-certificates is already the newest version.\n[stderr] Setting up python3 (3.12.3)...\n[stdout] Python 3.12.3\n",
  },
  installing_docker: {
    message:
      "Docker Engine 28.3.3 is running and enabled at boot. Checked compatibility and installed Docker Engine, containerd, Buildx, and Compose when needed.",
    log: "[stderr] Setting up docker-ce (28.3.3)...\n[stderr] Setting up docker-buildx-plugin...\n[stderr] Setting up docker-compose-plugin...\n[stdout] 28.3.3\n",
  },
  installing_caddy: {
    message:
      "Caddy v2.11.4 is running and enabled at boot. Created /etc/caddy and /etc/caddy/towbar. Verified the Cloudflare DNS module.",
    log: "[stderr] Setting up caddy...\n[stderr] Cloudflare DNS module verified\n[stdout] v2.11.4\n",
  },
  installing_log_collector: {
    message:
      process.env.TOWBAR_FIXTURE_LOGS_STATE === "not_configured"
        ? "Skipped: connect ClickHouse in config.yml to enable log collection. You can install the collector later in Settings → OTEL Logs Collector."
        : "OTEL Logs Collector is installed and enabled. Waiting for the first log from an eligible container.",
    log:
      process.env.TOWBAR_FIXTURE_LOGS_STATE === "not_configured"
        ? "[stdout] Skipped log collector installation: ClickHouse is not configured.\n"
        : "[stdout] Installed the pinned collector and enabled the log discovery service.\n",
  },
  configuring_access: {
    message:
      "Created /etc/caddy/towbar and /var/lib/towbar with mode 0755. The root SSH user already has Docker access.",
    log: "[stdout] Towbar directories and Docker access configured\n",
  },
  verifying: {
    message:
      "Verified Ubuntu 24.04 LTS, Docker 28.3.3, Caddy v2.11.4, and Python 3.12.3. Docker and Caddy are active, Docker responds, the Caddy configuration is valid, and deployment directories and Docker access are available. Free Docker disk space: 25.0 GiB (minimum 1 GiB).",
    log: "[stderr] Docker and Caddy services: active\n[stderr] Valid configuration\n[stdout] Ubuntu 24.04 LTS\n[stdout] 28.3.3\n[stdout] v2.11.4\n[stdout] Python 3.12.3\n[stdout] 26214400\n",
  },
};

const serverPreparationsByServer = new Map<string, ServerPreparation[]>([
  [fixtureIds.server, []],
  [fixtureIds.secondaryServer, [createPreparationFixture("succeeded")]],
]);
const serverPreparationPolls = new Map<string, number>();

type FixtureRuntimeOperation = Omit<
  ResourceOperation,
  "request" | "result" | "type"
> & {
  request: ResourceOperation["request"] | Record<string, unknown>;
  result: ResourceOperation["result"] | Record<string, unknown> | null;
  type: ResourceOperation["type"];
};

const runtimeOperations: FixtureRuntimeOperation[] = [
  {
    cancelRequestedAt: null,
    createdAt: fixtureNow,
    deletedAt: null,
    errorCode: "RESOURCE_OPERATION_FAILED",
    errorMessage: "UnknownError",
    finishedAt: fixtureNow,
    id: "e1111111-1111-4111-8111-222222222222",
    phase: null,
    request: { type: "backup" },
    requestedBy: null,
    resourceId: fixtureIds.secondaryPostgres,
    result: null,
    serverId: fixtureIds.secondaryServer,
    sourceId: fixtureIds.source,
    startedAt: fixtureNow,
    state: "failed",
    type: "backup",
    updatedAt: fixtureNow,
  },
  {
    cancelRequestedAt: null,
    createdAt: fixtureNow,
    deletedAt: null,
    errorCode: null,
    errorMessage: null,
    finishedAt: fixtureNow,
    id: "e1111111-1111-4111-8111-111111111111",
    phase: null,
    request: { tail: 500, type: "capture_logs" },
    requestedBy: user.id,
    resourceId: fixtureIds.app,
    result: {
      logs: "Listening on port 3000\nHealth check passed\n",
      truncated: false,
    },
    serverId: fixtureIds.server,
    sourceId: fixtureIds.source,
    startedAt: fixtureNow,
    state: "succeeded",
    type: "capture_logs",
    updatedAt: fixtureNow,
  },
];
const sourceBackups: SourceBackup[] = [
  createBackupFixture(
    "f1111111-1111-4111-8111-111111111111",
    resources[0]!,
    new Date(Date.now() - 1 * 60 * 60_000).toISOString(),
    248_512_336,
  ),
  createBackupFixture(
    "f1111111-1111-4111-8111-222222222222",
    resources[2]!,
    new Date(Date.now() - 14 * 60 * 60_000).toISOString(),
    231_902_104,
  ),
  createBackupFixture(
    "f1111111-1111-4111-8111-333333333333",
    resources[1]!,
    new Date(Date.now() - 18 * 60 * 60_000).toISOString(),
    48_331_776,
  ),
];
for (const resource of resources.slice(3))
  sourceBackups.push(
    createBackupFixture(randomUUID(), resource, fixtureNow, 96_512_336),
  );
const backupAssurances: BackupAssurance[] = sourceBackups.map((backup) => {
  const s3AccessDenied = backup.resourceId === fixtureIds.secondaryPostgres;
  return {
    backupOperationId: backup.id,
    checkedAt: fixtureNow,
    checks: [
      "freshness",
      "object_exists",
      "size",
      "checksum",
      "encryption",
      "engine",
      "format",
    ].map((name) => ({
      message:
        s3AccessDenied && name === "object_exists"
          ? "Workspace AWS credentials cannot access the S3 object"
          : `${name.replaceAll("_", " ")} verified`,
      name,
      passed: !(s3AccessDenied && name === "object_exists"),
    })),
    resourceId: backup.resourceId!,
    restoreReady: !s3AccessDenied,
    status: s3AccessDenied ? "not_restore_ready" : "restore_ready",
    updatedAt: fixtureNow,
  };
});
const operationEventsByOperation = new Map<string, ResourceOperationEvent[]>([
  [
    "e2111111-1111-4111-8111-111111111111",
    [
      {
        command:
          "tar --create --file - /var/lib/docker/volumes/towbar-file-uploads-uploads/_data",
        createdAt: fixtureNow,
        id: "e3111111-1111-4111-8111-111111111111",
        level: "success",
        message: "Captured and encrypted 1 declared volume",
        metadata: { bytes: 18_874_368, objects: 1 },
        phase: "capturing",
        sequence: 1,
      },
      {
        command: null,
        createdAt: fixtureNow,
        id: "e3111111-1111-4111-8111-222222222222",
        level: "success",
        message: "Uploaded the volume archive and verified its checksum",
        metadata: { integration: "s3-production" },
        phase: "complete",
        sequence: 2,
      },
    ],
  ],
]);
const notificationDestinations: NotificationDestination[] = [
  {
    categories: ["deployments", "previews", "health"],
    config: { channelId: "C0123456789" },
    createdAt: fixtureNow,
    enabled: true,
    id: "a1111111-1111-4111-8111-111111111111",
    provider: "slack",
    sourceId: source.id,
    updatedAt: fixtureNow,
  },
  {
    categories: ["backups", "restores"],
    config: {
      recipients: ["operations@example.com"],
    },
    createdAt: fixtureNow,
    enabled: false,
    id: "a1111111-1111-4111-8111-222222222222",
    provider: "smtp",
    sourceId: source.id,
    updatedAt: fixtureNow,
  },
  {
    categories: ["scout"],
    config: { channelId: "CTOWBARALERTS" },
    createdAt: fixtureNow,
    enabled: true,
    id: "a1111111-1111-4111-8111-333333333333",
    provider: "slack",
    serverId: null,
    sourceId: null,
    updatedAt: fixtureNow,
  },
  {
    categories: ["deployments"],
    config: { channelId: "CTOWBARDEPLOYS" },
    createdAt: fixtureNow,
    enabled: true,
    id: "a1111111-1111-4111-8111-444444444444",
    provider: "slack",
    serverId: null,
    sourceId: null,
    updatedAt: fixtureNow,
  },
  {
    categories: ["scout", "deployments", "health", "backups", "restores"],
    config: { recipients: ["operations@example.com"] },
    createdAt: fixtureNow,
    enabled: true,
    id: "a1111111-1111-4111-8111-555555555555",
    provider: "smtp",
    serverId: null,
    sourceId: null,
    updatedAt: fixtureNow,
  },
];
const notificationEvents: NotificationEvent[] = [
  createNotificationEventFixture(
    "b1111111-1111-4111-8111-111111111111",
    "deployment.failed",
  ),
  createNotificationEventFixture(
    "b1111111-1111-4111-8111-222222222222",
    "preview.ready",
  ),
];
const orphanItems: OrphanItem[] = [
  {
    kind: "container",
    name: "towbar-retired-fixture",
    reason: "Retired workload",
  },
  {
    kind: "volume",
    name: "towbar-retired-fixture-data",
    reason: "Retired workload storage",
  },
];
const serverCleanups = new Map(
  servers.map((server) => [server.id, createServerCleanupFixture(server.id)]),
);
const cleanupIdempotency = new Map<string, ResourceOperation>();

const workflowStates: DeploymentState[] = [
  "queued",
  "waiting_for_server",
  "preparing",
  "validating_credentials",
  "checking_server",
  "fetching_source",
  "resolving_secrets",
  "transferring",
  "building",
  "running_pre_deploy",
  "starting_candidate",
  "checking_health",
  "configuring_routing",
  "provisioning_tls",
  "checking_public_endpoint",
  "switching_traffic",
  "running_post_deploy",
  "cleaning_up",
];

export function createFixtureApiServer({
  upgradeScenario,
  publicDemo = false,
  githubAppConnected = false,
  githubConnections,
  githubRepositoryOptions,
  notificationProvidersConfigured = false,
  smtpConfigured = notificationProvidersConfigured,
  slackConfigured = notificationProvidersConfigured,
  discordConfigured = notificationProvidersConfigured,
  telegramConfigured = notificationProvidersConfigured,
  webhookConfigured = notificationProvidersConfigured,
  role,
  authState,
  smtpAvailable,
  emailVerified,
}: TeamFixtureOptions & {
  upgradeScenario?: UpgradeScenario;
  publicDemo?: boolean;
  githubAppConnected?: boolean;
  githubConnections?: GitHubConnection[];
  githubRepositoryOptions?: GitHubRepository[];
  notificationProvidersConfigured?: boolean;
  smtpConfigured?: boolean;
  slackConfigured?: boolean;
  discordConfigured?: boolean;
  telegramConfigured?: boolean;
  webhookConfigured?: boolean;
} = {}) {
  if (publicDemo) {
    user.email = "visitor@example.com";
    user.name = "Demo visitor";
    user.teamName = "Example team";
    for (const server of servers) {
      server.setupStatus = "ready";
      server.preparedAt = fixtureNow;
    }
    for (const deployable of [...apps, ...resources])
      deployable.serverReady = true;
  }
  const teamAccess = createTeamAccessFixture(user, {
    role,
    authState,
    smtpAvailable,
    emailVerified,
  });
  let activeGitHubConnections: GitHubConnection[] =
    githubConnections ??
    (githubAppConnected
      ? [
          {
            ...githubConnection,
            permissionReadiness: { ...githubConnection.permissionReadiness },
          },
        ]
      : []);
  const availableGitHubRepositories = (
    githubRepositoryOptions ?? githubRepositories
  ).map((repository) => ({
    ...repository,
    connectionId: repository.connectionId ?? githubConnection.id,
  }));
  const fixtureGitHubConfiguration = {
    appId: "123456",
    appSlug: "towbar-fixture",
    source: "environment" as const,
  };
  const githubAppConfiguration = fixtureGitHubConfiguration;
  const githubInstallationState = "fixture-github-installation-state";
  const notificationProviderState = {
    discord: discordConfigured,
    slack: slackConfigured,
    smtp: smtpConfigured,
    telegram: telegramConfigured,
    webhook: webhookConfigured,
  };
  const connections = createSourceConnectionFixture({
    existing: sources,
    installationId: githubConnection.id,
    resolveRepository: (installationId, owner, name) =>
      activeGitHubConnections.some(
        (account) => account.id === installationId && !account.suspendedAt,
      )
        ? availableGitHubRepositories.find(
            (repository) =>
              repository.connectionId === installationId &&
              repository.owner === owner &&
              repository.name === name,
          )
        : undefined,
    app: apps[0]!,
    resource: resources[0]!,
  });
  const sourceRepositoryIds = new Map(
    sources.map((source) => [
      source.id,
      githubRepositories.find(
        (repository) =>
          repository.owner === source.repositoryOwner &&
          repository.name === source.repositoryName,
      )?.id,
    ]),
  );
  const declaredSecrets = createDeclaredSecretsFixture(connections);
  const scoutFixture = createScoutFixture(
    servers.map((s) => s.id),
    [...apps, ...resources],
    securityScanSummaries.reduce(
      (total, scan) =>
        total + scan.severityTotals.critical + scan.severityTotals.high,
      0,
    ),
  );
  const logsFixture = createLogsFixture(
    [...apps, ...resources],
    teamAccess.getUser,
    (serverId) =>
      serverPreparationsByServer
        .get(serverId)?.[0]
        ?.steps.some(
          (step) =>
            step.id === "installing_log_collector" &&
            step.status === "succeeded",
        ) ?? false,
  );
  const monitoring = new Map(
    servers.map((server, index) => [
      server.id,
      fixtureMonitoringAgent(index !== 5),
    ]),
  );
  type FixturePrivateKey = {
    algorithm: "ed25519" | "rsa" | "other";
    createdAt: string;
    description: string | null;
    generated: boolean;
    id: string;
    name: string;
    privateKey: string;
    publicKey: string | null;
    updatedAt: string;
  };
  const fixturePrivateKeyValue = `-----BEGIN PRIVATE KEY-----\n${"cHJpdmF0ZS1rZXktZml4dHVyZQ==".repeat(4)}\n-----END PRIVATE KEY-----`;
  const privateKeys: FixturePrivateKey[] = [
    {
      algorithm: "ed25519",
      createdAt: fixtureNow,
      description: "Primary deployment key",
      generated: true,
      id: "d1111111-1111-4111-8111-111111111111",
      name: "Production servers",
      privateKey: fixturePrivateKeyValue,
      publicKey: `ssh-ed25519 ${"A".repeat(68)} towbar-fixture`,
      updatedAt: fixtureNow,
    },
    {
      algorithm: "rsa",
      createdAt: fixtureNow,
      description: "Key for a future server",
      generated: true,
      id: "d1111111-1111-4111-8111-222222222222",
      name: "Spare server key",
      privateKey: fixturePrivateKeyValue,
      publicKey: `ssh-rsa ${"B".repeat(68)} towbar-fixture`,
      updatedAt: fixtureNow,
    },
  ];
  const selectedPrivateKeys = new Map<string, string>([
    [fixtureIds.secondaryServer, privateKeys[0]!.id],
  ]);
  applyFixtureSecretMutation(`credentials:${fixtureIds.secondaryServer}`, {
    set: { privateKey: fixturePrivateKeyValue },
  });
  for (const server of servers.slice(2))
    selectedPrivateKeys.set(server.id, privateKeys[0]!.id);
  const terminal = terminalFixture(
    () => teamAccess.getUser()?.workspaceRole === "admin",
  );
  const integrationFixture = (
    provider: string,
    slug: string,
    name: string,
    configuration: Record<string, unknown>,
    purpose: string,
  ) => ({
    id: crypto.randomUUID(),
    slug,
    name,
    description: `${name} local fixture`,
    provider,
    configuration,
    credentialValues:
      provider === "registry"
        ? { username: "towbar-fixture" }
        : provider === "gitlab"
          ? { oauthClientId: "towbar-fixture-client" }
          : provider === "s3" || provider === "r2"
            ? { accessKeyId: "FIXTUREACCESSKEY" }
            : provider === "infisical"
              ? { clientId: "fixture-client-id" }
              : {},
    scopes: [
      purpose === "identity" || purpose === "backup"
        ? { kind: "control-plane", purpose }
        : { kind: "workspace", purpose },
    ],
    revision: 1,
    credentialHint: "fixture",
    verificationStatus: "verified",
    verificationMessage: "Connection verified by the local fixture.",
    verifiedAt: fixtureNow,
    disconnectedAt: null as string | null,
    createdAt: fixtureNow,
    updatedAt: fixtureNow,
  });
  const namedIntegrations = [
    integrationFixture(
      "gitlab",
      "gitlab-main",
      "GitLab",
      { baseUrl: "https://gitlab.com", allowPrivateNetwork: false },
      "source",
    ),
    integrationFixture(
      "registry",
      "registry-main",
      "OCI registry",
      { registry: "registry.example.com", allowPrivateNetwork: false },
      "image",
    ),
    integrationFixture(
      "s3",
      "s3-production",
      "Production S3",
      {
        region: "ap-south-1",
        bucket: "towbar-fixture-backups",
        prefix: "control-plane",
        addressingStyle: "auto",
        allowPrivateNetwork: false,
      },
      "backup",
    ),
    integrationFixture(
      "r2",
      "r2-archive",
      "Cloudflare R2",
      {
        endpoint: "https://fixture.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "towbar-fixture-r2",
        prefix: "towbar",
        addressingStyle: "auto",
        allowPrivateNetwork: false,
      },
      "backup",
    ),
    integrationFixture(
      "gcs",
      "gcs-production",
      "Google Cloud Storage",
      {
        projectId: "towbar-fixture",
        bucket: "towbar-fixture-gcs-backups",
        prefix: "towbar",
      },
      "backup",
    ),
    integrationFixture(
      "infisical",
      "infisical-production",
      "Infisical",
      { baseUrl: "https://app.infisical.com", allowPrivateNetwork: false },
      "secret",
    ),
    integrationFixture(
      "doppler",
      "doppler-production",
      "Doppler",
      {},
      "secret",
    ),
    integrationFixture(
      "cloudflare",
      "cloudflare-production",
      "Cloudflare",
      {
        accountId: "fixture-account",
        zoneId: "fixture-zone",
        cloudflaredImage:
          "cloudflare/cloudflared@sha256:b269e8abd07a5bf6f3f4be65d5050b2174eca89c56a0241a8ff32a16aec454e4",
      },
      "ingress",
    ),
  ];
  const eventHistory = eventHistoryFixture(teamAccess.getUser, user);
  let emailDestinations = [
    {
      id: "a1111111-1111-4111-8111-555555555555",
      email: "operations@example.com",
      deployments: false,
      deploymentFailures: true,
      backupsAndRestores: true,
      scout: true,
    },
  ];
  let slackDestinations = slackConfigured
    ? [
        {
          id: "a2222222-2222-4222-8222-222222222222",
          channelId: "C12345678",
          deployments: true,
          deploymentFailures: false,
          backupsAndRestores: true,
          scout: true,
        },
      ]
    : [];
  let discordDestinations = discordConfigured
    ? [
        {
          routeId: "discord-123456789012345678",
          webhookId: "123456789012345678",
          deployments: true,
          deploymentFailures: false,
          backupsAndRestores: false,
          alertsAndIncidents: true,
        },
        {
          routeId: "discord-223456789012345678",
          webhookId: "223456789012345678",
          deployments: false,
          deploymentFailures: true,
          backupsAndRestores: true,
          alertsAndIncidents: false,
        },
      ]
    : [];
  let webhookDestinations = webhookConfigured
    ? [
        {
          routeId: "webhook-operations",
          label: "Operations",
          hostname: "hooks.example.com",
          deployments: true,
          deploymentFailures: false,
          backupsAndRestores: false,
          alertsAndIncidents: true,
        },
        {
          routeId: "webhook-archive",
          label: "Archive",
          hostname: "events.example.org",
          deployments: false,
          deploymentFailures: true,
          backupsAndRestores: true,
          alertsAndIncidents: false,
        },
      ]
    : [];
  let telegramDestinations = telegramConfigured
    ? [
        {
          id: "a3333333-3333-4333-8333-333333333333",
          chatId: "-1001234567890",
          messageThreadId: null as number | null,
          deployments: true,
          deploymentFailures: false,
          backupsAndRestores: false,
          alertsAndIncidents: true,
        },
      ]
    : [];
  const upgradeFixture = createUpgradeFixture(
    publicDemo ? undefined : upgradeScenario,
    fixtureSystemHealth,
  );
  const notificationReadAt = new Map<string, string>();
  const fixtureServer = createServer(async (request, response) => {
    useFixtureLocalization(response, teamAccess.getPreferences);
    if (!authorizeFixtureCorsRequest(response, request.headers.origin)) return;
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const path = requestUrl.pathname;
    if (eventHistory(request, response, requestUrl)) return;
    if (
      path === "/v1/public/auth/state" &&
      (await upgradeFixture(request, response, path))
    )
      return;
    if (await teamAccess.handle(request, response, requestUrl)) return;
    if (
      path === "/v1/core/notifications/read-all" &&
      request.method === "POST"
    ) {
      const readAt = new Date().toISOString();
      for (const item of notificationEvents) {
        if (!notificationReadAt.has(item.id))
          notificationReadAt.set(item.id, readAt);
      }
      writeJson(response, 200, { ok: true });
      return;
    }
    if (path === "/v1/core/notifications" && request.method === "GET") {
      const limit = Math.min(
        100,
        Math.max(1, Number(requestUrl.searchParams.get("limit") ?? 50)),
      );
      const before = requestUrl.searchParams.get("before");
      const beforeId = requestUrl.searchParams.get("beforeId");
      const visible = notificationEvents
        .map((item) => ({
          ...item,
          readAt: notificationReadAt.get(item.id) ?? null,
        }))
        .filter(
          (item) =>
            !item.readAt || Date.parse(item.readAt) >= Date.now() - 86_400_000,
        )
        .sort(
          (a, b) =>
            b.occurredAt.localeCompare(a.occurredAt) ||
            b.id.localeCompare(a.id),
        )
        .filter(
          (item) =>
            !before ||
            item.occurredAt < before ||
            (item.occurredAt === before && item.id < (beforeId ?? "")),
        );
      const page = visible.slice(0, limit);
      const last = page.at(-1);
      writeJson(response, 200, {
        notifications: page,
        unreadCount: notificationEvents.filter(
          (item) => !notificationReadAt.has(item.id),
        ).length,
        nextCursor:
          visible.length > limit && last
            ? { before: last.occurredAt, beforeId: last.id }
            : null,
      });
      return;
    }
    if (await upgradeFixture(request, response, path)) return;
    if (
      path === "/v1/core/notifications/telegram/destinations/test" &&
      request.method === "POST"
    ) {
      if (!notificationProviderState.telegram)
        return writeJson(response, 400, {
          error: { message: "Configure Telegram before testing destinations" },
        });
      const body = (await readRequestJson(request)) as {
        chatId?: string;
        messageThreadId?: number | null;
      };
      if (
        !telegramDestinations.some(
          (row) =>
            row.chatId === body.chatId &&
            row.messageThreadId === body.messageThreadId,
        )
      )
        return writeJson(response, 404, {
          error: { message: "Telegram destination was not found" },
        });
      return writeJson(response, 200, { status: "accepted" });
    }
    if (path === "/v1/core/notifications/telegram/destinations") {
      if (request.method === "GET")
        return writeJson(response, 200, { destinations: telegramDestinations });
      if (request.method === "PUT") {
        if (!notificationProviderState.telegram)
          return writeJson(response, 400, {
            error: { message: "Configure Telegram before saving destinations" },
          });
        const body = (await readRequestJson(request)) as {
          destinations?: typeof telegramDestinations;
        };
        if (
          !Array.isArray(body.destinations) ||
          body.destinations.some(
            (row) =>
              !/^-?\d{1,20}$/.test(row.chatId) ||
              (row.messageThreadId !== null &&
                (!Number.isInteger(row.messageThreadId) ||
                  row.messageThreadId < 1 ||
                  row.messageThreadId > 2_147_483_647)) ||
              typeof row.deployments !== "boolean" ||
              typeof row.deploymentFailures !== "boolean" ||
              (row.deployments && row.deploymentFailures) ||
              typeof row.backupsAndRestores !== "boolean" ||
              typeof row.alertsAndIncidents !== "boolean",
          ) ||
          new Set(
            body.destinations.map(
              (row) => `${row.chatId}:${row.messageThreadId ?? 0}`,
            ),
          ).size !== body.destinations.length
        )
          return writeJson(response, 400, {
            error: { message: "Invalid Telegram destinations" },
          });
        const existingIds = new Map(
          telegramDestinations.map((row) => [
            `${row.chatId}:${row.messageThreadId ?? 0}`,
            row.id,
          ]),
        );
        telegramDestinations = body.destinations.map((row) => ({
          ...row,
          id:
            existingIds.get(`${row.chatId}:${row.messageThreadId ?? 0}`) ??
            randomUUID(),
        }));
        return writeJson(response, 200, { destinations: telegramDestinations });
      }
    }
    if (
      path === "/v1/core/notifications/discord/destinations/test" &&
      request.method === "POST"
    ) {
      if (!notificationProviderState.discord)
        return writeJson(response, 400, {
          error: { message: "Configure Discord before testing routes" },
        });
      const body = (await readRequestJson(request)) as { routeId?: string };
      if (!discordDestinations.some((row) => row.routeId === body.routeId))
        return writeJson(response, 404, {
          error: { message: "Discord destination was not found" },
        });
      return writeJson(response, 200, { status: "accepted" });
    }
    if (path === "/v1/core/notifications/discord/destinations") {
      if (request.method === "GET")
        return writeJson(response, 200, { destinations: discordDestinations });
      if (request.method === "PUT") {
        if (!notificationProviderState.discord)
          return writeJson(response, 400, {
            error: { message: "Configure Discord before saving destinations" },
          });
        const body = (await readRequestJson(request)) as {
          destinations?: typeof discordDestinations;
        };
        if (
          !Array.isArray(body.destinations) ||
          body.destinations.some(
            (row) =>
              !discordDestinations.some(
                (existing) =>
                  existing.routeId === row.routeId &&
                  existing.webhookId === row.webhookId,
              ) ||
              typeof row.deployments !== "boolean" ||
              typeof row.deploymentFailures !== "boolean" ||
              (row.deployments && row.deploymentFailures) ||
              typeof row.backupsAndRestores !== "boolean" ||
              typeof row.alertsAndIncidents !== "boolean",
          ) ||
          new Set(body.destinations.map((row) => row.routeId)).size !==
            body.destinations.length
        )
          return writeJson(response, 400, {
            error: { message: "Invalid Discord destinations" },
          });
        const updates = new Map(
          body.destinations.map((row) => [row.routeId, row]),
        );
        discordDestinations = discordDestinations.map(
          (row) => updates.get(row.routeId) ?? row,
        );
        return writeJson(response, 200, { destinations: discordDestinations });
      }
    }
    if (
      path === "/v1/core/notifications/webhook/destinations/test" &&
      request.method === "POST"
    ) {
      if (!notificationProviderState.webhook)
        return writeJson(response, 400, {
          error: { message: "Configure webhook endpoints before testing" },
        });
      const body = (await readRequestJson(request)) as { routeId?: string };
      if (!webhookDestinations.some((row) => row.routeId === body.routeId))
        return writeJson(response, 404, {
          error: { message: "Webhook destination was not found" },
        });
      return writeJson(response, 200, { status: "accepted" });
    }
    if (path === "/v1/core/notifications/webhook/destinations") {
      if (request.method === "GET")
        return writeJson(response, 200, { destinations: webhookDestinations });
      if (request.method === "PUT") {
        if (!notificationProviderState.webhook)
          return writeJson(response, 400, {
            error: { message: "Configure webhook endpoints before saving" },
          });
        const body = (await readRequestJson(request)) as {
          destinations?: typeof webhookDestinations;
        };
        if (
          !Array.isArray(body.destinations) ||
          body.destinations.some(
            (row) =>
              !webhookDestinations.some(
                (existing) =>
                  existing.routeId === row.routeId &&
                  existing.label === row.label &&
                  existing.hostname === row.hostname,
              ) ||
              typeof row.deployments !== "boolean" ||
              typeof row.deploymentFailures !== "boolean" ||
              (row.deployments && row.deploymentFailures) ||
              typeof row.backupsAndRestores !== "boolean" ||
              typeof row.alertsAndIncidents !== "boolean",
          ) ||
          new Set(body.destinations.map((row) => row.routeId)).size !==
            body.destinations.length
        )
          return writeJson(response, 400, {
            error: { message: "Invalid webhook destinations" },
          });
        const updates = new Map(
          body.destinations.map((row) => [row.routeId, row]),
        );
        webhookDestinations = webhookDestinations.map(
          (row) => updates.get(row.routeId) ?? row,
        );
        return writeJson(response, 200, { destinations: webhookDestinations });
      }
    }
    if (
      path === "/v1/core/notifications/email/destinations/test" &&
      request.method === "POST"
    ) {
      if (!notificationProviderState.smtp)
        return writeJson(response, 400, {
          error: {
            message: "Configure SMTP before testing email destinations",
          },
        });
      const body = (await readRequestJson(request)) as { email?: string };
      if (!emailDestinations.some((row) => row.email === body.email))
        return writeJson(response, 404, {
          error: { message: "Email destination was not found" },
        });
      return writeJson(response, 200, { status: "accepted" });
    }
    if (path === "/v1/core/notifications/email/destinations") {
      if (request.method === "GET")
        return writeJson(response, 200, { destinations: emailDestinations });
      if (request.method === "PUT") {
        if (!notificationProviderState.smtp)
          return writeJson(response, 400, {
            error: {
              message:
                "Configure SMTP in the runtime before adding email destinations",
            },
          });
        const body = (await readRequestJson(request)) as {
          destinations?: typeof emailDestinations;
        };
        if (
          !Array.isArray(body.destinations) ||
          body.destinations.some(
            (row) =>
              typeof row.deployments !== "boolean" ||
              typeof row.deploymentFailures !== "boolean" ||
              (row.deployments && row.deploymentFailures),
          )
        )
          return writeJson(response, 400, {
            error: { message: "Invalid email destinations" },
          });
        const existingIds = new Map(
          emailDestinations.map((row) => [row.email, row.id]),
        );
        emailDestinations = body.destinations.map((row) => ({
          ...row,
          id: existingIds.get(row.email) ?? randomUUID(),
        }));
        return writeJson(response, 200, { destinations: emailDestinations });
      }
    }
    if (
      path === "/v1/core/notifications/slack/destinations/test" &&
      request.method === "POST"
    ) {
      if (!notificationProviderState.slack)
        return writeJson(response, 400, {
          error: { message: "Configure Slack before testing channels" },
        });
      const body = (await readRequestJson(request)) as { channelId?: string };
      if (!slackDestinations.some((row) => row.channelId === body.channelId))
        return writeJson(response, 404, {
          error: { message: "Slack destination was not found" },
        });
      return writeJson(response, 200, { status: "accepted" });
    }
    if (path === "/v1/core/notifications/slack/destinations") {
      if (request.method === "GET")
        return writeJson(response, 200, { destinations: slackDestinations });
      if (request.method === "PUT") {
        if (!notificationProviderState.slack)
          return writeJson(response, 400, {
            error: {
              message:
                "Configure Slack bot credentials in the runtime before adding channels",
            },
          });
        const body = (await readRequestJson(request)) as {
          destinations?: typeof slackDestinations;
        };
        if (
          !Array.isArray(body.destinations) ||
          body.destinations.some(
            (row) =>
              !/^[A-Z][A-Z0-9]{1,79}$/.test(row.channelId) ||
              typeof row.deployments !== "boolean" ||
              typeof row.deploymentFailures !== "boolean" ||
              (row.deployments && row.deploymentFailures) ||
              typeof row.backupsAndRestores !== "boolean" ||
              typeof row.scout !== "boolean",
          ) ||
          new Set(body.destinations.map((row) => row.channelId)).size !==
            body.destinations.length
        )
          return writeJson(response, 400, {
            error: { message: "Invalid Slack destinations" },
          });
        const existingIds = new Map(
          slackDestinations.map((row) => [row.channelId, row.id]),
        );
        slackDestinations = body.destinations.map((row) => ({
          ...row,
          id: existingIds.get(row.channelId) ?? randomUUID(),
        }));
        return writeJson(response, 200, { destinations: slackDestinations });
      }
    }
    if (path === "/v1/core/integrations" && request.method === "GET") {
      return writeJson(response, 200, {
        integrations: [
          { category: "source-control", provider: "github", details: [] },
          { category: "source-control", provider: "gitlab", details: [] },
          {
            category: "registry",
            provider: "registry",
            details: [
              { label: "Registry host", value: "registry.example.com" },
            ],
          },
          {
            category: "backup",
            provider: "aws",
            details: [{ label: "Region", value: "us-east-1" }],
          },
          {
            category: "backup",
            provider: "gcs",
            details: [
              { label: "Project ID", value: "towbar-example" },
              { label: "Bucket", value: "towbar-backups" },
            ],
          },
          {
            category: "backup",
            provider: "s3",
            details: [
              { label: "Region", value: "us-east-1" },
              { label: "Bucket", value: "towbar-backups" },
            ],
          },
          {
            category: "backup",
            provider: "r2",
            details: [
              {
                label: "Endpoint",
                value: "https://example.r2.cloudflarestorage.com",
              },
              { label: "Bucket", value: "towbar-backups" },
            ],
          },
          {
            category: "secrets",
            provider: "infisical",
            details: [{ label: "Server", value: "https://app.infisical.com" }],
          },
          { category: "secrets", provider: "doppler", details: [] },
          {
            category: "platform",
            provider: "cloudflare",
            details: [
              { label: "Account ID", value: "example-account" },
              { label: "Zone ID", value: "example-zone" },
            ],
          },
        ],
      });
    }
    if (path === "/v1/core/gitlab/connections" && request.method === "GET")
      return writeJson(response, 200, {
        connections: namedIntegrations
          .filter(
            (connection) =>
              connection.provider === "gitlab" && !connection.disconnectedAt,
          )
          .map((connection) => ({
            id: connection.id,
            slug: connection.slug,
            name: connection.name,
            description: "towbar-fixture",
            verificationStatus: connection.verificationStatus,
          })),
      });
    if (path === "/v1/core/gitlab/oauth/start" && request.method === "POST")
      return writeJson(response, 200, {
        authorizationUrl: publicDemo
          ? "/manage/integrations/gitlab?connected=true"
          : "http://localhost:4021/manage/integrations/gitlab?connected=true",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    if (
      path === "/v1/core/gitlab/oauth/connection" &&
      request.method === "DELETE"
    ) {
      const connection = namedIntegrations.find(
        (item) => item.provider === "gitlab" && !item.disconnectedAt,
      );
      if (connection) connection.disconnectedAt = new Date().toISOString();
      response.writeHead(204);
      response.end();
      return;
    }
    if (path === "/v1/core/gitlab/repositories" && request.method === "GET")
      return writeJson(response, 200, {
        repositories: [
          {
            id: 1001,
            owner: "towbar-fixture",
            name: "platform",
            defaultBranch: "main",
            visibility: "private",
            webUrl: "https://gitlab.com/towbar-fixture/platform",
          },
        ],
        nextPage: null,
      });
    if (path === "/v1/core/gitlab/groups" && request.method === "GET")
      return writeJson(response, 200, {
        groups: [
          {
            id: 100,
            name: "Towbar fixture",
            fullPath: "towbar-fixture",
          },
        ],
        nextPage: null,
      });
    if (path === "/v1/core/gitlab/branches" && request.method === "GET")
      return writeJson(response, 200, { branches: ["main", "develop"] });
    const terminalMatch = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/terminal$/,
    );
    if (terminalMatch && request.method === "POST") {
      if (!selectedPrivateKeys.has(terminalMatch[1]!))
        return writeJson(response, 409, {
          error: { message: "Connect a private key in Credentials first." },
        });
      return writeJson(response, 200, terminal.issue());
    }
    if (path === "/v1/core/github/installation" && request.method === "GET") {
      writeJson(response, 200, {
        connections: activeGitHubConnections,
        connection:
          activeGitHubConnections.length === 1
            ? activeGitHubConnections[0]
            : null,
      });
      return;
    }
    if (path === "/v1/core/github") {
      if (request.method === "GET") {
        writeJson(response, 200, {
          canManage: true,
          configuration: githubAppConfiguration,
          connections: activeGitHubConnections,
          connection:
            activeGitHubConnections.length === 1
              ? activeGitHubConnections[0]
              : null,
          previewReporting,
        });
        return;
      }
      if (request.method === "DELETE") {
        const id = requestUrl.searchParams.get("connectionId");
        if (!id && activeGitHubConnections.length > 1)
          return writeJson(response, 409, {
            error: { message: "Choose a GitHub account for this operation" },
          });
        const selected = activeGitHubConnections.find((connection) =>
          id ? connection.id === id : true,
        );
        if (id && !selected) return writeNotFound(response);
        activeGitHubConnections = activeGitHubConnections.map((connection) =>
          connection.id === selected?.id
            ? { ...connection, suspendedAt: new Date().toISOString() }
            : connection,
        );
        response.writeHead(204);
        response.end();
        return;
      }
    }
    if (
      request.method === "POST" &&
      path === "/v1/core/github/actions/installation-url"
    ) {
      const callback = new URL(
        "/manage/integrations/github",
        request.headers.origin ?? "http://localhost:4021",
      );
      callback.searchParams.set(
        "installation_id",
        githubConnection.installationId,
      );
      callback.searchParams.set("state", githubInstallationState);
      writeJson(response, 200, {
        url: publicDemo
          ? callback.pathname + callback.search
          : callback.toString(),
      });
      return;
    }
    if (
      request.method === "POST" &&
      path === "/v1/core/github/actions/complete-installation"
    ) {
      void readRequestJson(request)
        .then((input) => {
          const values = input as {
            installationId?: string;
            state?: string;
          };
          if (
            values.installationId !== githubConnection.installationId ||
            values.state !== githubInstallationState
          ) {
            writeJson(response, 400, {
              error: { message: "Invalid GitHub installation callback" },
            });
            return;
          }
          const activeGitHubConnection = {
            ...githubConnection,
            permissionReadiness: { ...githubConnection.permissionReadiness },
            updatedAt: new Date().toISOString(),
          };
          activeGitHubConnections = [
            ...activeGitHubConnections.filter(
              (connection) => connection.id !== activeGitHubConnection.id,
            ),
            activeGitHubConnection,
          ];
          writeJson(response, 201, {
            installation: { id: activeGitHubConnection.id },
          });
        })
        .catch(() =>
          writeJson(response, 400, {
            error: { message: "Invalid JSON" },
          }),
        );
      return;
    }
    if (request.method === "GET" && path === "/v1/core/github/repositories") {
      const id = requestUrl.searchParams.get("connectionId");
      if (
        id &&
        !activeGitHubConnections.some((connection) => connection.id === id)
      )
        return writeNotFound(response);
      const selected = activeGitHubConnections.filter(
        (connection) =>
          (!id || connection.id === id) && !connection.suspendedAt,
      );
      return writeJson(response, 200, {
        repositories: availableGitHubRepositories.filter((repository) =>
          selected.some(
            (connection) => connection.id === repository.connectionId,
          ),
        ),
        unavailableConnections: activeGitHubConnections
          .filter(
            (connection) =>
              (!id || connection.id === id) && connection.suspendedAt,
          )
          .map((connection) => ({
            id: connection.id,
            accountLogin: connection.accountLogin,
            message: "Reconnect this GitHub account",
          })),
        identityWarnings: [],
      });
    }
    const changeConnection = path.match(
      /^\/v1\/core\/sources\/([^/]+)\/actions\/change-github-connection$/,
    );
    if (request.method === "POST" && changeConnection) {
      const source = [...sources, ...connections.sources].find(
        (item) => item.id === changeConnection[1],
      );
      if (!source) return writeNotFound(response);
      const original = availableGitHubRepositories.find(
        (repository) =>
          repository.owner === source.repositoryOwner &&
          repository.name === source.repositoryName,
      );
      void readRequestJson(request)
        .then((body) => {
          const input = body as {
            githubInstallationId: string;
            repositoryOwner: string;
            repositoryName: string;
          };
          const target = availableGitHubRepositories.find(
            (repository) =>
              repository.connectionId === input.githubInstallationId &&
              repository.owner === input.repositoryOwner &&
              repository.name === input.repositoryName,
          );
          if (
            !target ||
            !activeGitHubConnections.some(
              (connection) =>
                connection.id === input.githubInstallationId &&
                !connection.suspendedAt,
            )
          )
            return writeNotFound(response);
          if (
            target.id !== (sourceRepositoryIds.get(source.id) ?? original?.id)
          )
            return writeJson(response, 409, {
              error: {
                message:
                  "Choose the same GitHub repository after its transfer or rename.",
              },
            });
          sourceRepositoryIds.set(source.id, target.id);
          source.repositoryOwner = target.owner;
          source.repositoryName = target.name;
          source.repositoryUrl = `https://github.com/${target.fullName}`;
          return writeJson(response, 200, { source });
        })
        .catch(() =>
          writeJson(response, 400, { error: { message: "Invalid request" } }),
        );
      return;
    }
    if (request.method === "GET" && path === "/v1/core/github/branches") {
      const connectionId = requestUrl.searchParams.get("connectionId");
      if (!connectionId && activeGitHubConnections.length > 1)
        return writeJson(response, 409, {
          error: { message: "Choose a GitHub account" },
        });
      const account = activeGitHubConnections.find((item) =>
        connectionId ? item.id === connectionId : true,
      );
      if (!account || account.suspendedAt) return writeNotFound(response);
      const owner = requestUrl.searchParams.get("owner");
      const repository = requestUrl.searchParams.get("repository");
      if (
        !availableGitHubRepositories.some(
          (repo) =>
            repo.connectionId === account.id &&
            repo.owner === owner &&
            repo.name === repository,
        )
      ) {
        writeNotFound(response);
        return;
      }
      writeJson(response, 200, { branches: ["develop", "main", "release/qa"] });
      return;
    }

    if (analyticsFixture(request, response, requestUrl)) return;
    if (await logsFixture(request, response, requestUrl)) return;
    if (scoutFixture(request, response, requestUrl)) return;
    if (
      request.method === "GET" &&
      [
        "/v1/core/servers",
        "/v1/core/apps",
        "/v1/core/resources",
        "/v1/core/sources",
      ].includes(path)
    ) {
      const query = Object.fromEntries(requestUrl.searchParams);
      try {
        if (path.endsWith("/servers")) {
          const result = filterServers(
            servers.map((server) => ({
              ...server,
              healthStatus:
                server.setupStatus === "ready" ? "healthy" : "unknown",
              scout: fixtureServerMonitoringSummary(
                monitoring.get(server.id)!,
                server.id,
              ),
            })),
            serverFilters.parse(query),
          );
          writeJson(response, 200, {
            servers: result.items,
            counts: result.counts,
          });
        } else if (path.endsWith("/sources")) {
          const result = filterSources(
            [...sources, ...connections.sources].map((source) => ({
              ...source,
              latestSyncStatus: [
                ...environmentMappings,
                ...connections.mappings,
              ].some((item) => item.sourceId === source.id)
                ? "succeeded"
                : "never",
              autoDeployPaused: false,
            })),
            sourceFilters.parse(query),
          );
          writeJson(response, 200, {
            sources: result.items,
            counts: result.counts,
          });
        } else {
          const resource = path.endsWith("/resources");
          const result = filterWorkloads<FixtureApp | FixtureResource>(
            resource
              ? [...resources, ...connections.resources]
              : [...apps, ...connections.apps],
            workloadFilters.parse(query),
          );
          writeJson(response, 200, {
            [resource ? "resources" : "apps"]: result.items,
            counts: result.counts,
            environments: result.environments,
          });
        }
      } catch {
        writeJson(response, 400, { message: "Invalid inventory filters" });
      }
      return;
    }
    const monitoringPath = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/monitoring(?:\/actions\/(install|uninstall))?$/,
    );
    if (monitoringPath) {
      const id = monitoringPath[1]!;
      const agent = monitoring.get(id);
      if (!agent) {
        writeNotFound(response);
        return;
      }
      if (request.method === "GET") {
        writeJson(response, 200, { agent });
        return;
      }
      void (
        monitoringPath[2] === "uninstall"
          ? Promise.resolve({})
          : readRequestJson(request)
      )
        .then((body) => {
          const input = body as {
            retentionDays?: number;
            acknowledge?: boolean;
          };
          if (
            input.retentionDays &&
            ![7, 15, 30, 60].includes(input.retentionDays)
          ) {
            writeJson(response, 400, {
              error: { message: "Invalid retention" },
            });
            return;
          }
          if (monitoringPath[2] === "install" && !input.acknowledge) {
            writeJson(response, 400, {
              error: { message: "Acknowledgement required" },
            });
            return;
          }
          if (input.retentionDays) agent.retentionDays = input.retentionDays;
          if (monitoringPath[2] === "install")
            Object.assign(agent, fixtureMonitoringAgent(), {
              retentionDays: agent.retentionDays,
            });
          if (monitoringPath[2] === "uninstall")
            Object.assign(agent, {
              desiredState: "disabled",
              status: "disabled",
            });
          writeJson(response, monitoringPath[2] ? 202 : 200, { agent });
        })
        .catch(() =>
          writeJson(response, 400, { error: { message: "Invalid JSON" } }),
        );
      return;
    }
    const metricsPath = path.match(
      /^\/v1\/core\/(servers|apps|resources)\/([^/]+)\/metrics$/,
    );
    if (metricsPath) {
      const workload = metricsPath[1] !== "servers";
      const id = workload
        ? [...apps, ...resources].find((item) => item.id === metricsPath[2])
            ?.serverId
        : metricsPath[2];
      const agent = id ? monitoring.get(id) : undefined;
      if (!agent || !id) {
        writeNotFound(response);
        return;
      }
      writeJson(
        response,
        200,
        fixtureMonitoringHistory(agent, id, requestUrl.searchParams, workload),
      );
      return;
    }

    if (path === "/v1/core/settings/private-keys") {
      if (request.method === "POST") {
        void readRequestJson(request)
          .then((input) => {
            const values = input as {
              algorithm?: "ed25519" | "rsa";
              description?: string | null;
              mode: "generate" | "manual";
              name: string;
              privateKey?: string;
              publicKey?: string | null;
            };
            const now = new Date().toISOString();
            const privateKey: FixturePrivateKey = {
              algorithm:
                values.mode === "generate"
                  ? (values.algorithm ?? "ed25519")
                  : values.publicKey?.startsWith("ssh-rsa")
                    ? "rsa"
                    : values.publicKey?.startsWith("ssh-ed25519")
                      ? "ed25519"
                      : "other",
              createdAt: now,
              description: values.description ?? null,
              generated: values.mode === "generate",
              id: randomUUID(),
              name: values.name,
              privateKey: values.privateKey ?? fixturePrivateKeyValue,
              publicKey:
                values.publicKey ??
                `ssh-${values.algorithm ?? "ed25519"} ${"B".repeat(68)} ${values.name}`,
              updatedAt: now,
            };
            privateKeys.push(privateKey);
            return writeJson(response, 201, {
              privateKey: {
                ...privateKey,
                privateKey: undefined,
                usageCount: 0,
              },
            });
          })
          .catch(() => writeJson(response, 400, { error: "Invalid JSON" }));
      } else
        writeJson(response, 200, {
          canManage: true,
          privateKeys: privateKeys.map((privateKey) => ({
            ...privateKey,
            privateKey: undefined,
            usageCount: [...selectedPrivateKeys.values()].filter(
              (id) => id === privateKey.id,
            ).length,
          })),
        });
      return;
    }
    const privateKeyRevealMatch = path.match(
      /^\/v1\/core\/settings\/private-keys\/([^/]+)\/reveal$/,
    );
    if (request.method === "GET" && privateKeyRevealMatch) {
      const privateKey = privateKeys.find(
        (item) => item.id === privateKeyRevealMatch[1],
      );
      if (!privateKey) return writeNotFound(response);
      return writeJson(response, 200, { value: privateKey.privateKey });
    }
    const privateKeyMatch = path.match(
      /^\/v1\/core\/settings\/private-keys\/([^/]+)$/,
    );
    if (privateKeyMatch && request.method === "PATCH") {
      const privateKey = privateKeys.find(
        (item) => item.id === privateKeyMatch[1],
      );
      if (!privateKey) return writeNotFound(response);
      void readRequestJson(request)
        .then((input) => {
          const values = input as Partial<FixturePrivateKey>;
          if (
            values.privateKey &&
            [...selectedPrivateKeys.values()].includes(privateKey.id)
          )
            return writeJson(response, 409, {
              error: { message: "Detach this key before changing it." },
            });
          Object.assign(privateKey, values, {
            updatedAt: new Date().toISOString(),
          });
          return writeJson(response, 200, {
            privateKey: {
              ...privateKey,
              privateKey: undefined,
              usageCount: [...selectedPrivateKeys.values()].filter(
                (id) => id === privateKey.id,
              ).length,
            },
          });
        })
        .catch(() => writeJson(response, 400, { error: "Invalid JSON" }));
      return;
    }
    if (privateKeyMatch && request.method === "DELETE") {
      const index = privateKeys.findIndex(
        (item) => item.id === privateKeyMatch[1],
      );
      if (index < 0) return writeNotFound(response);
      if ([...selectedPrivateKeys.values()].includes(privateKeys[index]!.id))
        return writeJson(response, 409, {
          error: { message: "Detach this key before deleting it." },
        });
      privateKeys.splice(index, 1);
      return writeJson(response, 200, { ok: true });
    }
    if (
      request.method === "POST" &&
      path === "/v1/core/system-health/actions/check"
    ) {
      const checkedAt = new Date().toISOString();
      systemHealth = {
        ...systemHealth,
        checkedAt,
        checks: systemHealth.checks.map((check) => ({
          ...check,
          checkedAt,
          status: "healthy",
        })),
        status: "healthy",
      };
      return writeJson(response, 200, fixtureSystemHealth());
    }
    if (request.method === "POST" && path === "/v1/core/sources/connect") {
      void readRequestJson(request)
        .then((body) => writeJson(response, 201, connections.connect(body)))
        .catch((error) =>
          writeJson(response, 400, {
            error:
              error instanceof Error
                ? error.message
                : "Invalid connection request",
          }),
        );
      return;
    }
    if (request.method === "POST" && path === "/v1/core/sources/discover") {
      void readRequestJson(request)
        .then((body) => {
          if (!body || typeof body !== "object" || Array.isArray(body))
            throw new Error("Invalid discovery request");
          const input = body as Record<string, unknown>;
          if (
            !activeGitHubConnections.some(
              (account) =>
                account.id === input.githubInstallationId &&
                !account.suspendedAt,
            )
          )
            return writeJson(response, 404, {
              error: "GitHub installation was not found",
            });
          const repository = availableGitHubRepositories.find(
            (item) =>
              item.connectionId === input.githubInstallationId &&
              item.owner === input.repositoryOwner &&
              item.name === input.repositoryName,
          );
          if (!repository)
            return writeJson(response, 404, {
              error: "Repository was not found",
            });
          if (
            ![repository.defaultBranch, "develop"].includes(
              String(input.discoveryBranch),
            )
          )
            return writeJson(response, 404, {
              error: "Discovery branch was not found",
            });
          return writeJson(response, 200, {
            commitSha,
            environments: [
              { name: "production", previewsEnabled: false },
              { name: "staging", previewsEnabled: true },
            ],
          });
        })
        .catch(() =>
          writeJson(response, 400, { error: "Invalid discovery request" }),
        );
      return;
    }
    if (request.method === "POST" && path === "/v1/core/servers") {
      void readRequestJson(request)
        .then((input) => {
          const config = input as Server["config"];
          if (servers.some((item) => item.canonicalIp === config.ip)) {
            return writeJson(response, 409, {
              error: { message: `Server '${config.ip}' is already configured` },
            });
          }
          const server = createServerFixture(
            randomUUID(),
            config.ip,
            config.ssh.username,
            false,
          );
          server.config = {
            ...config,
            buildConcurrency: config.buildConcurrency ?? 1,
            previewBuildConcurrency: config.previewBuildConcurrency ?? 1,
            ssh: {
              host: config.ssh.host ?? config.ip,
              port: config.ssh.port ?? 22,
              username: config.ssh.username,
            },
          };
          servers.push(server);
          hostKeysByServer.set(server.id, []);
          serverPreparationsByServer.set(server.id, []);
          runtimeCapacity.push(emptyRuntimeCapacity(server));
          monitoring.set(server.id, fixtureMonitoringAgent());
          return writeJson(response, 201, { server });
        })
        .catch(() =>
          writeJson(response, 400, {
            error: { message: "Invalid server configuration" },
          }),
        );
      return;
    }
    const serverNameMatch = path.match(/^\/v1\/core\/servers\/([^/]+)\/name$/);
    if (serverNameMatch && request.method === "PATCH") {
      const server = servers.find((item) => item.id === serverNameMatch[1]);
      if (!server) return writeNotFound(response);
      void readRequestJson(request)
        .then((input) => {
          const name = (input as { name?: unknown }).name;
          if (
            name !== null &&
            (typeof name !== "string" ||
              !name.trim() ||
              name.trim().length > 120)
          ) {
            return writeJson(response, 400, {
              error: { message: "Invalid server name" },
            });
          }
          server.name = typeof name === "string" ? name.trim() : null;
          server.updatedAt = new Date().toISOString();
          return writeJson(response, 200, { server });
        })
        .catch(() =>
          writeJson(response, 400, {
            error: { message: "Invalid server name" },
          }),
        );
      return;
    }
    const serverMutationMatch = path.match(/^\/v1\/core\/servers\/([^/]+)$/);
    if (serverMutationMatch && request.method === "PATCH") {
      const server = servers.find((item) => item.id === serverMutationMatch[1]);
      if (!server) return writeNotFound(response);
      void readRequestJson(request)
        .then((input) => {
          const config = input as Server["config"];
          if (config.ip !== server.canonicalIp) {
            return writeJson(response, 409, {
              error: {
                message: "Add a new server to use a different IP address",
              },
            });
          }
          server.config = config;
          server.setupStatus = "pending";
          server.updatedAt = new Date().toISOString();
          return writeJson(response, 200, { server });
        })
        .catch(() =>
          writeJson(response, 400, {
            error: { message: "Invalid server configuration" },
          }),
        );
      return;
    }
    if (serverMutationMatch && request.method === "DELETE") {
      const index = servers.findIndex(
        (item) => item.id === serverMutationMatch[1],
      );
      if (index < 0) return writeNotFound(response);
      servers.splice(index, 1);
      response.writeHead(204);
      response.end();
      return;
    }
    if (
      request.method === "POST" &&
      /^\/v1\/core\/sources\/[^/]+\/actions\/sync$/.test(path) &&
      sources.some((item) => item.id === path.split("/")[4])
    ) {
      return writeJson(response, 202, { sync: { id: sourceSync.id } });
    }
    const autoDeployControlMatch = path.match(
      /^\/v1\/core\/(sources|apps|resources)\/([^/]+)\/auto-deploy-control$/,
    );
    if (autoDeployControlMatch) {
      const [, kind, id] = autoDeployControlMatch;
      const control =
        kind === "sources"
          ? id === source.id
            ? sourceAutoDeployControl
            : sources.some((item) => item.id === id)
              ? getFixtureSourceAutoDeployControl(id!)
              : undefined
          : getFixtureDeployableAutoDeployControl(kind!, id!);
      if (!control) return writeNotFound(response);
      if (request.method === "GET") {
        return writeJson(response, 200, {
          autoDeploy: control,
          canManageAutoDeploy: true,
        });
      }
      if (request.method === "PATCH") {
        void readRequestJson(request)
          .then((input) => {
            applyFixtureAutoDeployControlPatch(
              control,
              input as Record<string, unknown>,
              kind === "sources" ? "source" : "deployable",
            );
            return writeJson(response, 200, {
              autoDeploy: control,
              canManageAutoDeploy: true,
            });
          })
          .catch(() =>
            writeJson(response, 400, {
              error: { message: "Request body must be valid JSON" },
            }),
          );
        return;
      }
    }
    if (declaredSecrets.owns(path)) {
      if (request.method === "GET") {
        try {
          const payload = declaredSecrets.read(
            path,
            requestUrl.searchParams.get("environment"),
          );
          return payload
            ? writeJson(response, 200, payload)
            : writeNotFound(response);
        } catch (error) {
          return writeJson(
            response,
            error instanceof FixtureEnvironmentError ? error.status : 400,
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Invalid secret request",
            },
          );
        }
      }
      response.setHeader("Cache-Control", "no-store");
      void readRequestJson(request)
        .then((body) => {
          const payload = declaredSecrets.mutate(request.method!, path, body);
          return payload
            ? writeJson(response, 200, payload)
            : writeNotFound(response);
        })
        .catch((error) =>
          writeJson(
            response,
            error instanceof FixtureEnvironmentError ? error.status : 400,
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Invalid secret request",
            },
          ),
        );
      return;
    }
    const revealMatch = path.match(
      /^\/v1\/core\/(apps|resources)\/([^/]+)\/secrets\/([a-z][a-z0-9-]{0,62})\/(build|deployment|pre_deploy|post_deploy)\/reveal(?:-all)?$/,
    );
    const globalRevealMatch = path.match(
      /^\/v1\/core\/settings\/secrets\/([a-z][a-z0-9-]{0,62})\/(build|deployment|pre_deploy|post_deploy)\/reveal(?:-all)?$/,
    );
    if (request.method === "POST" && (revealMatch || globalRevealMatch)) {
      const slot = revealMatch
        ? `${revealMatch[2]}:${revealMatch[3]}:${revealMatch[4]}`
        : `${user.workspaceId}:production:${globalRevealMatch![2]}`;
      response.setHeader("Cache-Control", "no-store");
      void readRequestJson(request)
        .then((input) => {
          if (path.endsWith("/reveal-all")) {
            return writeJson(response, 200, {
              values: Object.fromEntries(
                (fixtureSecretKeys.get(slot) ?? []).map((key) => [
                  key,
                  fixtureSecretValues.get(slot)?.[key] ??
                    `fixture-only-${key.toLowerCase()}`,
                ]),
              ),
              revision: fixtureSecretVersions.get(slot) ?? null,
            });
          }
          const { key } = input as { key: string };
          if (!fixtureSecretKeys.get(slot)?.includes(key))
            return writeNotFound(response);
          return writeJson(response, 200, {
            value:
              fixtureSecretValues.get(slot)?.[key] ??
              `fixture-only-${key.toLowerCase()}`,
            revision: fixtureSecretVersions.get(slot) ?? null,
          });
        })
        .catch(() =>
          writeJson(response, 400, {
            error: { message: "Invalid reveal request" },
          }),
        );
      return;
    }
    const mutationMatch = path.match(
      /^\/v1\/core\/(apps|resources)\/([^/]+)\/secrets\/([a-z][a-z0-9-]{0,62})\/(build|deployment|pre_deploy|post_deploy)$/,
    );
    const globalSecretMutationMatch = path.match(
      /^\/v1\/core\/settings\/secrets\/([a-z][a-z0-9-]{0,62})\/(build|deployment|pre_deploy|post_deploy)$/,
    );
    const credentialMatch = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/credentials$/,
    );
    const credentialVerificationRequestMatch = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/credentials\/actions\/verify-private-key$/,
    );
    if (request.method === "POST" && credentialVerificationRequestMatch) {
      const serverId = credentialVerificationRequestMatch[1]!;
      const server = servers.find((item) => item.id === serverId);
      if (!server) return writeNotFound(response);
      void readRequestJson(request)
        .then((input) => {
          const payload = input as {
            expectedRevision: string | null;
            privateKeyId?: string;
          };
          const storedPrivateKey = privateKeys.find(
            (privateKey) => privateKey.id === payload.privateKeyId,
          );
          const slot = `credentials:${serverId}`;
          if (
            payload.expectedRevision !==
            (fixtureSecretVersions.get(slot) ?? null)
          )
            return writeJson(response, 409, {
              error: {
                message:
                  "Server credentials changed after loading. Refresh before saving.",
              },
            });
          if (!storedPrivateKey)
            return writeJson(response, 422, {
              error: { message: "Select a stored SSH private key." },
            });

          const now = new Date().toISOString();
          const trusted = (hostKeysByServer.get(serverId) ?? []).some(
            (hostKey) => hostKey.fingerprint === discoveredHostKey.fingerprint,
          );
          const verification: FixtureCredentialVerification = {
            createdAt: now,
            errorCode: trusted ? null : "HOST_KEY_NOT_TRUSTED",
            errorMessage: trusted
              ? null
              : "Trust a discovered SSH host key before Towbar connects.",
            finishedAt: now,
            id: randomUUID(),
            result: trusted
              ? { hostKey: discoveredHostKey }
              : { discoveredHostKeys: [discoveredHostKey] },
            startedAt: now,
            status: trusted ? "succeeded" : "failed",
          };
          if (trusted)
            applyFixtureSecretMutation(slot, {
              set: { privateKey: storedPrivateKey.privateKey },
            });
          if (trusted) selectedPrivateKeys.set(serverId, storedPrivateKey.id);
          credentialVerifications.set(verification.id, verification);
          return writeJson(response, 202, { verification });
        })
        .catch(() =>
          writeJson(response, 400, {
            error: { message: "Invalid credential verification request" },
          }),
        );
      return;
    }
    const credentialVerificationMatch = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/credentials\/verifications\/([^/]+)$/,
    );
    if (request.method === "GET" && credentialVerificationMatch) {
      const server = servers.find(
        (item) => item.id === credentialVerificationMatch[1],
      );
      const verification = credentialVerifications.get(
        credentialVerificationMatch[2]!,
      );
      if (!server || !verification) return writeNotFound(response);
      return writeJson(response, 200, { verification });
    }
    if (
      request.method === "PATCH" &&
      (mutationMatch || globalSecretMutationMatch || credentialMatch)
    ) {
      const key = mutationMatch
        ? `${mutationMatch[2]}:${mutationMatch[3]}:${mutationMatch[4]}`
        : globalSecretMutationMatch
          ? `${user.workspaceId}:production:${globalSecretMutationMatch[2]}`
          : `credentials:${credentialMatch![1]}`;
      void readRequestJson(request)
        .then((input) => {
          const payload = input as {
            expectedRevision: string | null;
            set?: Record<string, string>;
            delete?: string[];
          };
          if (credentialMatch && payload.set?.privateKey !== undefined)
            return writeJson(response, 422, {
              error: {
                message: "Verify SSH private keys before saving them.",
              },
            });
          if (
            payload.expectedRevision !==
            (fixtureSecretVersions.get(key) ?? null)
          )
            return writeJson(response, 409, {
              error: {
                message:
                  "These secrets changed after loading. Refresh before saving.",
              },
            });
          applyFixtureSecretMutation(key, payload);
          if (credentialMatch && payload.delete?.includes("privateKey")) {
            hostKeysByServer.set(credentialMatch[1]!, []);
            credentialVerifications.clear();
            selectedPrivateKeys.delete(credentialMatch[1]!);
          }
          return writeJson(response, 200, {
            secret: fixtureMetadata(key),
            credential: fixtureMetadata(key),
          });
        })
        .catch(() =>
          writeJson(response, 400, {
            error: { message: "Invalid secret changes" },
          }),
        );
      return;
    }
    if (request.method === "GET" && credentialMatch)
      return writeJson(response, 200, {
        credential: fixtureMetadata(`credentials:${credentialMatch[1]}`),
        canManage: true,
        selectedPrivateKeyId:
          selectedPrivateKeys.get(credentialMatch[1]!) ?? null,
      });
    const deletePreviewMatch = path.match(
      /^\/v1\/core\/previews\/([^/]+)\/actions\/delete$/,
    );
    if (request.method === "POST" && deletePreviewMatch) {
      const preview = previews.find(
        (item) => item.id === deletePreviewMatch[1],
      );
      if (!preview) return writeNotFound(response);
      preview.status = "deleting";
      previews.splice(previews.indexOf(preview), 1);
      preview.updatedAt = new Date().toISOString();
      return writeJson(response, 202, { accepted: true });
    }
    if (
      request.method === "POST" &&
      path === "/v1/core/github/actions/retry-preview-reporting"
    ) {
      previewReporting.failedCount = 0;
      previewReporting.lastError = null;
      previewReporting.lastFailedAt = null;
      return writeJson(response, 200, {
        attempted: 1,
        failed: 0,
        succeeded: 1,
      });
    }
    const trustHostKeyMatch = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/host-keys\/actions\/trust$/,
    );
    if (request.method === "POST" && trustHostKeyMatch) {
      void readOptionalRequestJson(request).then((payload) => {
        const hostKeys = hostKeysByServer.get(trustHostKeyMatch[1]!);
        if (!hostKeys) return writeNotFound(response);
        if (payload.replaceExisting === true)
          hostKeys.splice(0, hostKeys.length);
        if (
          !hostKeys.some(
            (key) => key.fingerprint === discoveredHostKey.fingerprint,
          )
        ) {
          hostKeys.push({
            algorithm: discoveredHostKey.algorithm,
            createdAt: new Date().toISOString(),
            fingerprint: discoveredHostKey.fingerprint,
            id: "c1111111-1111-4111-8111-111111111111",
          });
        }
        const failedCheckIndex = serverChecks.findIndex(
          (check) => check.errorCode === "HOST_KEY_NOT_TRUSTED",
        );
        if (failedCheckIndex >= 0) serverChecks.splice(failedCheckIndex, 1);
        return writeJson(response, 201, { hostKey: hostKeys[0] });
      });
      return;
    }
    const revokeHostKeyMatch = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/host-keys\/([^/]+)$/,
    );
    if (request.method === "DELETE" && revokeHostKeyMatch) {
      const hostKeys = hostKeysByServer.get(revokeHostKeyMatch[1]!);
      const index = hostKeys?.findIndex(
        (key) => key.id === revokeHostKeyMatch[2],
      );
      if (!hostKeys || index === undefined || index < 0) {
        return writeNotFound(response);
      }
      hostKeys.splice(index, 1);
      response.writeHead(204);
      response.end();
      return;
    }
    const prepareServerMatch = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/actions\/prepare$/,
    );
    const checkServerMatch = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/actions\/check$/,
    );
    if (request.method === "POST" && checkServerMatch) {
      const server = servers.find((item) => item.id === checkServerMatch[1]);
      if (!server) return writeNotFound(response);
      const check: ServerCheck = {
        createdAt: new Date().toISOString(),
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        id: randomUUID(),
        result: null,
        startedAt: null,
        status: "queued",
      };
      const checks = requestedServerChecks.get(server.id) ?? [];
      checks.unshift(check);
      requestedServerChecks.set(server.id, checks);
      setTimeout(() => {
        check.status = "succeeded";
        check.startedAt = check.createdAt;
        check.finishedAt = new Date().toISOString();
        check.result = structuredClone(
          serverChecks.find((item) => item.status === "succeeded")?.result ??
            null,
        );
      }, 1000).unref();
      return writeJson(response, 202, { check });
    }
    if (request.method === "POST" && prepareServerMatch) {
      const server = servers.find((item) => item.id === prepareServerMatch[1]);
      if (!server) return writeNotFound(response);
      if (!(hostKeysByServer.get(server.id)?.length ?? 0)) {
        return writeJson(response, 409, {
          error: {
            message: "Trust an SSH host key before preparing this server",
          },
        });
      }
      const preparation = createPreparationFixture("queued");
      server.preparedAt = null;
      server.setupStatus = "preparing";
      serverPreparationsByServer.set(server.id, [preparation]);
      serverPreparationPolls.set(preparation.id, 0);
      return writeJson(response, 202, { preparation });
    }
    const cleanupMatch = path.match(
      /^\/v1\/core\/servers\/([^/]+)\/actions\/cleanup-orphans$/,
    );
    if (request.method === "POST" && cleanupMatch) {
      const server = servers.find((item) => item.id === cleanupMatch[1]);
      if (!server) return writeNotFound(response);
      const key = `${server.id}:${request.headers["idempotency-key"]}`;
      const existing = cleanupIdempotency.get(key);
      if (existing)
        return writeJson(response, 200, {
          operation: existing,
          replayed: true,
        });
      const operation = createServerCleanupFixture(server.id)[0]!;
      operation.createdAt = new Date().toISOString();
      operation.finishedAt = null;
      operation.startedAt = null;
      operation.result = null;
      operation.state = "queued";
      operation.request.trigger = "manual";
      cleanupIdempotency.set(key, operation);
      serverCleanups.get(server.id)?.unshift(operation);
      setTimeout(() => {
        operation.state = "succeeded";
        operation.startedAt = operation.createdAt;
        operation.finishedAt = new Date().toISOString();
        operation.result = { cleaned: [], skipped: [] };
      }, 1500).unref();
      return writeJson(response, 202, { operation, replayed: false });
    }
    const jobMatch = path.match(
      /^\/v1\/core\/apps\/([^/]+)\/actions\/run-job$/,
    );
    if (request.method === "POST" && jobMatch) {
      const app = apps.find((item) => item.id === jobMatch[1]);
      void readRequestJson(request)
        .then((input) => {
          const body = input as { name?: string };
          const job = app?.config.jobs?.find((item) => item.name === body.name);
          if (!app || !job)
            return writeJson(response, 404, {
              message: "Scheduled job not found",
            });
          const now = new Date().toISOString();
          const operation: ResourceOperation = {
            id: randomUUID(),
            resourceId: app.id,
            sourceId: app.sourceId,
            serverId: app.serverId,
            type: "run_job",
            request: { type: "run_job", job, scheduledAt: null },
            requestedBy: null,
            state: "succeeded",
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            finishedAt: now,
            deletedAt: null,
            cancelRequestedAt: null,
            phase: null,
            errorCode: null,
            errorMessage: null,
            result: {
              jobName: job.name,
              exitCode: 0,
              timedOut: false,
              logs: "Report generated from 12 uploaded files.\n",
              truncated: false,
            },
          };
          runtimeOperations.unshift(operation);
          return writeJson(response, 202, { operation, replayed: false });
        })
        .catch(() =>
          writeJson(response, 400, { message: "Invalid job request" }),
        );
      return;
    }
    const runtimeActionMatch = path.match(
      /^\/v1\/core\/(apps|resources)\/([^/]+)\/actions\/(backup|logs|restart|start|stop)$/,
    );
    const restoreActionMatch = path.match(
      /^\/v1\/core\/resources\/([^/]+)\/actions\/restore$/,
    );
    if (request.method === "POST" && restoreActionMatch) {
      const resource = resources.find(
        (item) => item.id === restoreActionMatch[1],
      );
      if (!resource) return writeNotFound(response);
      void readRequestJson(request)
        .then((input) => {
          const payload = input as {
            backupId?: string;
            confirmation?: string;
            reason?: string;
          };
          const backup = sourceBackups.find(
            (item) =>
              item.id === payload.backupId && item.resourceId === resource.id,
          );
          if (!backup || payload.confirmation !== resource.name) {
            return writeJson(response, 422, {
              error: { message: "Backup or confirmation is invalid" },
            });
          }
          const now = new Date().toISOString();
          const operation: ResourceOperation = {
            cancelRequestedAt: null,
            createdAt: now,
            deletedAt: null,
            errorCode: null,
            errorMessage: null,
            finishedAt: null,
            id: randomUUID(),
            phase: "restoring_candidate",
            request: {
              backupId: backup.id,
              reason: payload.reason ?? "Fixture restore request",
              type: "restore",
            },
            requestedBy: user.id,
            resourceId: resource.id,
            result: null,
            serverId: resource.serverId,
            sourceId: resource.sourceId,
            startedAt: now,
            state: "running",
            type: "restore",
            updatedAt: now,
          };
          runtimeOperations.unshift(operation);
          operationEventsByOperation.set(operation.id, [
            {
              command: "docker inspect <active-runtime>",
              createdAt: now,
              id: randomUUID(),
              level: "success",
              message: "Backup, server, and active runtime passed preflight",
              metadata: {},
              phase: "preflight",
              sequence: 1,
            },
            {
              command: null,
              createdAt: now,
              id: randomUUID(),
              level: "info",
              message: "Restoring into an isolated candidate volume",
              metadata: {},
              phase: "restoring_candidate",
              sequence: 2,
            },
          ]);
          setTimeout(() => {
            if (operation.state !== "running") return;
            operation.state = "succeeded";
            operation.phase = "completed";
            operation.finishedAt = operation.updatedAt =
              new Date().toISOString();
            operation.result = {
              restoreId: operation.id,
              backupId: backup.id,
              state: "running",
            };
            operationEventsByOperation.get(operation.id)!.push({
              id: randomUUID(),
              createdAt: operation.finishedAt,
              command: null,
              level: "success",
              message: "Sample backup restored and health checks passed",
              metadata: {},
              phase: "completed",
              sequence: 3,
            });
          }, 2500).unref();
          return writeJson(response, 202, { operation });
        })
        .catch(() =>
          writeJson(response, 400, {
            error: { message: "Request body must be valid JSON" },
          }),
        );
      return;
    }
    const restoreCleanupMatch = path.match(
      /^\/v1\/core\/resources\/([^/]+)\/actions\/restore-cleanup$/,
    );
    if (request.method === "POST" && restoreCleanupMatch) {
      const resource = resources.find(
        (item) => item.id === restoreCleanupMatch[1],
      );
      if (!resource) return writeNotFound(response);
      const now = new Date().toISOString();
      const operation: ResourceOperation = {
        cancelRequestedAt: null,
        createdAt: now,
        deletedAt: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        id: randomUUID(),
        phase: null,
        request: { type: "restore_cleanup" },
        requestedBy: user.id,
        resourceId: resource.id,
        result: {
          cleanedVolumes: ["towbar-fixture-previous"],
          restoreId: "fixture-restore",
          skippedVolumes: [],
        },
        serverId: resource.serverId,
        sourceId: resource.sourceId,
        startedAt: now,
        state: "succeeded",
        type: "restore_cleanup",
        updatedAt: now,
      };
      runtimeOperations.unshift(operation);
      return writeJson(response, 202, { operation });
    }
    const cancelRestoreMatch = path.match(
      /^\/v1\/core\/resources\/([^/]+)\/operations\/([^/]+)\/actions\/cancel$/,
    );
    if (request.method === "POST" && cancelRestoreMatch) {
      const operation = runtimeOperations.find(
        (item) =>
          item.resourceId === cancelRestoreMatch[1] &&
          item.id === cancelRestoreMatch[2] &&
          item.type === "restore",
      );
      if (!operation) return writeNotFound(response);
      operation.cancelRequestedAt = new Date().toISOString();
      operation.state = "cancelled";
      operation.phase = "cancelled";
      operation.finishedAt = operation.cancelRequestedAt;
      operation.updatedAt = operation.cancelRequestedAt;
      return writeJson(response, 200, { operation });
    }
    if (request.method === "POST" && runtimeActionMatch) {
      const [, kind, deployableId, requestedAction] = runtimeActionMatch;
      const deployable =
        kind === "apps"
          ? apps.find((item) => item.id === deployableId)
          : resources.find((item) => item.id === deployableId);
      if (!deployable) return writeNotFound(response);
      const now = new Date().toISOString();
      const type =
        requestedAction === "backup"
          ? "backup"
          : requestedAction === "logs"
            ? "capture_logs"
            : requestedAction === "restart"
              ? "restart"
              : requestedAction === "start"
                ? "start"
                : requestedAction === "stop"
                  ? "stop"
                  : undefined;
      if (!type) return writeNotFound(response);
      const operation = {
        cancelRequestedAt: null,
        createdAt: now,
        deletedAt: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        id: randomUUID(),
        phase: null,
        request: { type },
        requestedBy: user.id,
        resourceId: deployable.id,
        result:
          type === "backup"
            ? sourceBackups[0]!.result
            : type === "capture_logs"
              ? {
                  logs: "Listening on port 3000\nHealth check passed\n",
                  truncated: false,
                }
              : { state: type === "stop" ? "stopped" : "running" },
        serverId: deployable.serverId,
        sourceId: deployable.sourceId,
        startedAt: now,
        state: "succeeded",
        type,
        updatedAt: now,
      } satisfies ResourceOperation;
      if (type === "start" || type === "stop" || type === "restart") {
        deployable.runtimeState.desiredState =
          type === "stop" ? "stopped" : "running";
        deployable.runtimeState.observedState =
          type === "stop" ? "stopped" : "running";
        deployable.runtimeState.healthStatus =
          type === "stop" ? "unknown" : "healthy";
        deployable.runtimeState.checkedAt = now;
      }
      if (type === "backup" && kind === "resources") {
        const backup = createBackupFixture(
          operation.id,
          deployable as FixtureResource,
          now,
          96_512_336,
        );
        sourceBackups.unshift(backup);
        operation.result = backup.result;
      }
      runtimeOperations.unshift(operation);
      return writeJson(response, 202, { operation });
    }
    const previewDeployMatch = path.match(
      /^\/v1\/core\/previews\/([^/]+)\/actions\/deploy$/,
    );
    if (request.method === "POST" && previewDeployMatch) {
      const preview = previews.find(
        (item) => item.id === previewDeployMatch[1],
      );
      if (!preview) return writeNotFound(response);
      const deployment = {
        ...structuredClone(previewDeployment),
        id: randomUUID(),
        appId: preview.appId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        state: "succeeded" as const,
      };
      deployments.unshift(deployment);
      preview.status = "healthy";
      return writeJson(response, 202, {
        accepted: true,
        deploymentId: deployment.id,
      });
    }
    const deployActionMatch = path.match(
      /^\/v1\/core\/(apps|resources)\/([^/]+)\/actions\/deploy$/,
    );
    if (request.method === "POST" && deployActionMatch) {
      const deployable =
        deployActionMatch[1] === "apps"
          ? apps.find((item) => item.id === deployActionMatch[2])
          : resources.find((item) => item.id === deployActionMatch[2]);
      if (!deployable) return writeNotFound(response);
      if (!deployable.serverReady)
        return writeJson(response, 409, {
          error: {
            code: "SERVER_NOT_READY",
            message: "Prepare the server before deploying",
          },
        });
      const server = servers.find((item) => item.id === deployable.serverId);
      if (!server) return writeNotFound(response);
      const deployment = createDeploymentFixture(
        randomUUID(),
        deployable,
        server,
        "queued",
        new Date().toISOString(),
      );
      deployments.unshift(deployment);
      {
        simulatedDeployments.add(deployment);
        deployment.startedAt = deployment.createdAt;
        for (const [index, state] of (
          ["building", "starting_candidate", "succeeded"] as const
        ).entries()) {
          setTimeout(
            () => {
              if (terminalStates.has(deployment.state)) return;
              deployment.state = state;
              deployment.updatedAt = new Date().toISOString();
              deployment.startedAt ??= deployment.updatedAt;
              if (state === "succeeded")
                deployment.finishedAt = deployment.updatedAt;
            },
            (index + 1) * 2_000,
          ).unref();
        }
      }
      return writeJson(response, 202, { deployment });
    }
    const deploymentAction = path.match(
      /^\/v1\/core\/deployments\/([^/]+)\/actions\/(cancel|retry)$/,
    );
    if (request.method === "POST" && deploymentAction) {
      const previous = deployments.find(
        (item) => item.id === deploymentAction[1],
      );
      if (!previous) return writeNotFound(response);
      if (deploymentAction[2] === "cancel") {
        previous.state = "cancelled";
        previous.finishedAt = previous.updatedAt = new Date().toISOString();
        return writeJson(response, 202, {
          accepted: true,
          deployment: previous,
        });
      }
      const deployment = {
        ...structuredClone(previous),
        id: randomUUID(),
        state: "succeeded" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorCode: null,
        errorMessage: null,
      };
      deployments.unshift(deployment);
      return writeJson(response, 202, { deployment });
    }
    const vulnerabilityRescanMatch = path.match(
      /^\/v1\/core\/deployments\/([^/]+)\/vulnerability-scan\/actions\/rescan$/,
    );
    if (request.method === "POST" && vulnerabilityRescanMatch) {
      const deployment = deployments.find(
        (item) => item.id === vulnerabilityRescanMatch[1],
      );
      if (!deployment?.vulnerabilityScan) return writeNotFound(response);
      deployment.vulnerabilityScan = {
        ...deployment.vulnerabilityScan,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        requestedAt: new Date().toISOString(),
        startedAt: null,
        state: "pending",
      };
      setTimeout(() => {
        if (!deployment.vulnerabilityScan) return;
        deployment.vulnerabilityScan.state = "findings";
        deployment.vulnerabilityScan.completedAt = new Date().toISOString();
      }, 1500).unref();
      return writeJson(response, 202, {
        replayed: false,
        scan: deployment.vulnerabilityScan,
      });
    }
    const eventMatch = path.match(/^\/v1\/core\/deployments\/([^/]+)\/events$/);
    if (eventMatch) {
      const deployment = deployments.find((item) => item.id === eventMatch[1]);
      if (!deployment) return writeNotFound(response);
      return writeDeploymentEvents(response, deployment, publicDemo);
    }

    if (
      request.method !== "GET" &&
      /^\/v1\/core\/sources\/[^/]+\/environments(?:\/|$)/.test(path)
    ) {
      if (
        !connections.sources.some((source) => source.id === path.split("/")[4])
      )
        return writeNotFound(response);
      void (
        path.endsWith("/syncs") ? Promise.resolve({}) : readRequestJson(request)
      )
        .then((body) => {
          const result = connections.mutateEnvironment(
            request.method!,
            path,
            body,
          );
          if (!result) return writeNotFound(response);
          writeJson(response, result.status, result.body);
        })
        .catch((error) =>
          writeJson(
            response,
            error instanceof FixtureEnvironmentError ? error.status : 400,
            {
              error: {
                code: "INVALID_ENVIRONMENT_REQUEST",
                message:
                  error instanceof Error
                    ? error.message
                    : "Invalid environment request",
              },
            },
          ),
        );
      return;
    }

    if (request.method !== "GET") return writeNotFound(response);
    const payload =
      connections.read(path) ??
      getFixturePayload(
        path,
        requestUrl.searchParams,
        notificationProviderState,
      );
    if (payload === undefined) return writeNotFound(response);
    writeJson(response, 200, payload);
  });
  terminal.attach(fixtureServer);
  return fixtureServer;
}

function publicNotificationRoute(destination: NotificationDestination) {
  return {
    categories: destination.categories,
    enabled: destination.enabled,
    id: destination.id,
    provider: destination.provider,
    source: "environment" as const,
  };
}

function getFixturePayload(
  path: string,
  searchParams: URLSearchParams,
  notificationProviderState: {
    discord: boolean;
    slack: boolean;
    smtp: boolean;
    telegram: boolean;
    webhook: boolean;
  },
): unknown {
  const faviconMatch = path.match(
    /^\/v1\/core\/(apps|deployments)\/([^/]+)\/favicon$/,
  );
  if (faviconMatch) {
    const entity =
      faviconMatch[1] === "apps"
        ? apps.find((app) => app.id === faviconMatch[2])
        : deployments.find((deployment) => deployment.id === faviconMatch[2]);
    if (!entity) return undefined;
    const available =
      entity.id === fixtureIds.faviconApp ||
      entity.id === fixtureIds.previewDeployment;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#128366"/><path d="M8 9h16v4h-6v12h-4V13H8z" fill="white"/></svg>';
    return {
      icon: available
        ? `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
        : null,
      expiresAt: Date.now() + 30_000,
    };
  }
  const environmentSource = path.match(
    /^\/v1\/core\/sources\/([^/]+)\/environments$/,
  );
  if (
    environmentSource &&
    sources.some((item) => item.id === environmentSource[1])
  )
    return {
      environments: environmentMappings.filter(
        (item) => item.sourceId === environmentSource[1],
      ),
    };
  const manifestMatch = path.match(
    /^\/v1\/core\/sources\/([^/]+)\/environments\/([^/]+)\/manifest$/,
  );
  if (manifestMatch) {
    const mapping = environmentMappings.find(
      (item) =>
        item.sourceId === manifestMatch[1] && item.id === manifestMatch[2],
    );
    if (!mapping) return undefined;
    const mappings = environmentMappings.filter(
      (item) => item.sourceId === mapping.sourceId,
    );
    const files = [...apps, ...resources]
      .filter((item) => item.sourceId === mapping.sourceId)
      .filter(
        (item, index, all) =>
          all.findIndex((other) => other.entityId === item.entityId) === index,
      )
      .map((item) => {
        const isApp = item.kind === "app";
        const isCompose = item.kind === "compose";
        const members = [...apps, ...resources].filter(
          (other) => other.entityId === item.entityId,
        );
        const content = [
          `id: ${item.manifestId}`,
          `name: ${JSON.stringify(item.name)}`,
          ...(isCompose
            ? [
                "file: deploy/compose.yml",
                "overrides:",
                "  - deploy/compose.production.yml",
                "profiles:",
                "  - production",
                "services:",
                "  web:",
                "    domains:",
                "      - storefront.example.com",
                "    port: 3000",
              ]
            : isApp
              ? [
                  ...(item.config.deployment
                    ? [`deployment: ${JSON.stringify(item.config.deployment)}`]
                    : [
                        `dockerfile: ${JSON.stringify((item.config as NormalizedApp).dockerfile)}`,
                        `context: ${JSON.stringify(item.config.context)}`,
                      ]),
                  `container: ${JSON.stringify(item.config.container)}`,
                  ...[
                    "domains",
                    "health",
                    "jobs",
                    "preview",
                    "externalSecrets",
                    "notifications",
                    "tls",
                    "rollout",
                    "buildServer",
                  ].flatMap((key) => {
                    const value = (
                      item.config as unknown as Record<string, unknown>
                    )[key];
                    return value === undefined
                      ? []
                      : [`${key}: ${JSON.stringify(value)}`];
                  }),
                  ...(Object.keys(item.config.hooks).length
                    ? [`hooks: ${JSON.stringify(item.config.hooks)}`]
                    : []),
                ]
              : [
                  `type: ${item.kind}`,
                  `backup: ${JSON.stringify((item as FixtureResource).config.backup)}`,
                ]),
          "environments:",
          ...members.flatMap((member) => [
            `  ${member.environment!.name}:`,
            `    server: ${member.serverIp}`,
          ]),
          "",
        ].join("\n");
        const directory = isApp || isCompose ? "services" : "datastores";
        const suffix = isCompose ? "compose" : isApp ? "service" : "datastore";
        return {
          path: `.towbar/${directory}/${item.manifestId}.${suffix}.yml`,
          content,
        };
      });
    return {
      manifest: {
        commitSha,
        files: [
          {
            path: "towbar.yml",
            content: `version: 2\nenvironments:\n${mappings.map((item) => (item.previewsEnabled ? `  ${item.name}:\n    previews:\n      enabled: true` : `  ${item.name}: {}`)).join("\n")}\n`,
          },
          ...files,
        ],
      },
    };
  }
  if (path === "/v1/core/deployments/history") {
    const page = readPositiveInteger(searchParams.get("page"), 1);
    const limit = Math.min(
      100,
      readPositiveInteger(searchParams.get("limit"), 10),
    );
    const deployables = new Map(
      [...apps, ...resources].map((item) => [item.id, item]),
    );
    const ordered = deployments
      .filter((item) => {
        const type = searchParams.get("type");
        return (
          (!searchParams.get("targetEnvironment") ||
            item.targetEnvironment.name ===
              searchParams.get("targetEnvironment")) &&
          (!type ||
            (type === "app"
              ? item.deployableKind === "app"
              : item.deployableKind !== "app")) &&
          ["environment", "state", "trigger", "serverId"].every(
            (key) =>
              !searchParams.get(key) ||
              item[key as "environment" | "state" | "trigger" | "serverId"] ===
                searchParams.get(key),
          )
        );
      })
      .sort((left, right) => {
        const sort = searchParams.get("sort");
        if (sort === "name_asc" || sort === "name_desc") {
          const names = (deployables.get(left.appId)?.name ?? "").localeCompare(
            deployables.get(right.appId)?.name ?? "",
          );
          if (names) return sort === "name_asc" ? names : -names;
        }
        const newest =
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id);
        return sort === "oldest" ? -newest : newest;
      });
    return {
      environments: [
        ...new Set(environmentMappings.map((item) => item.name)),
      ].sort(),
      deployments: ordered
        .slice((page - 1) * limit, page * limit)
        .map((item) => {
          const deployable = deployables.get(item.appId);
          return {
            ...item,
            deployableDomain: deployable?.config.domains?.primary ?? null,
            deployableImage:
              deployable && "image" in deployable.config
                ? deployable.config.image
                : null,
            deployableName: deployable?.name ?? "Unknown workload",
          };
        }),
      pagination: {
        page,
        limit,
        total: ordered.length,
        totalPages: Math.ceil(ordered.length / limit),
      },
    };
  }
  const extraSourceMatch = path.match(
    /^\/v1\/core\/sources\/([^/]+)(?:\/(.*))?$/,
  );
  const extraSource = sources.find(
    (item) => item.id !== source.id && item.id === extraSourceMatch?.[1],
  );
  if (extraSource) {
    const sourceApps = apps.filter((item) => item.sourceId === extraSource.id);
    const sourceResources = resources.filter(
      (item) => item.sourceId === extraSource.id,
    );
    const child = extraSourceMatch?.[2];
    if (!child) return { canManageSource: true, source: extraSource };
    if (child === "apps") return { apps: sourceApps };
    if (child === "resources") return { resources: sourceResources };
    if (child === "syncs") return { syncs: [] };
    if (child === "deployments")
      return {
        deployments: deployments.filter(
          (item) => item.sourceId === extraSource.id,
        ),
      };
    if (child === "previews") return { previews: [] };
    if (child === "backups")
      return {
        backups: sourceBackups.filter(
          (item) => item.sourceId === extraSource.id,
        ),
      };
    if (child === "capacity")
      return {
        capacities: runtimeCapacity.filter((capacity) =>
          [...sourceApps, ...sourceResources].some(
            (item) => item.serverIp === capacity.ip,
          ),
        ),
      };
    if (child === "notifications/destinations")
      return {
        canManageNotifications: false,
        destinations: notificationDestinations.map(publicNotificationRoute),
        providers: notificationProviderState,
      };
  }
  const fixedPayloads = new Map<string, unknown>([
    [
      "/v1/core/notifications/providers",
      {
        configurations: {
          slack: notificationProviderState.slack
            ? { source: "environment" }
            : null,
          smtp: notificationProviderState.smtp
            ? { source: "environment" }
            : null,
          telegram: notificationProviderState.telegram
            ? { source: "environment" }
            : null,
        },
        providers: notificationProviderState,
      },
    ],
    ["/v1/core/session", { user }],
    [
      "/v1/public/auth/state",
      {
        user,
        account: {
          email: user.email,
          name: user.name,
          emailVerified: user.emailVerified,
        },
      },
    ],
    ["/v1/public/auth/setup-status", { setupRequired: false }],
    ["/v1/core/profile", { user }],
    [
      "/v1/core/sessions",
      { currentSessionId: userSessions[0]!.id, sessions: userSessions },
    ],
    [
      "/v1/core/github",
      {
        canManage: true,
        configuration: {
          appId: "123456",
          appSlug: "towbar-fixture",
          source: "environment",
        },
        connections: [githubConnection],
        connection: githubConnection,
        previewReporting,
      },
    ],
    [
      "/v1/core/github/repositories",
      {
        repositories: githubRepositories.map((repository) => ({
          ...repository,
          connectionId: githubConnection.id,
        })),
        unavailableConnections: [],
        identityWarnings: [],
      },
    ],
    ["/v1/core/sources", { sources }],
    ["/v1/core/apps", { apps }],
    ["/v1/core/resources", { resources }],
    ["/v1/core/servers", { servers }],
    ["/v1/core/system-health", fixtureSystemHealth()],
    ["/v1/core/version", towbarUpdates],
    [
      "/v1/core/deployments",
      {
        deployments: deployments.filter(
          (deployment) => deployment.environment === "production",
        ),
      },
    ],
    [`/v1/core/sources/${source.id}`, { canManageSource: true, source }],
    [`/v1/core/sources/${source.id}/syncs`, { syncs: sourceSyncs }],
    [
      `/v1/core/sources/${source.id}/apps`,
      { apps: apps.filter((item) => item.sourceId === source.id) },
    ],
    [`/v1/core/sources/${source.id}/capacity`, { capacities: runtimeCapacity }],
    [`/v1/core/sources/${source.id}/previews`, { previews }],
    [
      `/v1/core/sources/${source.id}/resources`,
      { resources: resources.filter((item) => item.sourceId === source.id) },
    ],
    [
      `/v1/core/sources/${source.id}/deployments`,
      {
        deployments: deployments.filter(
          (deployment) => deployment.environment === "production",
        ),
      },
    ],
    [
      `/v1/core/sources/${source.id}/backups`,
      { backups: sourceBackups.filter((item) => item.sourceId === source.id) },
    ],
    [
      `/v1/core/sources/${source.id}/notifications/destinations`,
      {
        canManageNotifications: false,
        destinations: notificationDestinations.map(publicNotificationRoute),
        providers: notificationProviderState,
      },
    ],
    [
      "/v1/core/notifications/destinations",
      {
        canManageNotifications: false,
        destinations: notificationDestinations.map(publicNotificationRoute),
        providers: notificationProviderState,
      },
    ],
    ...sourceSyncs.map(
      (sync) =>
        [`/v1/core/sources/${source.id}/syncs/${sync.id}`, { sync }] as const,
    ),
  ]);
  const fixed = fixedPayloads.get(path);
  if (fixed !== undefined) return fixed;

  const sourceRevisionMatch = path.match(
    /^\/v1\/core\/deployments\/([^/]+)\/source-revision$/,
  );
  if (sourceRevisionMatch) {
    const deployment = deployments.find(
      (item) => item.id === sourceRevisionMatch[1],
    );
    if (!deployment) return undefined;
    const pullRequest: DeploymentPullRequest | null =
      deployment.id === fixtureIds.deployment
        ? {
            author: "octocat",
            baseBranch: "main",
            changedFileCount: 12,
            draft: false,
            headBranch: "environment-aware-deployments",
            merged: true,
            number: 128,
            state: "closed",
            title: "Add environment-aware deployments",
            url: "https://github.com/example-inc/platform/pull/128",
          }
        : null;
    return { pullRequest };
  }

  const deploymentMatch = path.match(
    /^\/v1\/core\/deployments\/([^/]+)(?:\/(steps|logs))?$/,
  );
  const vulnerabilityFindingsMatch = path.match(
    /^\/v1\/core\/deployments\/([^/]+)\/vulnerability-scan\/findings$/,
  );
  if (vulnerabilityFindingsMatch) {
    const deployment = deployments.find(
      (item) => item.id === vulnerabilityFindingsMatch[1],
    );
    if (!deployment?.vulnerabilityScan) return undefined;
    return {
      findings:
        vulnerabilityFindingsByDeployment.get(deployment.id) ??
        vulnerabilityFindings,
    };
  }
  if (path === "/v1/core/monitoring/vulnerabilities") {
    return getSecurityScansFixture(searchParams);
  }
  if (deploymentMatch) {
    const deployment = deployments.find(
      (item) => item.id === deploymentMatch[1],
    );
    if (!deployment) return undefined;
    if (deploymentMatch[2] === "steps") {
      return { steps: getDeploymentSteps(deployment) };
    }
    if (deploymentMatch[2] === "logs") {
      return { logs: getDeploymentLogs(deployment) };
    }
    return { deployment };
  }

  if (path === "/v1/core/settings/secrets") {
    return getFixtureGlobalSecrets("production");
  }

  const deployableSecretReadinessMatch = path.match(
    /^\/v1\/core\/(apps|resources)\/([^/]+)\/secrets\/readiness$/,
  );
  if (deployableSecretReadinessMatch) {
    const deployable =
      deployableSecretReadinessMatch[1] === "apps"
        ? apps.find((item) => item.id === deployableSecretReadinessMatch[2])
        : resources.find(
            (item) => item.id === deployableSecretReadinessMatch[2],
          );
    return deployable
      ? { ready: deployable.id !== resources[1]!.id }
      : undefined;
  }

  const deployableSecretsMatch = path.match(
    /^\/v1\/core\/(apps|resources)\/([^/]+)\/secrets$/,
  );
  if (deployableSecretsMatch) {
    const deployable =
      deployableSecretsMatch[1] === "apps"
        ? apps.find((item) => item.id === deployableSecretsMatch[2])
        : resources.find((item) => item.id === deployableSecretsMatch[2]);
    return deployable
      ? getFixtureDeployableSecrets(
          deployable,
          searchParams.get("environment") ??
            deployable.environment?.name ??
            "production",
        )
      : undefined;
  }

  const backupAssuranceMatch = path.match(
    /^\/v1\/core\/resources\/([^/]+)\/backup-assurance$/,
  );
  if (backupAssuranceMatch) {
    const resourceId = backupAssuranceMatch[1]!;
    const assurances = backupAssurances.filter(
      (assurance) => assurance.resourceId === resourceId,
    );
    return {
      assurance: assurances[0] ?? null,
      assurances,
      awsConfigured: true,
      canRestore: true,
      gcpConfigured: true,
    };
  }

  const operationEventsMatch = path.match(
    /^\/v1\/core\/(apps|resources)\/([^/]+)\/operations\/([^/]+)\/events$/,
  );
  if (operationEventsMatch) {
    return {
      events: operationEventsByOperation.get(operationEventsMatch[3]!) ?? [],
    };
  }

  const deployableMatch = path.match(
    /^\/v1\/core\/(apps|resources)\/([^/]+)(?:\/(deployments|releases|operations|previews|storage|jobs))?$/,
  );
  if (deployableMatch) {
    const [kind, id, child] = deployableMatch.slice(1);
    const deployable =
      kind === "apps"
        ? apps.find((item) => item.id === id)
        : resources.find((item) => item.id === id);
    if (!deployable) return undefined;
    if (child === "jobs" && kind === "apps") {
      const app = deployable as FixtureApp;
      return {
        jobs: app.config.jobs ?? [],
        automationPaused: false,
        ready: app.serverReady,
        runs: runtimeOperations.filter(
          (operation) =>
            operation.resourceId === id && operation.type === "run_job",
        ),
      };
    }
    if (child === "storage" && kind === "apps") {
      const app = deployable as FixtureApp;
      return {
        checkedAt: new Date().toISOString(),
        serverId: app.serverId,
        serverIp: app.serverIp,
        volumes: (app.config.container.volumes ?? []).map((volume) => ({
          ...volume,
          volumeName: `towbar-${app.id}-${volume.name}`,
          status: "mounted",
        })),
      };
    }
    if (child === "deployments") {
      return {
        deployments: deployments.filter(
          (item) => item.appId === id && item.environment === "production",
        ),
      };
    }
    if (child === "previews") {
      return { previews: previews.filter((item) => item.appId === id) };
    }
    if (child === "releases") {
      return { releases: releases.filter((item) => item.appId === id) };
    }
    if (child === "operations") {
      return {
        operations: runtimeOperations.filter(
          (operation) => operation.resourceId === id,
        ),
      };
    }
    return kind === "apps" ? { app: deployable } : { resource: deployable };
  }

  const serverMatch = path.match(
    /^\/v1\/core\/servers\/([^/]+)(?:\/(apps|resources|deployments|capacity|checks|host-keys|orphans|cleanup|preparations))?$/,
  );
  if (serverMatch) {
    const server = servers.find((item) => item.id === serverMatch[1]);
    if (!server) return undefined;
    const child = serverMatch[2];
    if (child === "apps") {
      return {
        apps: apps.filter((item) => item.serverIp === server.canonicalIp),
      };
    }
    if (child === "resources") {
      return {
        resources: resources.filter(
          (item) => item.serverIp === server.canonicalIp,
        ),
      };
    }
    if (child === "deployments") {
      return {
        deployments: deployments.filter((item) => item.serverId === server.id),
      };
    }
    if (child === "capacity") {
      return {
        capacity: runtimeCapacity.find((item) => item.id === server.id),
      };
    }
    if (child === "checks") {
      const page = readPositiveInteger(searchParams.get("page"), 1);
      const limit = Math.min(
        100,
        readPositiveInteger(searchParams.get("limit"), 10),
      );
      const checks = [
        ...(requestedServerChecks.get(server.id) ?? []),
        ...serverChecks,
      ];
      const total = checks.length;
      const offset = (page - 1) * limit;
      return {
        checks: checks.slice(offset, offset + limit),
        latestCheck: checks[0] ?? null,
        pagination: {
          limit,
          page,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    }
    if (child === "preparations") {
      const preparations = serverPreparationsByServer.get(server.id) ?? [];
      const latest = preparations[0];
      if (
        latest &&
        (latest.status === "queued" || latest.status === "running")
      ) {
        const polls = serverPreparationPolls.get(latest.id) ?? 0;
        serverPreparationPolls.set(latest.id, polls + 1);
        if (polls > 0) advancePreparationFixture(latest, server);
        if (latest.finishedAt) {
          server.preparedAt = latest.finishedAt;
          server.setupStatus = "ready";
          for (const deployable of [...apps, ...resources]) {
            if (deployable.serverId === server.id)
              deployable.serverReady = true;
          }
        }
      }
      return {
        preparations,
      };
    }
    if (child === "host-keys") {
      return { hostKeys: hostKeysByServer.get(server.id) ?? [] };
    }
    if (child === "orphans") return { orphans: orphanItems };
    if (child === "cleanup") {
      const history = serverCleanups.get(server.id) ?? [];
      const page = Math.max(1, Number(searchParams.get("page") ?? 1));
      const limit = Math.min(
        100,
        Math.max(1, Number(searchParams.get("limit") ?? 10)),
      );
      return {
        inProgress: history.some((attempt) =>
          ["queued", "running"].includes(attempt.state),
        ),
        operations: history.slice((page - 1) * limit, page * limit),
        pagination: {
          page,
          limit,
          total: history.length,
          totalPages: Math.ceil(history.length / limit),
        },
      };
    }
    return {
      canCleanupOrphans: true,
      canManageServer: true,
      canRemoveServer: true,
      server,
    };
  }

  return undefined;
}

const extraSourceAutoDeployControls = new Map<
  string,
  AutoDeployControlResponse["autoDeploy"]
>();
function getFixtureSourceAutoDeployControl(id: string) {
  let control = extraSourceAutoDeployControls.get(id);
  if (!control) {
    control = createAutoDeployControlFixture("source");
    extraSourceAutoDeployControls.set(id, control);
  }
  return control;
}

function createAutoDeployControlFixture(
  targetType: "app" | "resource" | "source",
): AutoDeployControlResponse["autoDeploy"] {
  return {
    ...(targetType === "source" ? {} : { manifestAutoDeployEnabled: true }),
    effective: {
      paused: false,
      pending: null,
      scope: null,
    },
    paused: false,
  };
}

function getFixtureDeployableAutoDeployControl(kind: string, id: string) {
  const deployable =
    kind === "apps"
      ? apps.find((item) => item.id === id)
      : resources.find((item) => item.id === id);
  if (!deployable) return undefined;
  let control = deployableAutoDeployControls.get(id);
  if (!control) {
    control = createAutoDeployControlFixture(
      kind === "apps" ? "app" : "resource",
    );
    refreshFixtureAutoDeployEffectiveState(control, "deployable");
    deployableAutoDeployControls.set(id, control);
  }
  return control;
}

function applyFixtureAutoDeployControlPatch(
  target: AutoDeployControlResponse["autoDeploy"],
  patch: Record<string, unknown>,
  targetType: "deployable" | "source",
) {
  if (typeof patch.paused === "boolean") {
    target.paused = patch.paused;
  }
  refreshFixtureAutoDeployEffectiveState(target, targetType);
  if (targetType === "source") {
    for (const deployable of deployableAutoDeployControls.values()) {
      refreshFixtureAutoDeployEffectiveState(deployable, "deployable");
    }
  }
}

function refreshFixtureAutoDeployEffectiveState(
  target: AutoDeployControlResponse["autoDeploy"],
  targetType: "deployable" | "source",
) {
  if (targetType === "deployable" && sourceAutoDeployControl.paused) {
    target.effective = {
      paused: true,
      pending: target.effective.pending,
      scope: "source",
    };
    return;
  }
  if (target.paused) {
    target.effective = {
      paused: true,
      pending: target.effective.pending,
      scope: targetType === "source" ? "source" : "deployable",
    };
    return;
  }
  target.effective = {
    paused: false,
    pending: null,
    scope: null,
  };
}

function readPositiveInteger(value: string | null, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fixtureMetadata(key: string) {
  return {
    keys: fixtureSecretKeys.get(key) ?? [],
    revision: fixtureSecretVersions.get(key) ?? null,
    updatedAt: fixtureNow,
  };
}
function getFixtureDeployableSecrets(
  deployable: FixtureApp | FixtureResource,
  environment: string = "production",
): AppSecretsResponse {
  return getFixtureSecretsResponse(
    deployable.id,
    environment,
    deployable.kind !== "app",
    "deployable",
    deployable.environment?.name ?? "production",
  );
}
function getFixtureGlobalSecrets(environment: string): AppSecretsResponse {
  return getFixtureSecretsResponse(
    user.workspaceId,
    environment,
    false,
    "global",
  );
}
function getFixtureSecretsResponse(
  id: string,
  environment: string,
  resource: boolean,
  scope: "global" | "deployable" = "deployable",
  baseEnvironment = "production",
): AppSecretsResponse {
  const stages = resource
    ? ["deployment" as const]
    : (["build", "deployment", "pre_deploy", "post_deploy"] as const);
  return {
    environments:
      resource || scope === "global"
        ? [baseEnvironment]
        : [baseEnvironment, "preview"],
    canManageSecrets: true,
    bindings: stages.map((stage) => {
      const local = fixtureMetadata(`${id}:${environment}:${stage}`);
      const global =
        scope !== "global"
          ? fixtureMetadata(`${user.workspaceId}:production:${stage}`)
          : { keys: [], revision: null };
      return {
        ...local,
        environment,
        stage,
        inheritedKeys: [],
        inheritedOrigins: {},
        availableReferences: { globals: global.keys },
        inheritedRevisions: {
          global: global.revision,
        },
        pendingChanges: scope === "deployable" && Boolean(local.revision),
        affectedDeployables:
          environment === "preview"
            ? previews
                .filter(
                  (preview) =>
                    preview.appId === id &&
                    ["healthy", "failed", "building"].includes(preview.status),
                )
                .map((preview) => ({
                  id: preview.id,
                  name: `PR #${preview.pullRequestNumber}`,
                  kind: "preview" as const,
                }))
            : [],
      };
    }),
  };
}

function applyFixtureSecretMutation(
  reference: string,
  payload: { delete?: string[]; set?: Record<string, string> },
) {
  const keys = new Set(fixtureSecretKeys.get(reference) ?? []);
  const values = { ...(fixtureSecretValues.get(reference) ?? {}) };
  for (const key of payload.delete ?? []) {
    keys.delete(key);
    delete values[key];
  }
  for (const [key, value] of Object.entries(payload.set ?? {})) {
    keys.add(key);
    values[key] = value;
  }
  fixtureSecretKeys.set(reference, [...keys].sort());
  fixtureSecretValues.set(reference, values);
  fixtureSecretVersions.set(reference, crypto.randomUUID());
}

async function readRequestJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function readOptionalRequestJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString("utf8");
  return value ? (JSON.parse(value) as Record<string, unknown>) : {};
}

function createServerFixture(
  id: string,
  canonicalIp: string,
  username: string,
  ready: boolean,
): Server {
  return {
    archivedAt: null,
    canonicalIp,
    name: null,
    hardware:
      id === fixtureIds.server
        ? {
            instance: { provider: "oracle", type: "VM.Standard.A1.Flex" },
            cpuCount: 4,
            memoryBytes: 17_179_869_184,
          }
        : id === fixtureIds.secondaryServer
          ? {
              instance: { provider: "hetzner", type: null },
              cpuCount: 8,
              memoryBytes: 34_359_738_368,
            }
          : null,
    config: {
      buildConcurrency: 2,
      previewBuildConcurrency: 1,
      ip: canonicalIp,
      ssh: { port: 22, username },
    },
    createdAt: fixtureNow,
    id,
    preparedAt: ready ? fixtureNow : null,
    setupStatus: ready ? "ready" : "pending",
    updatedAt: fixtureNow,
  };
}

function emptyRuntimeCapacity(server: Server): RuntimeCapacity {
  return {
    checkedAt: null,
    cpu: null,
    disk: null,
    id: server.id,
    ip: server.canonicalIp,
    latestCheckStatus: null,
    memory: null,
    runtimes: [],
    status: "unknown",
    uptimeSeconds: null,
  };
}

function createRuntimeState(
  healthStatus: App["runtimeState"]["healthStatus"],
): App["runtimeState"] {
  const unhealthy = healthStatus === "unhealthy";
  return {
    checkedAt: fixtureNow,
    desiredState: "running",
    driftReasons: unhealthy ? ["Health check is failing"] : [],
    driftStatus: unhealthy ? "drifted" : "in_sync",
    healthStatus,
    ingressContainerName: null,
    ingressImage: null,
    ingressRestartCount: null,
    ingressStatus: "disabled",
    observedContainerName: "fixture",
    observedImage: "fixture:latest",
    observedState: "running",
  };
}

function createAppFixture(
  id: string,
  name: string,
  manifestId: string,
  server: Server,
  healthStatus: App["runtimeState"]["healthStatus"] = "healthy",
): FixtureApp & { config: NormalizedApp } {
  return {
    entityId: null,
    environment: null,
    archivedAt: null,
    config: {
      kind: "app",
      autoDeploy: true,
      vulnerabilityScanning: true,
      container: {
        network: "towbar-fixture",
        port: 3000,
        resources: { cpus: 1, memory: "1g" },
      },
      description: `${name} fixture`,
      context: ".",
      deploymentInputs: [],
      dockerfile: `apps/${manifestId}/Dockerfile`,
      health: { path: "/health", timeoutSeconds: 30 },
      hooks: {},
      id: manifestId,
      name,

      ...(id === fixtureIds.app
        ? {
            preview: {
              domain: "preview.example.com",
              enabled: true as const,

              ttlHours: 72,
            },
          }
        : {}),
      server: server.canonicalIp,
      sourceBranch: "main",
    },
    description: `${name} fixture`,
    id,
    kind: "app",
    manifestId,
    name,
    runtimeState: createRuntimeState(healthStatus),
    serverReady: server.setupStatus === "ready",
    serverId: server.id,
    serverIp: server.canonicalIp,
    sourceId: source.id,
    sourceRevision: commitSha,
    updatedAt: fixtureNow,
  };
}

function createResourceFixture(
  id: string,
  name: string,
  manifestId: string,
  kind: Resource["kind"],
  server: Server,
): FixtureResource {
  return {
    entityId: null,
    environment: null,
    archivedAt: null,
    config: {
      access:
        kind === "postgres"
          ? {
              sshTunnel: {
                hostPort:
                  id === fixtureIds.resource
                    ? 15_432
                    : id === fixtureIds.secondaryPostgres
                      ? 15_433
                      : 15_434,
              },
            }
          : undefined,
      autoDeploy: true,
      backup: {
        gcs: {
          bucket: "towbar-fixture-gcs-backups",
          prefix: manifestId,
          region: "asia-south1",
        },
        restoreFrom: "s3" as const,
        retention: { keepLast: 7 },
        s3: {
          bucket: "towbar-fixture-backups",
          encryption: "AES256",
          prefix: manifestId,
          region: "ap-south-1",
        },
        schedule: { cron: "0 2 * * *", timezone: "UTC" },
      },
      container: {
        command: [],
        network: "towbar-fixture",
        networkAlias: manifestId,
        port: managedResourceCompatibility[kind].port,
        resources: { cpus: 1, memory: "1g" },
        volumes: [
          {
            mountPath: managedResourceCompatibility[kind].volumePath,
            name: `${manifestId}-data`,
          },
        ],
      },
      description: `${name} fixture`,
      health: { timeoutSeconds: 30, type: "container" },
      id: manifestId,
      image: managedResourceCompatibility[kind].image,
      kind,
      name,

      server: server.canonicalIp,
      sourceBranch: "main",
    },
    description: `${name} fixture`,
    id,
    kind,
    manifestId,
    name,
    runtimeState: createRuntimeState("healthy"),
    serverReady: server.setupStatus === "ready",
    serverId: server.id,
    serverIp: server.canonicalIp,
    serverSsh: {
      port: server.config.ssh.port,
      username: server.config.ssh.username,
    },
    sourceId: source.id,
    sourceRevision: commitSha,
    updatedAt: fixtureNow,
  };
}

function createPreparationFixture(
  status: ServerPreparation["status"],
): ServerPreparation {
  const finished = status === "succeeded" || status === "failed";
  const definitions: Array<
    Pick<ServerPreparation["steps"][number], "id" | "title">
  > = [
    { id: "connecting", title: "Connect securely" },
    { id: "inspecting", title: "Inspect server" },
    { id: "installing_prerequisites", title: "Install prerequisites" },
    { id: "installing_docker", title: "Install Docker Engine" },
    { id: "installing_caddy", title: "Install Caddy" },
    { id: "installing_log_collector", title: "Install OTEL Logs Collector" },
    { id: "configuring_access", title: "Configure access" },
    { id: "verifying", title: "Verify server" },
  ];
  return {
    createdAt: fixtureNow,
    errorCode:
      status === "failed" ? "SERVER_PREPARATION_INSTALLING_DOCKER" : null,
    errorMessage:
      status === "failed"
        ? "Conflicting container packages are installed. Use a fresh Ubuntu server, or clean up the conflicting installation before trying again."
        : null,
    finishedAt: finished ? fixtureNow : null,
    id: randomUUID(),
    result:
      status === "succeeded"
        ? {
            caddyVersion: "v2.11.4",
            dockerVersion: "28.3.3",
            operatingSystem: "Ubuntu 24.04 LTS",
            pythonVersion: "Python 3.12.3",
          }
        : null,
    startedAt: status === "queued" ? null : fixtureNow,
    status,
    steps: definitions.map((step, index) => ({
      ...step,
      log: status === "succeeded" ? preparationStepResults[step.id].log : "",
      logTruncated: false,
      finishedAt: finished ? fixtureNow : null,
      message:
        status === "succeeded"
          ? preparationStepResults[step.id].message
          : index === 0
            ? "Waiting for the server coordinator"
            : null,
      startedAt: status === "queued" ? null : fixtureNow,
      status: status === "succeeded" ? "succeeded" : "waiting",
    })),
  };
}

function advancePreparationFixture(
  preparation: ServerPreparation,
  server: Server,
) {
  const now = new Date().toISOString();
  if (preparation.status === "queued") {
    preparation.status = "running";
    preparation.startedAt = now;
    const first = preparation.steps[0];
    if (first) {
      first.message = "Opening the trusted SSH connection";
      first.startedAt = now;
      first.status = "running";
    }
    return;
  }

  const activeIndex = preparation.steps.findIndex(
    (step) => step.status === "running",
  );
  if (activeIndex < 0) return;
  const active = preparation.steps[activeIndex]!;
  active.finishedAt = now;
  active.message = preparationStepResults[active.id].message;
  active.log = preparationStepResults[active.id].log;
  active.logTruncated = false;
  const username = server.config.ssh.username;
  if (active.id === "connecting")
    active.message = active.message.replace("as root ", `as ${username} `);
  if (username !== "root") {
    if (active.id === "inspecting") {
      active.message = active.message.replace(
        "root access",
        "passwordless sudo access",
      );
      active.log = active.log.replace(
        "Administrative access: root",
        "Administrative access: passwordless sudo verified",
      );
    }
    if (active.id === "configuring_access")
      active.message = `Created /etc/caddy/towbar and /var/lib/towbar with mode 0755. Added ${username} to the Docker group and verified membership.`;
  }
  active.status = "succeeded";
  const next = preparation.steps[activeIndex + 1];
  if (next) {
    next.message = `${next.title} in progress`;
    next.startedAt = now;
    next.status = "running";
    return;
  }

  preparation.finishedAt = now;
  preparation.result = {
    caddyVersion: "v2.11.4",
    dockerVersion: "28.3.3",
    operatingSystem: "Ubuntu 24.04 LTS",
    pythonVersion: "Python 3.12.3",
  };
  preparation.status = "succeeded";
  serverChecks.unshift({
    createdAt: now,
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    id: randomUUID(),
    result: null,
    startedAt: null,
    status: "queued",
  });
}

function createBackupFixture(
  id: string,
  resource: FixtureResource,
  createdAt: string,
  sizeBytes: number,
): SourceBackup {
  const key = `${resource.manifestId}/${createdAt.replaceAll(":", "-")}.dump`;
  return {
    cancelRequestedAt: null,
    createdAt,
    deletedAt: null,
    errorCode: null,
    errorMessage: null,
    finishedAt: createdAt,
    id,
    phase: null,
    request: { type: "backup" },
    requestedBy: user.id,
    resourceId: resource.id,
    resourceKind: resource.kind,
    resourceManifestId: resource.manifestId,
    resourceName: resource.name,
    result: {
      backupId: id,
      bucket: "towbar-fixture-backups",
      checksum: "sha256:" + "a".repeat(64),
      deletedBackupIds: [],
      destinations: [
        {
          bucket: "towbar-fixture-backups",
          encryption: "AES256",
          key,
          provider: "s3",
          region: "ap-south-1",
        },
        {
          bucket: "towbar-fixture-gcs-backups",
          encryption: "Google-managed",
          key: `${resource.manifestId}/${createdAt.replaceAll(":", "-")}.dump`,
          provider: "gcs",
          region: "asia-south1",
        },
      ],
      encryption: "AES256",
      engine: resource.kind,
      engineMajorVersion:
        managedResourceCompatibility[resource.kind].majorVersion,
      format: (
        {
          postgres: "postgres-custom",
          mysql: "mysql-sql",
          mariadb: "mariadb-sql",
          mongodb: "mongodb-archive",
          redis: "redis-rdb",
          dragonfly: "dragonfly-rdb",
          keydb: "keydb-rdb",
          clickhouse: "clickhouse-backup",
        } as const
      )[resource.kind],
      key,
      metadataVersion: 1,
      region: "ap-south-1",
      restoreFrom: "s3" as const,
      sizeBytes,
      verifiedAt: createdAt,
      warnings: [],
    },
    serverId: resource.serverId,
    sourceId: resource.sourceId,
    startedAt: createdAt,
    state: "succeeded",
    type: "backup",
    updatedAt: createdAt,
  };
}

function createNotificationEventFixture(
  id: string,
  eventType: string,
): NotificationEvent {
  const isPreview = eventType.startsWith("preview.");
  const category =
    eventType === "notification.test"
      ? "test"
      : isPreview
        ? "previews"
        : "deployments";
  const payload: NotificationEvent["payload"] = {
    details: isPreview
      ? {}
      : { deployableId: fixtureIds.app, deployableKind: "app" },
    entity: {
      id: isPreview ? fixtureIds.preview : fixtureIds.deployment,
      kind: isPreview ? "preview" : "deployment",
      name: "Example Website",
    },
    message:
      eventType === "preview.ready"
        ? "Example Website Preview is ready."
        : eventType === "notification.test"
          ? "Towbar successfully reached this notification destination."
          : "Example Website deployment failed its health check.",
    occurredAt: fixtureNow,
    source: { id: source.id, name: source.repositoryName },
    title:
      eventType === "preview.ready"
        ? "Preview ready"
        : eventType === "notification.test"
          ? "Test notification"
          : "Deployment failed",
  };
  return {
    category,
    createdAt: fixtureNow,
    id,
    occurredAt: fixtureNow,
    payload,
    type: eventType,
  };
}

function createDeploymentFixture(
  id: string,
  deployable: App | Resource,
  server: Server,
  state: DeploymentState,
  createdAt = fixtureNow,
  trigger: Deployment["trigger"] = "manual",
): Deployment {
  const mapping = environmentMappings.find(
    (item) => item.id === deployable.environment?.id,
  );
  if (!mapping) throw new Error("Fixture deployment requires an environment");
  const terminal = terminalStates.has(state);
  const scanCompletedAt = new Date(
    new Date(createdAt).getTime() + 102_000,
  ).toISOString();
  const startedAt = state === "queued" ? null : createdAt;
  const imageDigest = `sha256:${id.replaceAll("-", "").repeat(2)}`;
  return {
    targetEnvironment: {
      id: mapping.id,
      name: mapping.name,
      branch: mapping.branch,
      mappingRevision: mapping.mappingRevision,
    },
    appId: deployable.id,
    commitSha,
    createdAt,
    deployableKind: deployable.kind,
    environment: "production",
    errorCode: state === "failed" ? "FIXTURE_FAILURE" : null,
    errorMessage:
      state === "failed" ? "Representative fixture deployment failure." : null,
    finishedAt:
      terminal && startedAt
        ? new Date(new Date(startedAt).getTime() + 92_000).toISOString()
        : null,
    id,
    gitRef: null,
    githubDeploymentId: null,
    hostname: null,
    imageDigest:
      state === "succeeded" || state === "succeeded_with_warnings"
        ? imageDigest
        : null,
    imagePlatform:
      state === "succeeded" || state === "succeeded_with_warnings"
        ? server.hardware?.instance?.provider === "oracle"
          ? "linux/arm64"
          : "linux/amd64"
        : null,
    kind: trigger === "rollback" ? "rollback" : "deploy",
    manifestDigest,
    serverId: server.id,
    sourceId: deployable.sourceId,
    sourceInputDigest: "f".repeat(64),
    startedAt,
    state,
    trigger,
    updatedAt: createdAt,
    vulnerabilityScan:
      state === "succeeded" || state === "succeeded_with_warnings"
        ? createVulnerabilityScanFixture({
            completedAt: scanCompletedAt,
            createdAt,
            id,
            imageDigest,
          })
        : null,
    vulnerabilityScanningEnabled: true,
  };
}

function createVulnerabilityScanFixture(input: {
  completedAt: string;
  createdAt: string;
  id: string;
  imageDigest: string;
}): VulnerabilityScan {
  const state = (
    ["findings", "clean", "failed", "stale", "pending", "running"] as const
  )[Number.parseInt(input.id.at(-1) ?? "0", 16) % 6]!;
  const completed = ["clean", "findings", "failed", "stale"].includes(state);
  const findings = state === "findings" || state === "stale";
  const scannerStarted = state !== "pending";
  return {
    completedAt: completed ? input.completedAt : null,
    errorCode: state === "failed" ? "VULNERABILITY_SCAN_FAILED" : null,
    errorMessage:
      state === "failed"
        ? "The scanner could not refresh its vulnerability database."
        : null,
    findingsTruncated: false,
    id: `a${input.id.slice(1)}`,
    imageDigest: input.imageDigest,
    requestedAt: input.createdAt,
    scannerName: scannerStarted ? "trivy" : null,
    scannerVersion: scannerStarted ? "0.74.0" : null,
    severityTotals: findings
      ? { critical: 0, high: 1, low: 2, medium: 1, unknown: 0 }
      : { critical: 0, high: 0, low: 0, medium: 0, unknown: 0 },
    startedAt: scannerStarted ? input.createdAt : null,
    state,
    vulnerabilityDatabaseUpdatedAt: scannerStarted
      ? state === "stale"
        ? "2026-07-01T00:00:00.000Z"
        : "2026-08-14T00:00:00.000Z"
      : null,
  };
}

function getDeploymentSteps(deployment: Deployment): DeploymentStep[] {
  if (simulatedDeployments.has(deployment)) {
    const states: DeploymentState[] = [
      "queued",
      "building",
      "starting_candidate",
      "succeeded",
    ];
    const current = states.indexOf(deployment.state);
    return states
      .slice(0, current + 1)
      .map((state, index) =>
        createStep(
          deployment,
          state,
          index,
          index === current && state !== "succeeded" ? "running" : "succeeded",
        ),
      );
  }
  if (terminalStates.has(deployment.state)) {
    return [
      createStep(deployment, "queued", 0, "succeeded"),
      createStep(
        deployment,
        deployment.state,
        1,
        deployment.state === "failed"
          ? "failed"
          : deployment.state === "cancelled" || deployment.state === "skipped"
            ? "skipped"
            : "succeeded",
      ),
    ];
  }
  const currentIndex = Math.max(0, workflowStates.indexOf(deployment.state));
  return workflowStates
    .slice(0, currentIndex + 1)
    .map((state, index) =>
      createStep(
        deployment,
        state,
        index,
        index === currentIndex ? "running" : "succeeded",
      ),
    );
}

function createStep(
  deployment: Deployment,
  state: DeploymentState,
  index: number,
  status: DeploymentStep["status"],
): DeploymentStep {
  return {
    createdAt: deployment.createdAt,
    finishedAt: status === "running" ? null : deployment.updatedAt,
    id: `${deployment.id.slice(0, 24)}${String(index).padStart(12, "0")}`,
    message:
      status === "running"
        ? `Deployment is currently ${state.replaceAll("_", " ")}`
        : null,
    sequence: index,
    startedAt: deployment.startedAt,
    state,
    status,
  };
}

function getDeploymentLogs(deployment: Deployment): DeploymentLog[] {
  return [
    {
      content: "Preparing deployment\n",
      createdAt: deployment.createdAt,
      id: `${deployment.id.slice(0, 24)}900000000001`,
      sequence: 1,
      stream: "stdout",
    },
    {
      content:
        deployment.state === "queued"
          ? "Waiting for an available server slot\n"
          : `Deployment reached ${deployment.state.replaceAll("_", " ")}\n`,
      createdAt: deployment.updatedAt,
      id: `${deployment.id.slice(0, 24)}900000000002`,
      sequence: 2,
      stream: deployment.state === "failed" ? "stderr" : "stdout",
    },
  ];
}

function writeDeploymentEvents(
  response: ServerResponse,
  deployment: Deployment,
  liveDemo = false,
) {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  let sequence = 0;
  const send = () => {
    const event: DeploymentEvent = {
      deployment,
      logs: getDeploymentLogs(deployment),
      steps: getDeploymentSteps(deployment),
    };
    response.write(
      `id: ${++sequence}\nevent: deployment\ndata: ${fixtureJson(response, event)}\n\n`,
    );
  };
  send();
  const keepAlive = setInterval(
    liveDemo ? send : () => response.write(": keep-alive\n\n"),
    liveDemo ? 1_000 : 15_000,
  );
  response.on("close", () => clearInterval(keepAlive));
}

const allowedFixtureOrigins = new Set([
  "http://127.0.0.1:4021",
  "http://[::1]:4021",
  "http://localhost:4021",
  "http://localhost:4036",
]);

function authorizeFixtureCorsRequest(
  response: ServerResponse,
  origin?: string,
) {
  response.setHeader("vary", "Origin");
  if (!origin) return true;
  if (!allowedFixtureOrigins.has(origin)) {
    writeJson(response, 403, {
      error: { message: "Origin is not allowed by the local fixture API" },
    });
    return false;
  }

  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader(
    "access-control-allow-headers",
    "content-type,idempotency-key,last-event-id",
  );
  response.setHeader(
    "access-control-allow-methods",
    "DELETE,GET,OPTIONS,PATCH,POST,PUT",
  );
  return true;
}

function writeJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(fixtureJson(response, payload));
}

function writeNotFound(response: ServerResponse) {
  writeJson(response, 404, { error: { message: "Not found" } });
}

const entrypoint = process.argv[1];
if (
  isMainThread &&
  entrypoint &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  const port = 4420;
  const requestedRole = process.env.TOWBAR_FIXTURE_ROLE;
  const requestedState = process.env.TOWBAR_FIXTURE_AUTH_STATE;
  createFixtureApiServer({
    upgradeScenario:
      process.env.TOWBAR_FIXTURE_UPGRADE_ENABLED === "true"
        ? "unsupported"
        : undefined,
    role: isWorkspaceRole(requestedRole) ? requestedRole : "admin",
    authState:
      requestedState === "new-instance" ||
      requestedState === "signed-out" ||
      requestedState === "passkey-user" ||
      requestedState === "temporary-password"
        ? requestedState
        : "authenticated",
    smtpAvailable: process.env.TOWBAR_FIXTURE_SMTP_UNAVAILABLE !== "true",
    githubAppConnected: process.env.TOWBAR_FIXTURE_GITHUB_CONNECTED === "true",
    notificationProvidersConfigured:
      process.env.TOWBAR_FIXTURE_NOTIFICATION_PROVIDERS_CONFIGURED === "true",
    smtpConfigured: process.env.TOWBAR_FIXTURE_SMTP_CONFIGURED !== "false",
    slackConfigured:
      process.env.TOWBAR_FIXTURE_SLACK_CONFIGURED === "true" ||
      process.env.TOWBAR_FIXTURE_NOTIFICATION_PROVIDERS_CONFIGURED === "true",
    discordConfigured:
      process.env.TOWBAR_FIXTURE_DISCORD_CONFIGURED === "true" ||
      process.env.TOWBAR_FIXTURE_NOTIFICATION_PROVIDERS_CONFIGURED === "true",
    telegramConfigured:
      process.env.TOWBAR_FIXTURE_TELEGRAM_CONFIGURED === "true" ||
      process.env.TOWBAR_FIXTURE_NOTIFICATION_PROVIDERS_CONFIGURED === "true",
    webhookConfigured:
      process.env.TOWBAR_FIXTURE_WEBHOOK_CONFIGURED === "true" ||
      process.env.TOWBAR_FIXTURE_NOTIFICATION_PROVIDERS_CONFIGURED === "true",
  }).listen(port, "127.0.0.1", () => {
    console.info(`Towbar fixture API ready at http://127.0.0.1:${port}`);
  });
}
