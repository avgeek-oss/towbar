import {
  cleanupOrphansScript,
  executeServerCleanup,
} from "./server-cleanup.js";
import { executeAppJob } from "./app-job.js";
import { requireOperationSource } from "./operation-source.js";
/* eslint-disable max-lines -- Resource backup and restore providers share one evidence and promotion protocol. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isNormalizedResource,
  maximumBackupBytes,
} from "@workspace/towbar-core";

import { redactSensitiveValues } from "./secrets.js";
import { SshSession } from "./ssh.js";

import type {
  BackupStorage,
  ResourceOperationExecutionContext,
  ResourceOperationExecutorResult,
  ResourceOperationHooks,
  ResourceOperationSecrets,
} from "./types.js";
import type {
  BackupDestinationResult,
  BackupOperationResult,
  BackupProvider,
  ManagedResourceType,
  NormalizedResource,
} from "@workspace/towbar-core";
import {
  executeManagedRestore,
  executeRestoreCleanup,
} from "./resource-restore.js";

type BackupEngine = ManagedResourceType;
type BackupFormat = NonNullable<BackupOperationResult["format"]>;

const createBackupScript = String.raw`
set -euo pipefail
kind="$1"
container="$2"
remote_dir="$3"
backup_path="$4"
deployable_id="$5"
install -d -m 700 "$remote_dir"
ulimit -f ${maximumBackupBytes / 512}
available="$(df -PB1 "$remote_dir" | awk 'NR==2 {print $4}')"
test "$available" -ge 1073741824
test "$(docker inspect --format '{{index .Config.Labels "towbar.managed"}}' "$container")" = true
owned="$(docker inspect --format '{{index .Config.Labels "towbar.deployable"}}' "$container")"
test "$owned" = "$deployable_id"
if test "$kind" = postgres; then
  docker exec "$container" sh -c 'exec pg_dump -U "${"$"}{POSTGRES_USER:-postgres}" -d "${"$"}{POSTGRES_DB:-postgres}" --format=custom --no-owner --no-privileges' >"$backup_path"
  test -s "$backup_path"
  docker cp "$backup_path" "$container:/tmp/towbar-backup.dump"
  docker exec "$container" pg_restore --list /tmp/towbar-backup.dump >/dev/null
  docker exec "$container" rm -f /tmp/towbar-backup.dump
  docker exec "$container" postgres --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/'
elif test "$kind" = mysql; then
  docker exec "$container" sh -c 'exec mysqldump --all-databases --single-transaction --routines --events --triggers --set-gtid-purged=OFF -u root -p"$MYSQL_ROOT_PASSWORD"' >"$backup_path"
  test -s "$backup_path"
  docker exec "$container" mysqld --version | sed -E 's/.*Ver ([0-9]+)(\..*)?.*/\1/'
elif test "$kind" = mariadb; then
  docker exec "$container" sh -c 'exec mariadb-dump --all-databases --single-transaction --routines --events -u root -p"$MYSQL_ROOT_PASSWORD"' >"$backup_path"
  test -s "$backup_path"
  docker exec "$container" sh -c 'mariadb --version' | sed -E 's/.*Distrib ([0-9]+)(\..*)?.*/\1/'
elif test "$kind" = mongodb; then
  docker exec "$container" sh -c 'exec mongodump --archive --gzip --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' >"$backup_path"
  test -s "$backup_path"
  docker exec "$container" mongod --version | awk '/db version/ {sub(/^v/, "", $3); split($3, version, "."); print version[1]; exit}'
elif test "$kind" = redis || test "$kind" = dragonfly || test "$kind" = keydb; then
  docker exec "$container" sh -c 'rm -f /tmp/towbar-backup.rdb; redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --rdb /tmp/towbar-backup.rdb >/dev/null; test -s /tmp/towbar-backup.rdb'
  if docker exec "$container" command -v redis-check-rdb >/dev/null 2>&1; then docker exec "$container" redis-check-rdb /tmp/towbar-backup.rdb >/dev/null; fi
  docker cp "$container:/tmp/towbar-backup.rdb" "$backup_path"
  docker exec "$container" rm -f /tmp/towbar-backup.rdb
  if test "$kind" = redis; then
    docker exec "$container" redis-server --version | sed -E 's/.*v=([0-9]+)(\..*)?.*/\1/'
  elif test "$kind" = keydb; then
    docker exec "$container" keydb-server --version | sed -E 's/.*v=([0-9]+)(\..*)?.*/\1/'
  else
    docker exec "$container" dragonfly --version | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 | cut -d. -f1
  fi
