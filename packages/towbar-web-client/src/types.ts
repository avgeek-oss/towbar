import type { Action, WorkspaceRole } from "@workspace/towbar-access";
import type {
  NormalizedApp,
  NormalizedComposeWorkload,
  NormalizedResource,
  ResourceType,
} from "@workspace/towbar-contracts";
export type TowbarUser = {
  avatarUrl?: string;
  email: string;
  id: string;
  name: string;
  workspaceId: string;
  workspaceRole: WorkspaceRole;
  teamName: string;
  capabilities: Action[];
  mustChangePassword: boolean;
  passwordSetupRequired: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
};

export type Source = {
  lastSyncedAt?: string | null;
  createdAt: string;
  id: string;
  provider: "github" | "gitlab";
  repositoryName: string;
  repositoryOwner: string;
  repositoryUrl?: string;
  status: "active" | "archived";
  updatedAt: string;
};

export type AutoDeployControlResponse = {
  autoDeploy: {
    effective: {
      paused: boolean;
      pending: {
        commitSha: string;
        deploymentDigest: string;
        deferredAt: string;
        manifestId: string;
        reason: "paused";
        scope: "deployable" | "environment" | "source";
      } | null;
      scope: "deployable" | "environment" | "source" | null;
    };
    manifestAutoDeployEnabled?: boolean;
    paused: boolean;
  };
  canManageAutoDeploy: boolean;
};

export type InstanceEnvironment = {
  id: string;
  name: string;
  branch: string;
  disconnectedAt: string | null;
};

export type App = {
  manifestState?: "active" | "conflict" | "retired" | "removing" | "removed";
  entityId: string | null;
  environment: InstanceEnvironment | null;
  archivedAt: string | null;
  config: NormalizedApp | NormalizedComposeWorkload;
  description: string | null;
  id: string;
  kind: "app" | "compose";
  manifestId: string;
  name: string;
  runtimeState: RuntimeState;
  serverReady: boolean;
  serverIp: string;
  sourceId: string;
  sourceRevision: string;
  updatedAt: string;
};

export type AppSecretStage =
  "build" | "deployment" | "pre_deploy" | "post_deploy";
export type AppSecretBinding = {
  repositoryId?: string | null;
  declared?: boolean;
  missingKeys?: string[];
  environment: string;
  stage: AppSecretStage;
  keys: string[];
  inheritedKeys: string[];
  availableReferences?: { globals: string[]; repo?: string[] };
  inheritedOrigins: Record<string, "global">;
  revision: string | null;
  inheritedRevisions: {
    global: string | null;
    repository?: string | null;
  };
  updatedAt: string | null;
  pendingChanges: boolean;
  affectedDeployables: Array<{
    id: string;
    name: string;
    kind: "app" | "resource" | "preview";
  }>;
};
export type AppSecretsResponse = {
  environments: string[];
  bindings: AppSecretBinding[];
  canManageSecrets: boolean;
};
export type InstanceSecretReadiness = {
  ready: boolean;
};
export type SecretMetadata = {
  keys: string[];
  revision: string | null;
  updatedAt: string | null;
};

export type NotificationCategory =
  | "deployments"
  | "deploymentFailures"
  | "previews"
  | "health"
  | "backups"
  | "restores"
  | "scout";

export type NotificationDestination = {
  categories: NotificationCategory[];
  config:
    | { channelId: string }
    | {
        recipients: string[];
      }
    | { webhookHost: string }
    | { messageThreadId: number }
    | { urlHost: string };
  createdAt: string;
  enabled: boolean;
  id: string;
  provider: "slack" | "smtp" | "discord" | "telegram" | "webhook";
  sourceId: string | null;
  serverId?: string | null;
  updatedAt: string;
};

export type NotificationEvent = {
  readAt?: string | null;
  category: NotificationCategory | "test";
  createdAt: string;
  id: string;
  occurredAt: string;
  payload: {
    details: Record<string, boolean | number | string | null>;
    entity: { id: string; kind: string; name: string };
    message: string;
    occurredAt: string;
    source: { id: string; name: string } | null;
    title: string;
  };
  type: string;
};

export type Resource = {
  manifestState?: "active" | "conflict" | "retired" | "removing" | "removed";
  entityId: string | null;
  environment: InstanceEnvironment | null;
  archivedAt: string | null;
  config: NormalizedResource;
  description: string | null;
  id: string;
  kind: ResourceType;
  manifestId: string;
  name: string;
  runtimeState: RuntimeState;
  serverReady: boolean;
  serverIp: string;
  sourceId: string;
  sourceRevision: string;
  updatedAt: string;
};

