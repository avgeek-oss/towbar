import { type AppJob, appJobResultSchema } from "./app-jobs.js";
import { z } from "zod";

const managedBackupEngines = [
  "postgres",
  "mysql",
  "mariadb",
  "mongodb",
  "redis",
  "dragonfly",
  "keydb",
  "clickhouse",
] as const;

export const resourceOperationTypes = [
  "backup",
  "capture_logs",
  "run_job",
  "cleanup_orphans",
  "restart",
  "restore",
  "restore_cleanup",
  "start",
  "stop",
] as const;

export const resourceOperationTypeSchema = z.enum(resourceOperationTypes);
export type ResourceOperationType = z.infer<typeof resourceOperationTypeSchema>;

export const resourceOperationStates = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type ResourceOperationState = (typeof resourceOperationStates)[number];

export const runtimeDesiredStates = ["running", "stopped"] as const;
export type RuntimeDesiredState = (typeof runtimeDesiredStates)[number];

export const runtimeObservedStates = [
  "missing",
  "running",
  "stopped",
  "unknown",
] as const;
export type RuntimeObservedState = (typeof runtimeObservedStates)[number];

export const runtimeHealthStates = [
  "healthy",
  "none",
  "starting",
  "unhealthy",
  "unknown",
] as const;
export type RuntimeHealthState = (typeof runtimeHealthStates)[number];

export const runtimeDriftStates = ["drifted", "in_sync", "unknown"] as const;
export type RuntimeDriftState = (typeof runtimeDriftStates)[number];

export const orphanKinds = ["container", "image", "volume"] as const;
export const orphanKindSchema = z.enum(orphanKinds);
export type OrphanKind = z.infer<typeof orphanKindSchema>;

