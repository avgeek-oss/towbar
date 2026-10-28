export const referenceCategories = [
  "Repositories",
  "Services",
  "Datastores",
  "Servers",
  "Deployments",
  "Previews",
  "Workspace",
  "Integrations",
] as const;

const categoryByRoot: Record<string, string> = {
  monitoring: "Workspace",
  logs: "Workspace",
  observability: "Workspace",
  sources: "Repositories",
  "manifest-lifecycle": "Repositories",
  retirements: "Repositories",
  apps: "Services",
  resources: "Datastores",
  servers: "Servers",
  deployments: "Deployments",
  workloads: "Deployments",
  previews: "Previews",
  settings: "Workspace",
  identity: "Workspace",
  "system-health": "Workspace",
  version: "Workspace",
  github: "Integrations",
  integrations: "Integrations",
  aws: "Integrations",
  gcp: "Integrations",
};

export const sectionOrder = [
  "Overview",
  "Sync & manifest",
  "Environments",
  "Auto-deploy",
  "Deployments",
  "Runtime & logs",
  "Storage",
  "Scheduled jobs",
  "Backups & restores",
  "Previews",
  "Inventory",
  "Capacity",
  "Monitoring",
  "Centralized logs",
  "Notifications",
  "Scout Agent",
  "Scout Alerts",
  "Performance comparisons",
  "Checks & preparation",
  "Credentials & trust",
  "Maintenance",
  "Progress & logs",
  "Actions",
  "Security scans",
  "Secrets",
  "Shared secrets",
  "System health",
  "Identity",
  "Connections",
  "GitHub",
  "AWS",
  "GCP",
  "Lifecycle",
];

// Match the most specific task before a broader collection or runtime route.
const rules: Record<string, Array<[string, RegExp]>> = {
  logs: [["Centralized logs", /^\/logs\//]],
  observability: [["Centralized logs", /^\/observability\/logs\//]],
  monitoring: [
    [
      "Monitoring",
      /^\/monitoring\/(entities|alerts|incidents|vulnerabilities)$/,
    ],
  ],
  "manifest-lifecycle": [["Lifecycle", /^\/manifest-lifecycle$/]],
  retirements: [["Lifecycle", /^\/retirements\//]],
  sources: [
    ["Lifecycle", /\/removal-preview$/],
    ["Environments", /\/environments(?:\/|$)/],
    ["Sync & manifest", /^\/sources\/(discover|connect)$/],
    ["Secrets", /\/secrets(?:\/|$)/],
    ["Auto-deploy", /\/auto-deploy-control$/],
    ["Sync & manifest", /\/(branches|manifest|syncs|actions)(?:\/|$)/],
    ["Inventory", /\/(apps|resources|capacity|deployments|backups|previews)$/],
    ["Overview", /^\/sources(?:\/[^/]+)?$/],
  ],
  apps: [
    ["Notifications", /\/notifications\/deliveries$/],
    ["Scheduled jobs", /\/jobs$|\/actions\/run-job$/],
    ["Storage", /\/storage$/],
    ["Scout Agent", /\/(metrics|analytics)(?:\/filter-options)?$/],
    ["Secrets", /\/secrets(?:\/|$)/],
    ["Previews", /\/previews$/],
    [
      "Deployments",
      /\/(auto-deploy-control|deployments|releases)$|\/actions\/(deploy|rollback)$/,
    ],
    ["Runtime & logs", /\/(operations|actions)(?:\/|$)/],
    ["Overview", /^\/apps(?:\/[^/]+)?$/],
  ],
  resources: [
    ["Notifications", /\/notifications\/deliveries$/],
    ["Scout Agent", /\/metrics$/],
    ["Secrets", /\/secrets(?:\/|$)/],
    [
      "Backups & restores",
      /\/backup-assurance$|\/actions\/(backup|restore|restore-cleanup|cancel)$|\/operations\/[^/]+\/events$/,
    ],
    [
      "Deployments",
      /\/(auto-deploy-control|deployments|releases)$|\/actions\/(deploy|rollback)$/,
    ],
    ["Runtime & logs", /\/(operations|actions)(?:\/|$)/],
    ["Overview", /^\/resources(?:\/[^/]+)?$/],
  ],
  workloads: [
    [
      "Performance comparisons",
      /\/(comparison-deployments|deployment-comparison)$/,
    ],
  ],
  servers: [
    ["Centralized logs", /\/log-collection(?:\/|$)/],
    ["Overview", /\/name$/],
    ["Scout Alerts", /\/scout-alerts(?:\/|$)/],
    ["Scout Agent", /\/(monitoring|metrics)(?:\/|$)/],
    ["Credentials & trust", /\/(credentials|host-keys)(?:\/|$)/],
    [
      "Checks & preparation",
      /\/(checks|preparations)$|\/actions\/(check|prepare)$/,
    ],
    ["Cleanup", /\/(orphans|cleanup)$|\/actions\/cleanup-orphans$/],
    ["Capacity", /\/capacity$/],
    ["Inventory", /\/(apps|resources|deployments)$/],
    ["Overview", /^\/servers(?:\/[^/]+)?$/],
  ],
  deployments: [
    ["Security scans", /\/vulnerability-scan\//],
    ["Progress & logs", /\/(steps|logs|events)$/],
    ["Actions", /\/actions\//],
    ["Overview", /^\/deployments(?:\/[^/]+)?$/],
  ],
  previews: [["Lifecycle", /^\/previews\//]],
  settings: [["Shared secrets", /^\/settings\/secrets(?:\/|$)/]],
  identity: [["Identity", /^\/identity$/]],
  "system-health": [["System health", /^\/system-health(?:\/|$)/]],
  version: [["System health", /^\/version$/]],
  github: [["GitHub", /^\/github(?:\/|$)/]],
  integrations: [["Connections", /^\/integrations(?:\/|$)/]],
  aws: [["AWS", /^\/aws$/]],
  gcp: [["GCP", /^\/gcp$/]],
};

export function referenceGroup(path: string): [string, string] {
  const root = path.split("/")[1]!;
  const category = categoryByRoot[root];
  const section = rules[root]?.find(([, pattern]) => pattern.test(path))?.[0];
  if (!category || !section)
    throw new Error(`Classify the API route before publishing: ${path}`);
  return [category, section];
}