elif test "$kind" = clickhouse; then
  archive="towbar-$deployable_id.zip"
  docker exec "$container" rm -f "/var/lib/clickhouse/backups/$archive"
  docker exec "$container" sh -c 'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "BACKUP ALL EXCEPT DATABASES system, INFORMATION_SCHEMA, information_schema TO File('\''$1'\'')"' sh "$archive"
  docker cp "$container:/var/lib/clickhouse/backups/$archive" "$backup_path"
  docker exec "$container" rm -f "/var/lib/clickhouse/backups/$archive"
  test -s "$backup_path"
  docker exec "$container" clickhouse-server --version | awk '{for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+\./) {split($i,v,"."); print v[1]; exit}}'
else
  exit 64
fi
chmod 600 "$backup_path"
test "$(stat -c %s "$backup_path")" -le ${maximumBackupBytes}
printf 'TOWBAR_BACKUP_SIZE=%s\n' "$(stat -c %s "$backup_path")"
`;

const containerOperationScript = String.raw`
set -euo pipefail
operation="$1"
container="$2"
deployable_id="$3"
tail_lines="$4"
managed="$(docker inspect --format '{{index .Config.Labels "towbar.managed"}}' "$container")"
owned="$(docker inspect --format '{{index .Config.Labels "towbar.deployable"}}' "$container")"
test "$managed" = true
test "$owned" = "$deployable_id"
case "$operation" in
  capture_logs) docker logs --timestamps --tail "$tail_lines" "$container" 2>&1 ;;
  restart) docker restart --time 30 "$container" >/dev/null ;;
  start) docker start "$container" >/dev/null ;;
  stop) docker stop --time 30 "$container" >/dev/null ;;
  *) exit 64 ;;
esac
`;

const composeOperationScript = String.raw`
set -euo pipefail
operation="$1"
project="$2"
deployable_id="$3"
tail_lines="$4"
service="$5"
filters=(--filter "label=com.docker.compose.project=$project")
if test -n "$service"; then
  filters+=(--filter "label=com.docker.compose.service=$service")
fi
mapfile -t containers < <(docker ps -a "${"$"}{filters[@]}" --format '{{.Names}}' | sort)
test "${"#"}{containers[@]}" -gt 0
for container in "${"$"}{containers[@]}"; do
  test "$(docker inspect --format '{{index .Config.Labels "towbar.managed"}}' "$container")" = true
  test "$(docker inspect --format '{{index .Config.Labels "towbar.deployable"}}' "$container")" = "$deployable_id"
done
case "$operation" in
  capture_logs)
    for container in "${"$"}{containers[@]}"; do
      printf '==> %s <==\n' "$container"
      docker logs --timestamps --tail "$tail_lines" "$container" 2>&1
    done
    ;;
  restart) docker restart --time 30 "${"$"}{containers[@]}" >/dev/null ;;
  start) docker start "${"$"}{containers[@]}" >/dev/null ;;
  stop) docker stop --time 30 "${"$"}{containers[@]}" >/dev/null ;;
  *) exit 64 ;;