export type Server = {
  scout?: import("@workspace/towbar-contracts").ServerMonitoringSummary;
  hardware?: import("@workspace/towbar-contracts").ServerHardware | null;
  archivedAt: string | null;
  canonicalIp: string;
  name: string | null;
  config: {
    hostLogCollection?: boolean;
    buildConcurrency?: number;
    previewBuildConcurrency?: number;
    ip: string;
    ssh: { host?: string; port: number; username: string };
  };
  createdAt: string;
  id: string;
  preparedAt: string | null;
  setupStatus: "pending" | "preparing" | "ready" | "failed";
  updatedAt: string;
};

export type RuntimeState = {
  checkedAt: string | null;
  desiredState: "running" | "stopped";
  driftReasons: string[];
  driftStatus: "drifted" | "in_sync" | "unknown";
  healthStatus: "healthy" | "none" | "starting" | "unhealthy" | "unknown";
  ingressContainerName: string | null;
  ingressImage: string | null;
  ingressRestartCount: number | null;
  ingressStatus:
    "disabled" | "missing" | "ready" | "reconnecting" | "stopped" | "unknown";
  observedContainerName: string | null;
  observedImage: string | null;
  observedState: "missing" | "running" | "stopped" | "unknown";
};

export type OrphanItem = {
  kind: "container" | "image" | "volume";
  name: string;
  reason: string;
};

export type BackupDestinationResult = {
  bucket: string;
  encryption?: string;
  key: string;
  objectVersion?: string;
  provider: "gcs" | "r2" | "s3";
  region?: string;
};

export type BackupResult = {
  backupId: string;
  bucket: string;
  checksum: string;
  deletedBackupIds: string[];
  destinations?: BackupDestinationResult[];
  encryption: "AES256" | "aws:kms" | (string & {});
  engine?: ResourceType;
  engineMajorVersion?: number;
  format?:
    | "clickhouse-backup"
    | "dragonfly-rdb"
    | "keydb-rdb"
    | "mariadb-sql"
    | "mongodb-archive"
    | "mysql-sql"
    | "postgres-custom"
    | "redis-rdb";
  key: string;
  metadataVersion?: 1;
  objectVersionId?: string;
  region: string;
  restoreFrom?: "gcs" | "r2" | "s3";
  sizeBytes: number;
  verifiedAt: string;
  warnings: string[];
};

export type BackupAssurance = {
  backupOperationId: string | null;
  checkedAt: string;
  checks: Array<{ message: string; name: string; passed: boolean }>;
  resourceId: string;
  restoreReady: boolean;
  status: "missing" | "stale" | "not_restore_ready" | "restore_ready";
  updatedAt: string;
};

export type RestoreResult = {
  activeVolumes: Array<{ logicalName: string; volumeName: string }>;
  candidateCleaned: boolean;
  outcome: "promoted" | "candidate_failed" | "rolled_back";
  previousVolumes: Array<{ logicalName: string; volumeName: string }>;
  restoredBackupId: string;
  rollbackAvailableUntil: string | null;
  validation: {
    databaseName: string | null;
    engine: ResourceType;
    engineMajorVersion: number;
    healthVerified: boolean;
    readable: boolean;
  } | null;
  verifiedAt: string | null;
};

export type ResourceOperationEvent = {
  command: string | null;
  createdAt: string;
  id: string;
  level: "error" | "info" | "success";
  message: string;
  metadata: Record<string, boolean | number | string | null>;
  phase: string;
  sequence: number;
};

export type ResourceOperation = {
  createdAt: string;
  deletedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  cancelRequestedAt: string | null;
  phase: string | null;
  request: Record<string, unknown> & { type: ResourceOperationType };
  requestedBy: string | null;
  resourceId: string | null;
  result:
    | BackupResult
    | {
        jobName: string;
        logs: string;
        truncated: boolean;
        exitCode: number;
        timedOut: boolean;
      }
    | {
        buildCache?: { status: "succeeded" | "failed"; message: string };
        cleaned: OrphanItem[];
        skipped: OrphanItem[];
        failures?: OrphanItem[];
        retiredDeployableIds?: string[];
        retiredPaths?: string[];
      }
    | { logs: string; truncated: boolean }
    | RestoreResult
    | {
        cleanedVolumes: string[];
        restoreId: string;
        skippedVolumes: string[];
      }
    | { state: "running" | "stopped" }
    | null;
  serverId: string;
  sourceId: string | null;
  startedAt: string | null;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  type: ResourceOperationType;
  updatedAt: string;
};

export type ResourceOperationType =
  | "run_job"
  | "backup"
  | "capture_logs"
  | "cleanup_orphans"
  | "restart"
  | "restore"
  | "restore_cleanup"
  | "start"
  | "stop";

export type SourceBackup = ResourceOperation & {
  resourceKind: ResourceType;
  resourceManifestId: string;
  resourceName: string;
  result: BackupResult;
};

