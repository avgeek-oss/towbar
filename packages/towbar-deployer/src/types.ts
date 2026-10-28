import type {
  DeploymentState,
  DomainHandoff,
  NormalizedDeployable,
  NormalizedServer,
  OrphanItem,
  ResourceOperationRequest,
  ResourceOperationResult,
  RuntimeExpectation,
  RuntimeInspection,
  ServerPreparationStepId,
  ServerPreparationStepStatus,
} from "@workspace/towbar-core";

export type SshLoginSecret = {
  privateKey: string;
};

export type DeploymentSecrets = {
  domainHandoffDns?: Record<string, { apiToken: string; zoneId?: string }>;
  domainHandoffLogins?: Record<string, SshLoginSecret>;
  buildLogin?: SshLoginSecret;
  build: Record<string, string>;
  cloudflare: { apiToken: string } | null;
  previousCloudflareDns?: { apiToken: string; hostnames: string[] } | null;
  previousCloudflareDnsCleanupBlocked?: boolean;
  cloudflareTunnel: {
    accountId: string;
    access: boolean;
    apiToken: string;
    image: string;
    integration: string;
    tunnelName?: string;
    zoneId?: string;
  } | null;
  previousCloudflareTunnel: {
    accountId: string;
    apiToken: string;
    hostnames: string[];
    integration: string;
    tunnelName?: string;
    zoneId?: string;
  } | null;
  previousCloudflareTunnelCleanupBlocked: boolean;
  hooks: {
    postDeploy: Record<string, string>;
    preDeploy: Record<string, string>;
  };
  login: SshLoginSecret;
  registry?: {
    password: string;
    server: string;
    username: string;
  } | null;
  runtime: Record<string, string>;
};

export type DeploymentExecutionContext = {
  previousSourceIds?: string[];
  domainHandoffs?: DomainHandoff[];
  domainHandoffServers?: Array<{
    id: string;
    server: NormalizedServer;
    trustedHostKeys: TrustedHostKey[];
  }>;
  app: NormalizedDeployable;
  buildServer?: {
    config: NormalizedServer;
    id: string;
    transfer: "direct" | "registry";
    trustedHostKeys: TrustedHostKey[];
  };
  commitSha: string;
  deploymentId: string;
  deployableId: string;
  environment?: "preview" | "production";
  environmentName: string;
  gitRef?: string | null;
  sourceCredential: RepositorySourceCredential | null;
  kind: "deploy" | "rollback";
  repositoryName: string;
  repositoryOwner: string;
  runtimeId?: string;
  serverId: string;
  sourceId: string;
  workspaceId: string;
  rollbackRelease: {
    commitSha: string;
    containerName: string;
    imageTag: string;
    releaseId: string;
    sourceDeploymentId: string;
  } | null;
  currentRelease: {
    containerName: string;
    containerNames?: string[];
    imageTag: string;
  } | null;
  server: NormalizedServer;
  trustedHostKeys: TrustedHostKey[];
};

export type RepositorySourceCredential = {
  apiUrl: string;
  provider: "github";
  token: string;
};

export type TrustedHostKey = {
  algorithm: string;
  fingerprint: string;
  publicKey: string;
};

export type PreviewCleanupContext = {
  containerNames: string[];
  hostname: string;
  imageTags: string[];
  previewEnvironmentId: string;
  runtimeId: string;
  server: NormalizedServer;
  trustedHostKeys: TrustedHostKey[];
};

export type ServerCheckContext = {
  cleanupExpected?: import("@workspace/towbar-core").ServerCleanupPlan;
  checkId: string;
  config: NormalizedServer;
  expectedContainerNames: string[];
  expectedDeployables: RuntimeExpectation[];
  expectedImageTags: string[];
  imageOwners?: Record<string, string>;
  ownedDeployableIds?: string[];
  login: SshLoginSecret;
  purpose?: "credential-verification";
  trustedHostKeys: TrustedHostKey[];
};

export type ServerCredentialVerificationResult = {
  hostKey: TrustedHostKey;
};

export type ServerPreparationContext = {
  cleanupDeployableIds?: string[];
  privateKeyName?: string;
  config: NormalizedServer;
  login: SshLoginSecret;
  preparationId: string;
  trustedHostKeys: TrustedHostKey[];
};

export type ServerPreparationHooks = {
  installLogCollector: () => Promise<string>;
  log?: (input: {
    id: ServerPreparationStepId;
    log: string;
    logTruncated: boolean;
  }) => Promise<void>;
  step: (input: {
    id: ServerPreparationStepId;
    message: string;
    status: Exclude<ServerPreparationStepStatus, "waiting">;
  }) => Promise<void>;
};