export const orphanItemSchema = z
  .object({
    kind: orphanKindSchema,
    name: z.string().trim().min(1).max(512),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type OrphanItem = z.infer<typeof orphanItemSchema>;

export type RuntimeExpectation = {
  volumes?: Array<{ name: string; mountPath: string }>;
  connectivity: {
    containerPort: number;
    hostPort: number | null;
    network: string | null;
    networkAlias: string | null;
  } | null;
  deployableId: string;
  sourceId: string;
  desiredState: RuntimeDesiredState;
  health:
    | { command: string[]; timeoutSeconds: number; type: "command" }
    | { path: string; port?: number; timeoutSeconds: number; type: "http" }
    | { timeoutSeconds: number; type: "container" };
  ingress: { type: "cloudflare-tunnel" } | null;
  release: {
    containerName: string;
    imageTag: string;
    kind?: "compose" | "container";
  } | null;
};

export type RuntimeInspection = {
  cpuPercent: number | null;
  deployableId: string;
  driftReasons: string[];
  driftStatus: RuntimeDriftState;
  healthStatus: RuntimeHealthState;
  ingressContainerName: string | null;
  ingressImage: string | null;
  ingressRestartCount: number | null;
  ingressStatus:
    "disabled" | "missing" | "ready" | "reconnecting" | "stopped" | "unknown";
  memoryLimitBytes: number | null;
  memoryUsageBytes: number | null;
  observedContainerName: string | null;
  observedImage: string | null;
  observedState: RuntimeObservedState;
  restartCount: number | null;
  startedAt: string | null;
};

export type ResourceReleaseSnapshot = {
  containerName: string;
  imageTag: string;
  releaseId: string;
};

export const restoreOperationPhases = [
  "queued",
  "preflight",
  "downloading_backup",
  "verifying_backup",
  "preparing_candidate",
  "restoring_candidate",
  "validating_candidate",
  "promoting",
  "verifying_promotion",
  "rolling_back",
  "retaining_previous",
  "cleaning_up",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const restoreOperationPhaseSchema = z.enum(restoreOperationPhases);
export type RestoreOperationPhase = z.infer<typeof restoreOperationPhaseSchema>;

export type ResourceOperationRequest =
  | {
      release: ResourceReleaseSnapshot;
      type: "run_job";
      job: AppJob;
      scheduledAt: string | null;
    }
  | { release: ResourceReleaseSnapshot; type: "backup" }
  | {
      release: ResourceReleaseSnapshot;
      runtime?: "workload" | "ingress";
      service?: string;
      tail: number;
      type: "capture_logs";
    }
  | {
      items: OrphanItem[];
      type: "cleanup_orphans";
      trigger?: "sync" | "manual";
      scope?: "selected";
      syncId?: string;
      retiringDeployableIds?: string[];
      retirementId?: string;
      retirementAttemptId?: string;
    }
  | {
      backupId: string;
      reason: string;
      release: ResourceReleaseSnapshot;
      type: "restore";
    }
  | {
      restoreId: string;
      release: ResourceReleaseSnapshot;
      type: "restore_cleanup";
      volumes: string[];
    }
  | {
      release: ResourceReleaseSnapshot;
      service?: string;
      type: "restart" | "start" | "stop";
    };

export type PersistedResourceOperationRequest = ResourceOperationRequest;

export type BackupDestinationResult = {
  bucket: string;
  encryption?: string;
  key: string;
  objectVersion?: string;
  provider: "gcs" | "r2" | "s3";
  region?: string;
};

export type BackupOperationResult = {
  backupClass?: "database";
  backupId: string;
  bucket: string;
  checksum: string;
  deletedBackupIds: string[];
  destinations?: BackupDestinationResult[];
  encryption: "AES256" | "aws:kms" | string;
  engine?: (typeof managedBackupEngines)[number];
  engineMajorVersion?: number;
  format?:
    | "postgres-custom"
    | "mysql-sql"
    | "mariadb-sql"
    | "mongodb-archive"
    | "redis-rdb"
    | "dragonfly-rdb"
    | "keydb-rdb"
    | "clickhouse-backup";
  key: string;
  metadataVersion?: 1;
  objectVersionId?: string;
  region?: string;
  restoreFrom?: "gcs" | "r2" | "s3";
  sizeBytes: number;
  verifiedAt: string;
  warnings: string[];
};

export function normalizeBackupOperationResult(
  result: BackupOperationResult,
): BackupOperationResult & {
  destinations: BackupDestinationResult[];
  restoreFrom: "gcs" | "r2" | "s3";
} {
  const destinations =
    result.destinations && result.destinations.length > 0
      ? result.destinations
      : [
          {
            bucket: result.bucket,
            encryption: result.encryption,
            key: result.key,
            ...(result.objectVersionId
              ? { objectVersion: result.objectVersionId }
              : {}),
            provider: "s3" as const,
            ...(result.region ? { region: result.region } : {}),
          },
        ];
  const restoreFrom = result.restoreFrom ?? "s3";
  return {
    ...result,
    destinations,
    restoreFrom,
  };
}

export const maximumBackupBytes = 20 * 1_024 * 1_024 * 1_024;

export const backupOperationResultSchema = z
  .object({
    backupId: z.string().uuid(),
    backupClass: z.literal("database").optional(),
    bucket: z.string().trim().min(1).max(255),
    checksum: z.string().regex(/^[a-f0-9]{64}$/u),
    deletedBackupIds: z.array(z.string().uuid()),
    destinations: z
      .array(
        z
          .object({
            bucket: z.string().trim().min(1).max(255),
            encryption: z.string().trim().max(128).optional(),
            key: z.string().trim().min(1).max(2_048),
            objectVersion: z.string().trim().min(1).max(1_024).optional(),
            provider: z.enum(["s3", "r2", "gcs"]),
            region: z.string().trim().min(1).max(64).optional(),
          })
          .strict(),
      )
      .optional(),
    encryption: z.string().trim().min(1).max(64),
    engine: z.enum(managedBackupEngines).optional(),
    engineMajorVersion: z.number().int().positive().max(1_000).optional(),
    format: z
      .enum([
        "postgres-custom",
        "mysql-sql",
        "mariadb-sql",
        "mongodb-archive",
        "redis-rdb",
        "dragonfly-rdb",
        "keydb-rdb",
        "clickhouse-backup",
      ])
      .optional(),
    key: z.string().trim().min(1).max(2_048),
    metadataVersion: z.literal(1).optional(),
    objectVersionId: z.string().trim().min(1).max(1_024).optional(),
    region: z.string().trim().min(1).max(64).optional(),
    restoreFrom: z.enum(["s3", "r2", "gcs"]).optional(),
    sizeBytes: z.number().int().nonnegative().max(maximumBackupBytes),
    verifiedAt: z.string().datetime(),
    warnings: z.array(z.string().max(500)),
  })
  .strict();

export const restoreVolumeSchema = z
  .object({
    logicalName: z.string().trim().min(1).max(63),
    volumeName: z.string().trim().min(1).max(255),
  })
  .strict();

export const restoreValidationSchema = z
  .object({
    databaseName: z.string().trim().min(1).max(255).nullable(),
    engine: z.enum(managedBackupEngines),
    engineMajorVersion: z.number().int().positive().max(1_000),
    healthVerified: z.boolean(),
    readable: z.boolean(),
  })
  .strict();

export const restoreOperationResultSchema = z
  .object({
    activeVolumes: z.array(restoreVolumeSchema).min(1).max(20),
    candidateCleaned: z.boolean(),
    outcome: z.enum([
      "promoted",
      "candidate_failed",
      "rolled_back",
      "rollback_failed",
    ]),
    previousVolumes: z.array(restoreVolumeSchema).max(20),
    restoredBackupId: z.string().uuid(),
    rollbackAvailableUntil: z.string().datetime().nullable(),
    validation: restoreValidationSchema.nullable(),
    verifiedAt: z.string().datetime().nullable(),
  })
  .strict();

export type RestoreOperationResult = z.infer<
  typeof restoreOperationResultSchema
>;

export const restoreCleanupResultSchema = z
  .object({
    cleanedVolumes: z.array(z.string().trim().min(1).max(255)).max(100),
    restoreId: z.string().uuid(),
    skippedVolumes: z.array(z.string().trim().min(1).max(255)).max(100),
  })
  .strict();

const cleanupOutcomeSchema = orphanItemSchema.extend({
  kind: z.enum([...orphanKinds, "network", "route", "workload"]),
});

export const serverCleanupResultSchema = z
  .object({
    cleaned: z.array(orphanItemSchema),
    skipped: z.array(cleanupOutcomeSchema),
    failures: z.array(cleanupOutcomeSchema).optional(),
    retiredDeployableIds: z.array(z.string().uuid()).optional(),
    retiredPaths: z.array(z.string()).optional(),
  })
  .strict();

export type ServerCleanupResult = z.infer<typeof serverCleanupResultSchema>;

export type ServerCleanupPlan = {
  ownedDeployableIds?: string[];
  containerNames: string[];
  deployableIds: string[];
  imageTags: string[];
  protectedDeployableIds?: string[];
  composeProjects?: string[];
  retiring?: Array<{
    deployableId: string;
    sourceId: string;
    runtimeIds: string[];
    composeProjects?: string[];
  }>;
};

export const resourceOperationResultSchema = z.union([
  appJobResultSchema,
  backupOperationResultSchema,
  serverCleanupResultSchema,
  z
    .object({
      logs: z.string().max(256 * 1_024),
      truncated: z.boolean(),
    })
    .strict(),
  restoreOperationResultSchema,
  restoreCleanupResultSchema,
  z.object({ state: z.enum(runtimeDesiredStates) }).strict(),
]);

export type ResourceOperationResult =
  | z.infer<typeof appJobResultSchema>
  | BackupOperationResult
  | ServerCleanupResult
  | { logs: string; truncated: boolean }
  | RestoreOperationResult
  | z.infer<typeof restoreCleanupResultSchema>
  | { state: RuntimeDesiredState };