export type DeploymentState =
  | "queued"
  | "waiting_for_server"
  | "preparing"
  | "validating_credentials"
  | "checking_server"
  | "fetching_source"
  | "resolving_secrets"
  | "transferring"
  | "building"
  | "running_pre_deploy"
  | "starting_candidate"
  | "checking_health"
  | "configuring_routing"
  | "provisioning_tls"
  | "checking_public_endpoint"
  | "switching_traffic"
  | "running_post_deploy"
  | "cleaning_up"
  | "succeeded"
  | "succeeded_with_warnings"
  | "skipped"
  | "failed"
  | "cancelled";

export type Deployment = {
  targetEnvironment: {
    id: string;
    name: string;
    branch: string;
    mappingRevision: string;
  };
  appId: string;
  commitSha: string;
  createdAt: string;
  deployableKind: "app" | "compose" | ResourceType;
  environment: "preview" | "production";
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  gitRef: string | null;
  githubDeploymentId: string | null;
  hostname: string | null;
  imageDigest: string | null;
  imagePlatform: string | null;
  kind: "deploy" | "rollback";
  manifestDigest: string;
  queueBlocker?:
    | "server_capacity"
    | "server_check"
    | "server_operation"
    | "server_preparation"
    | null;
  serverId: string;
  sourceId: string;
  sourceInputDigest: string | null;
  startedAt: string | null;
  state: DeploymentState;
  trigger: "auto_deploy" | "manual" | "rollback";
  updatedAt: string;
  vulnerabilityScan?: VulnerabilityScan | null;
  vulnerabilityScanningEnabled?: boolean;
};

export type DeploymentPullRequest = {
  author: string | null;
  baseBranch: string;
  changedFileCount: number;
  draft: boolean;
  headBranch: string;
  merged: boolean;
  number: number;
  state: "closed" | "open";
  title: string;
  url: string;
};

export type VulnerabilitySeverityTotals = {
  critical: number;
  high: number;
  low: number;
  medium: number;
  unknown: number;
};

export type VulnerabilityScan = {
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  findingsTruncated: boolean;
  id: string;
  imageDigest: string;
  requestedAt: string;
  scannerName: string | null;
  scannerVersion: string | null;
  severityTotals: VulnerabilitySeverityTotals;
  startedAt: string | null;
  state: "pending" | "running" | "clean" | "findings" | "failed" | "stale";
  vulnerabilityDatabaseUpdatedAt: string | null;
};

export type VulnerabilityFinding = {
  advisoryId: string;
  fixedVersion: string | null;
  id: string;
  installedVersion: string;
  packageName: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  target: string;
};

export type VulnerabilityFindingSummary = VulnerabilityFinding & {
  appArchivedAt: string | null;
  appId: string;
  appName: string;
  deploymentId: string;
  imageDigest: string;
  scanState: "pending" | "running" | "clean" | "findings" | "failed" | "stale";
  scannedAt: string | null;
  serverId: string;
  serverName: string;
  sourceId: string;
  sourceName: string | null;
};

export type WorkspaceVulnerabilityFindings = {
  findings: VulnerabilityFindingSummary[];
  nextPage: number | null;
  page: number;
  summary: {
    activeScans: number;
    cleanScans: number;
    critical: number;
    failedScans: number;
    high: number;
    low: number;
    medium: number;
    scansWithFindings: number;
    unknown: number;
  };
};

export type PreviewEnvironment = {
  appId: string;
  appName: string;
  branch: string;
  cleanupAttempts: number;
  createdAt: string;
  errorMessage: string | null;
  expiresAt: string;
  gitRef: string;
  hostname: string;
  id: string;
  latestCommitSha: string;
  latestDeploymentId: string | null;
  nextCleanupAttemptAt: string | null;
  pullRequestNumber: number;
  pullRequestUrl: string;
  sourceId: string;
  status: "building" | "healthy" | "failed" | "deleting" | "cleanup_failed";
  updatedAt: string;
};

export type DeploymentStep = {
  createdAt: string;
  finishedAt: string | null;
  id: string;
  message: string | null;
  sequence: number;
  startedAt: string | null;
  state: DeploymentState;
  status: "failed" | "running" | "skipped" | "succeeded" | "waiting";
};

export type DeploymentLog = {
  content: string;
  createdAt: string;
  id: string;
  sequence: number;
  stream: "stderr" | "stdout";
};

export type DeploymentEvent = {
  deployment: Deployment;
  logs: DeploymentLog[];
  steps: DeploymentStep[];
};

export type GitHubConnection = {
  identityWarnings?: string[];
  accountLogin: string;
  accountType: string;
  id: string;
  installationId: string;
  permissionReadiness:
    | {
        contents: "none" | "read" | "write";
        deployments: "none" | "read" | "write";
        preview: "missing" | "ready";
        pullRequests: "none" | "read" | "write";
        status: "available";
      }
    | { status: "unavailable" };
  suspendedAt: string | null;
  updatedAt: string;
};