export type ServerPreparationResult = {
  caddyVersion: string;
  diskAvailableKb: number;
  dockerVersion: string;
  operatingSystem: string;
  pythonVersion: string;
  zstdVersion: string;
};

export type ExecutorHooks = {
  commitRelease?: (result: DeploymentResult) => Promise<ReleaseCommitResult>;
  heartbeat?: (details: { state: DeploymentState }) => void;
  log?: (content: string, stream: "stderr" | "stdout") => Promise<void>;
  transition?: (state: DeploymentState, message: string) => Promise<void>;
};

export type ReleaseCommitResult = {
  retainedImageTags: string[];
};

export type DeploymentResult = {
  candidatePort: number;
  candidatePorts: number[];
  composeServices?: string[];
  containerName: string;
  containerNames: string[];
  imageDigest: string;
  imagePlatform: string;
  imageTag: string;
  warnings: string[];
};

export type ServerCheckResult = {
  caddyVersion: string;
  diskAvailableKb: number;
  host: {
    instance?: import("@workspace/towbar-core").CloudInstance | null;
    cpuLogicalCount: number;
    cpuUsagePercent: number;
    diskAvailableKb: number;
    diskTotalKb: number;
    loadAverage1m: number;
    memoryAvailableKb: number;
    memoryTotalKb: number;
    uptimeSeconds: number;
  };
  dockerVersion: string;
  hostKey: TrustedHostKey;
  operatingSystem: string;
  orphans: OrphanItem[];
  runtime: RuntimeInspection[];
};

export type WorkspaceAwsCredential = {
  accessKeyId: string;
  region: string;
  secretAccessKey: string;
};

export type WorkspaceGcpCredential = {
  projectId?: string;
  serviceAccountKey: string;
};

export type ResourceOperationExecutionContext = {
  previousSourceIds?: string[];
  cleanupExpected: import("@workspace/towbar-core").ServerCleanupPlan;
  currentRelease: {
    containerName: string;
    imageTag: string;
    releaseId: string;
  } | null;
  deployable: NormalizedDeployable | null;
  deployableId: string | null;
  environment?: string | null;
  operationId: string;
  retentionBackups: Array<{
    bucket: string;
    destinations?: import("@workspace/towbar-core").BackupDestinationResult[];
    id: string;
    key: string;
  }>;
  restoreBackup: {
    createdAt: string;
    id: string;
    result: import("@workspace/towbar-core").BackupOperationResult;
  } | null;
  request: ResourceOperationRequest;
  sourceId: string | null;
  server: NormalizedServer;
  trustedHostKeys: TrustedHostKey[];
};

export type ResourceOperationSecrets = {
  aws: WorkspaceAwsCredential | null;
  gcp: WorkspaceGcpCredential | null;
  login: SshLoginSecret;
  namedStorage: NamedBackupStorageConnection | null;
  runtime: Record<string, string>;
  sensitiveValues: string[];
};

export type NamedBackupStorageConnection =
  import("@workspace/towbar-core").NamedBackupStorageConnection;

export type BackupStorage = {
  deleteObject(input: {
    bucket: string;
    key: string;
    versionId?: string;
  }): Promise<void>;
  download(input: {
    bucket: string;
    key: string;
    localPath: string;
    maximumBytes?: number;
    signal?: AbortSignal;
    versionId?: string;
  }): Promise<void>;
  headObject(input: {
    bucket: string;
    key: string;
    versionId?: string;
  }): Promise<{
    checksum?: string;
    backupClass?: "database" | "volume";
    engine?: import("@workspace/towbar-core").BackupOperationResult["engine"];
    engineMajorVersion?: number;
    encryption?: string;
    exists: boolean;
    format?:
      | import("@workspace/towbar-core").BackupOperationResult["format"]
      | "tar-gzip"
      | "tar-zstd";
    manifest?: string;
    metadataVersion?: number;
    sizeBytes?: number;
  }>;
  upload(input: {
    bucket: string;
    encryption?: string;
    key: string;
    kmsKeyId?: string;
    localPath: string;
    metadata: Record<string, string>;
    signal?: AbortSignal;
    sizeBytes: number;
  }): Promise<{ versionId?: string }>;
};

export type ResourceOperationHooks = {
  progress?: (input: {
    command?: string;
    level?: "error" | "info" | "success";
    message: string;
    metadata?: Record<string, boolean | number | string | null>;
    phase: import("@workspace/towbar-core").RestoreOperationPhase;
  }) => Promise<void>;
};

export type ResourceOperationExecutorResult = ResourceOperationResult & {
  deletedBackupIds?: string[];
};