esac
`;

const ingressLogsScript = String.raw`
set -euo pipefail
container="$1"
deployable_id="$2"
tail_lines="$3"
test "$(docker inspect --format '{{index .Config.Labels "towbar.managed"}}' "$container")" = true
test "$(docker inspect --format '{{index .Config.Labels "towbar.ingress"}}' "$container")" = cloudflare-tunnel
test "$(docker inspect --format '{{index .Config.Labels "towbar.app"}}' "$container")" = "$deployable_id"
docker logs --timestamps --tail "$tail_lines" "$container" 2>&1
`;

export async function executeResourceOperation(input: {
  context: ResourceOperationExecutionContext;
  hooks?: ResourceOperationHooks;
  secrets: ResourceOperationSecrets;
  storage?: BackupStorage;
  storages?: Partial<Record<BackupProvider, BackupStorage>>;
  signal?: AbortSignal;
}): Promise<ResourceOperationExecutorResult> {
  const { context, secrets, signal } = input;
  const session = await SshSession.connect({
    login: secrets.login,
    server: context.server,
    trustedHostKeys: context.trustedHostKeys,
  });
  const localDirectory = await mkdtemp(
    path.join(tmpdir(), "towbar-resource-operation-"),
  );
  const remoteDirectory = `/tmp/towbar-operation-${context.operationId}`;
  try {
    if (context.request.type === "cleanup_orphans") {
      return await executeServerCleanup({
        session,
        request: context.request,
        expected: context.cleanupExpected,
        signal,
      });
    }

    if (context.request.type === "restore") {
      return await executeManagedRestore({
        ...input,
        hooks: input.hooks ?? {},
        localDirectory,
        remoteDirectory,
        session,
      });
    }
    if (context.request.type === "restore_cleanup") {
      return await executeRestoreCleanup({
        context,
        session,
        signal,
      });
    }

    if (context.request.type === "run_job") {
      return await executeAppJob({
        ...input,
        session,
        localDirectory,
        remoteDirectory,
      });
    }

    const deployable = context.deployable;
    const release = context.currentRelease;
    if (!deployable || !context.deployableId || !release) {
      throw new Error("A current release is required for this operation");
    }
    if (context.request.type === "backup") {
      if (!isNormalizedResource(deployable)) {
        throw new Error("Managed backups require a database Resource");
      }
      return await createBackup({
        ...input,
        deployable,
        localDirectory,
        remoteDirectory,
        session,
      });
    }
    const ingressLogCapture =
      context.request.type === "capture_logs" &&
      context.request.runtime === "ingress";
    const logTail =
      context.request.type === "capture_logs"
        ? String(context.request.tail)
        : "0";
    const { stdout } = await session.run(
      ingressLogCapture
        ? ingressLogsScript
        : deployable.kind === "compose"
          ? composeOperationScript
          : containerOperationScript,
      ingressLogCapture
        ? [
            `towbar-cloudflared-${context.deployableId}`,
            context.deployableId,
            logTail,
          ]
        : [
            context.request.type,
            release.containerName,
            context.deployableId,
            logTail,
            "service" in context.request ? (context.request.service ?? "") : "",
          ],
      { signal, timeoutMs: 2 * 60_000 },
    );
    if (context.request.type === "capture_logs") {
      const redacted = redactSensitiveValues(stdout, secrets.sensitiveValues);
      const limit = 256 * 1_024;
      return {
        logs: redacted.slice(-limit),
        truncated: redacted.length > limit,
      };
    }
    return {
      state: context.request.type === "stop" ? "stopped" : "running",
    };
  } finally {
    await session
      .run('rm -rf "$1"', [remoteDirectory], { timeoutMs: 30_000 })
      .catch(() => undefined);
    await session.close().catch(() => undefined);
    await rm(localDirectory, { force: true, recursive: true });
  }
}

async function createBackup(input: {
  context: ResourceOperationExecutionContext;
  deployable: NormalizedResource;
  localDirectory: string;
  remoteDirectory: string;
  secrets: ResourceOperationSecrets;
  session: SshSession;
  signal?: AbortSignal;
  storage?: BackupStorage;
  storages?: Partial<Record<BackupProvider, BackupStorage>>;
}) {
  const backup = input.deployable.backup;
  const release = input.context.currentRelease;
  if (!backup || !release) {
    throw new Error("A current release is required for this operation");
  }
  const engine: BackupEngine = input.deployable.kind;

  const { availableStorages, configuredProviders } = resolveBackupStorages(
    backup,
    input.storages,
    input.storage,
    input.secrets.namedStorage,
  );

  const extension = backupExtension(engine);
  const localPath = path.join(input.localDirectory, `backup.${extension}`);
  const remotePath = `${input.remoteDirectory}/backup.${extension}`;
  const { stdout } = await input.session.run(
    createBackupScript,
    [
      input.deployable.kind,
      release.containerName,
      input.remoteDirectory,
      remotePath,
      input.context.deployableId!,
    ],
    { signal: input.signal, timeoutMs: 30 * 60_000 },
  );
  const backupSize = Number(/^TOWBAR_BACKUP_SIZE=(\d+)$/mu.exec(stdout)?.[1]);
  const engineMajorVersion = Number(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+$/u.test(line))
      .at(-1),
  );
  if (!Number.isSafeInteger(engineMajorVersion) || engineMajorVersion <= 0) {
    throw new Error("Backup engine major version could not be determined");
  }
  if (
    !Number.isSafeInteger(backupSize) ||
    backupSize <= 0 ||
    backupSize > maximumBackupBytes
  )
    throw new Error("Backup size could not be determined safely");
  const localCapacity = await statfs(input.localDirectory);
  const localAvailable = localCapacity.bavail * localCapacity.bsize;
  if (localAvailable < backupSize + 256 * 1_024 * 1_024)
    throw new Error(
      "The control plane does not have enough staging capacity for this backup",
    );
  await input.session.download(remotePath, localPath, {
    signal: input.signal,
    timeoutMs: 30 * 60_000,
  });
  const createdAt = new Date();
  const timestamp = createdAt.toISOString().replaceAll(":", "-");
  const sourceId = requireOperationSource(input.context.sourceId);
  const checksum = await sha256File(localPath);
  const metadata = await stat(localPath);
  if (metadata.size !== backupSize)
    throw new Error(
      "Downloaded backup size does not match the server artifact",
    );
  if (metadata.size > maximumBackupBytes) {
    throw new Error("Backup exceeds Towbar's 20 GiB safety limit");
  }
  const format = backupFormat(engine);

  const destinationResults: BackupDestinationResult[] = [];

  for (const provider of configuredProviders) {
    const storage = availableStorages[provider]!;
    const config = getDestinationUploadParams(
      provider,
      backup,
      sourceId,
      input.context.operationId,
      timestamp,
      extension,
      input.secrets.aws?.region,
      input.secrets.namedStorage,
    );
    const result = await uploadAndVerifyDestination({
      checksum,
      config,
      engine,
      engineMajorVersion,
      expectedS3Encryption:
        provider === "s3" && backup.integration
          ? "AES256"
          : backup.s3?.encryption,
      format,
      localPath,
      provider,
      sizeBytes: metadata.size,
      signal: input.signal,
      storage,
    });
    destinationResults.push(result);
  }

  const { deletedBackupIds, warnings } = await cleanupRetentionBackups(
    input.context.retentionBackups,
    configuredProviders,
    availableStorages,
  );

  return buildBackupResult({
    backup,
    checksum,
    deletedBackupIds,
    destinationResults,
    engine,
    engineMajorVersion,
    format,
    operationId: input.context.operationId,
    region: input.secrets.aws?.region,
    sizeBytes: metadata.size,
    warnings,
  });
}

function resolveBackupStorages(
  backup: NonNullable<NormalizedResource["backup"]>,
  storages?: Partial<Record<BackupProvider, BackupStorage>>,
  singleStorage?: BackupStorage,
  namedStorage?: ResourceOperationSecrets["namedStorage"],
) {
  const namedProvider = namedStorage?.provider;
  const availableStorages: Partial<Record<BackupProvider, BackupStorage>> = {
    ...storages,
    ...(singleStorage && namedProvider
      ? { [namedProvider]: singleStorage }
      : singleStorage && backup.restoreFrom
        ? { [backup.restoreFrom]: singleStorage }
        : {}),
  };

  const configuredProviders: BackupProvider[] = namedProvider
    ? [namedProvider]
    : [];
  if (!namedProvider && backup.s3) configuredProviders.push("s3");
  if (!namedProvider && backup.gcs) configuredProviders.push("gcs");

  if (configuredProviders.length === 0) {
    throw new Error(
      "Backup storage configuration is incomplete: no destination configured",
    );
  }

  for (const provider of configuredProviders) {
    if (!availableStorages[provider]) {
      throw new Error(
        `Backup storage configuration is incomplete: missing storage for ${provider}`,
      );
    }
  }

  return { availableStorages, configuredProviders };
}

// eslint-disable-next-line complexity -- Provider-specific object metadata is normalized at this single storage boundary.
function getDestinationUploadParams(
  provider: BackupProvider,
  backup: NonNullable<NormalizedResource["backup"]>,
  sourceId: string,
  operationId: string,
  timestamp: string,
  extension: string,
  defaultAwsRegion?: string,
  namedStorage?: ResourceOperationSecrets["namedStorage"],
) {
  const fileKey = `${timestamp}.${extension}`;
  if (backup.integration) {
    if (!namedStorage || namedStorage.provider !== provider)
      throw new Error("Named backup integration is unavailable");
    if (namedStorage.provider === "s3" || namedStorage.provider === "r2") {
      const configuration = namedStorage.configuration;
      if (!configuration.bucket)
        throw new Error(
          "Object storage integration must configure a default bucket",
        );
      return {
        bucket: configuration.bucket,
        encryption: namedStorage.provider === "s3" ? "AES256" : "R2-managed",
        key: [configuration.prefix || "towbar", sourceId, operationId, fileKey]
          .filter(Boolean)
          .join("/"),
        kmsKeyId: undefined,
        region: configuration.region,
      };
    }
    if (namedStorage.provider === "gcs") {
      if (!namedStorage.configuration.bucket)
        throw new Error("GCS integration must configure a default bucket");
      return {
        bucket: namedStorage.configuration.bucket,
        encryption: "Google-managed",
        key: [
          namedStorage.configuration.prefix || "towbar",
          sourceId,
          operationId,
          fileKey,
        ]
          .filter(Boolean)
          .join("/"),
        kmsKeyId: undefined,
        region: undefined,
      };
    }
    throw new Error("Named backup integration provider is unsupported");
  }
  if (provider === "s3") {
    const s3Prefix = backup.s3?.prefix || "towbar";
    return {
      bucket: backup.s3?.bucket ?? "",
      encryption: backup.s3?.encryption ?? "AES256",
      key: [s3Prefix, sourceId, operationId, fileKey].filter(Boolean).join("/"),
      kmsKeyId: backup.s3?.kmsKeyId,
      region: backup.s3?.region ?? defaultAwsRegion,
    };
  }
  if (provider === "gcs") {
    const gcsPrefix = backup.gcs?.prefix || "towbar";
    return {
      bucket: backup.gcs?.bucket ?? "",
      encryption: "Google-managed",
      key: [gcsPrefix, sourceId, operationId, fileKey]
        .filter(Boolean)
        .join("/"),
      kmsKeyId: undefined,
      region: backup.gcs?.region,
    };
  }
  throw new Error("Backup provider is unsupported");
}

async function uploadAndVerifyDestination(params: {
  checksum: string;
  config: ReturnType<typeof getDestinationUploadParams>;
  engine: BackupEngine;
  engineMajorVersion: number;
  expectedS3Encryption?: string;
  format: BackupFormat;
  localPath: string;
  provider: BackupProvider;
  signal?: AbortSignal;
  sizeBytes: number;
  storage: BackupStorage;
}): Promise<BackupDestinationResult> {
  const { config, storage } = params;
  const upload = await storage.upload({
    bucket: config.bucket,
    encryption: config.encryption,
    key: config.key,
    ...(config.kmsKeyId ? { kmsKeyId: config.kmsKeyId } : {}),
    localPath: params.localPath,
    metadata: {
      "towbar-checksum": params.checksum,
      "towbar-engine": params.engine,
      "towbar-engine-major-version": String(params.engineMajorVersion),
      "towbar-format": params.format,
      "towbar-metadata-version": "1",
    },
    signal: params.signal,
    sizeBytes: params.sizeBytes,
  });

  const verified = await storage.headObject({
    bucket: config.bucket,
    key: config.key,
    ...(upload.versionId ? { versionId: upload.versionId } : {}),
  });

  if (
    !verified.exists ||
    (!verified.encryption && params.provider !== "r2") ||
    verified.checksum !== params.checksum ||
    verified.sizeBytes !== params.sizeBytes ||
    verified.engine !== params.engine ||
    verified.engineMajorVersion !== params.engineMajorVersion ||
    verified.format !== params.format ||
    verified.metadataVersion !== 1 ||
    (params.provider === "s3" &&
      verified.encryption !== params.expectedS3Encryption)
  ) {
    throw new Error(
      `Uploaded backup to ${params.provider} failed restore-readiness verification`,
    );
  }

  return {
    bucket: config.bucket,
    encryption: verified.encryption ?? config.encryption,
    key: config.key,
    ...(upload.versionId ? { objectVersion: upload.versionId } : {}),
    provider: params.provider,
    ...(config.region ? { region: config.region } : {}),
  };
}

async function cleanupRetentionBackups(
  retentionBackups: readonly {
    bucket: string;
    destinations?: readonly BackupDestinationResult[];
    id: string;
    key: string;
  }[],
  configuredProviders: readonly BackupProvider[],
  availableStorages: Partial<Record<BackupProvider, BackupStorage>>,
) {
  const deletedBackupIds: string[] = [];
  const warnings: string[] = [];
  for (const candidate of retentionBackups) {
    let anySucceeded = false;
    let deleteFailed = false;
    const destinations =
      candidate.destinations && candidate.destinations.length > 0
        ? candidate.destinations
        : configuredProviders.map((provider) => ({
            bucket: candidate.bucket,
            key: candidate.key,
            provider,
          }));

    for (const dest of destinations) {
      const storage = availableStorages[dest.provider];
      if (!storage) {
        deleteFailed = true;
        continue;
      }
      try {
        await storage.deleteObject({
          bucket: dest.bucket,
          key: dest.key,
          ...("objectVersion" in dest && dest.objectVersion
            ? { versionId: dest.objectVersion }
            : {}),
        });
        anySucceeded = true;
      } catch {
        deleteFailed = true;
      }
    }

    if (anySucceeded && !deleteFailed) {
      deletedBackupIds.push(candidate.id);
    } else {
      warnings.push(
        `Retention cleanup could not delete backup ${candidate.id} from every destination; it will be retried`,
      );
    }
  }
  return { deletedBackupIds, warnings };
}

function buildBackupResult(params: {
  backup: NonNullable<NormalizedResource["backup"]>;
  checksum: string;
  deletedBackupIds: string[];
  destinationResults: BackupDestinationResult[];
  engine: BackupEngine;
  engineMajorVersion: number;
  format: BackupFormat;
  operationId: string;
  region?: string;
  sizeBytes: number;
  warnings: string[];
}): ResourceOperationExecutorResult {
  const { backup, destinationResults } = params;
  const primaryDest =
    destinationResults.find((dest) => dest.provider === backup.restoreFrom) ??
    destinationResults[0]!;
  const region = primaryDest.region ?? params.region;

  return {
    backupId: params.operationId,
    bucket: primaryDest.bucket,
    checksum: params.checksum,
    deletedBackupIds: params.deletedBackupIds,
    destinations: destinationResults,
    encryption:
      primaryDest.encryption ??
      ((backup.s3?.encryption ?? "AES256") as "AES256" | "aws:kms"),
    engine: params.engine,
    engineMajorVersion: params.engineMajorVersion,
    format: params.format,
    key: primaryDest.key,
    metadataVersion: 1,
    ...(primaryDest.objectVersion
      ? { objectVersionId: primaryDest.objectVersion }
      : {}),
    ...(region ? { region } : {}),
    restoreFrom: primaryDest.provider,
    sizeBytes: params.sizeBytes,
    verifiedAt: new Date().toISOString(),
    warnings: params.warnings,
  };
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function backupFormat(engine: BackupEngine): BackupFormat {
  return {
    clickhouse: "clickhouse-backup",
    dragonfly: "dragonfly-rdb",
    keydb: "keydb-rdb",
    mariadb: "mariadb-sql",
    mongodb: "mongodb-archive",
    mysql: "mysql-sql",
    postgres: "postgres-custom",
    redis: "redis-rdb",
  }[engine] as BackupFormat;
}

function backupExtension(engine: BackupEngine) {
  return {
    clickhouse: "zip",
    dragonfly: "rdb",
    keydb: "rdb",
    mariadb: "sql",
    mongodb: "archive.gz",
    mysql: "sql",
    postgres: "dump",
    redis: "rdb",
  }[engine];
}

export const resourceOperationScripts = {
  cleanupOrphans: cleanupOrphansScript,
  containerOperation: containerOperationScript,
  createBackup: createBackupScript,
  ingressLogs: ingressLogsScript,
} as const;

export const resourceOperationInternal = {
  buildBackupResult,
  cleanupRetentionBackups,
  uploadAndVerifyDestination,
} as const;