export type GitHubConnectionMetadata = Pick<
  GitHubConnection,
  "id" | "accountLogin" | "accountType" | "suspendedAt"
>;

export type NamedIntegrationConnection = {
  configuration: Record<string, unknown>;
  credentialValues: Record<string, string>;
  createdAt: string;
  credentialHint: string | null;
  description: string;
  disconnectedAt: string | null;
  id: string;
  name: string;
  provider: import("@workspace/towbar-contracts").IntegrationProvider;
  revision: number;
  scopes: import("@workspace/towbar-contracts").IntegrationScope[];
  slug: string;
  updatedAt: string;
  verificationMessage: string | null;
  verificationStatus: "unverified" | "verified" | "failed";
  verifiedAt: string | null;
};

export type GitHubAppConfigurationMetadata = {
  appId: string;
  appSlug: string;
  createdAt: string;
  updatedAt: string;
};

export type PreviewReportingHealth = {
  failedCount: number;
  lastError: string | null;
  lastFailedAt: string | null;
};

export type GitHubRepository = {
  connectionId?: string;
  defaultBranch: string;
  fullName: string;
  id: string;
  name: string;
  owner: string;
  private: boolean;
};

export type AwsCredentialMetadata = {
  accessKeyId: string;
  accessKeyIdSuffix: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  region: string;
  status: "unverified" | "verified" | "failed";
  updatedAt: string;
  verificationMessage: string | null;
};

export type GcpCredentialMetadata = {
  clientEmail: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  projectId: string;
  status: "unverified" | "verified" | "failed";
  updatedAt: string;
  verificationMessage: string | null;
};

export type SourceSync = {
  environment: { id: string; name: string; branch: string } | null;
  mappingRevision: string | null;
  commitSha: string | null;
  createdAt: string;
  finishedAt: string | null;
  id: string;
  issues: unknown[] | null;
  manifestDigest: string | null;
  reconciliation: unknown;
  startedAt: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
};

export type ServerCheck = {
  createdAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
};

export type PaginationMetadata = {
  limit: number;
  page: number;
  total: number;
  totalPages: number;
};

export type DeploymentHistoryItem = Deployment & {
  deployableDomain: string | null;
  deployableImage: string | null;
  deployableName: string;
};

export type DeploymentHistoryPage = {
  environments: string[];
  deployments: DeploymentHistoryItem[];
  pagination: PaginationMetadata;
};

export type ServerChecksPage = {
  checks: ServerCheck[];
  latestCheck: ServerCheck | null;
  pagination: PaginationMetadata;
};

export type ServerPreparationStep = {
  finishedAt: string | null;
  log?: string;
  logTruncated?: boolean;
  id:
    | "connecting"
    | "inspecting"
    | "installing_prerequisites"
    | "installing_docker"
    | "installing_caddy"
    | "installing_log_collector"
    | "configuring_access"
    | "verifying";
  message: string | null;
  startedAt: string | null;
  status: "waiting" | "running" | "succeeded" | "failed";
  title: string;
};

export type ServerPreparation = {
  createdAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  steps: ServerPreparationStep[];
};

export type TrustedHostKey = {
  algorithm: string;
  createdAt: string;
  fingerprint: string;
  id: string;
};

export type Release = {
  appId: string;
  commitSha: string;
  composeServices: string[];
  containerName: string;
  deploymentId: string;
  id: string;
  imageDigest: string | null;
  imagePlatform: string | null;
  imageTag: string;
  promotedAt: string;
  status: "current" | "previous" | "superseded";
  supersededAt: string | null;
};

export type UserSession = {
  createdAt: string;
  expiresAt: string;
  id: string;
  lastSeenAt: string;
  revokedAt: string | null;
};

export type AppStorageResponse = {
  checkedAt: string | null;
  serverId: string;
  serverIp: string;
  volumes: Array<{
    name: string;
    mountPath: string;
    volumeName: string;
    status: "mounted" | "pending" | "retained" | "not_mounted" | "unknown";
  }>;
};

export type AppJob = {
  name: string;
  description?: string;
  command: string[];
  schedule: { cron: string; timezone: "UTC" };
  timeoutSeconds: number;
  enabled: boolean;
};
export type AppJobRun = Omit<ResourceOperation, "request" | "result"> & {
  request: { type: "run_job"; job: AppJob; scheduledAt: string | null };
  result: {
    jobName: string;
    logs: string;
    truncated: boolean;
    exitCode: number;
    timedOut: boolean;
  } | null;
};
export type AppJobsResponse = {
  automationPaused: boolean;
  jobs: AppJob[];
  ready: boolean;
  runs: AppJobRun[];
};
