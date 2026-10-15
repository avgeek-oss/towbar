import { tlsSchema } from "@workspace/towbar-contracts/tls";
import type {
  NormalizedApp,
  NormalizedComposeWorkload,
  NormalizedDeployable,
  NormalizedDeploymentHook,
  NormalizedDeploymentManifest,
  NormalizedHealth,
  NormalizedResource,
  NormalizedServer,
} from "@workspace/towbar-contracts/deployables";
export type {
  NormalizedServer,
  NormalizedDeploymentHook,
  NormalizedApp,
  NormalizedResource,
  NormalizedComposeWorkload,
  NormalizedDeployable,
  NormalizedDeploymentManifest,
  NormalizedHealth,
  AppVolume,
} from "@workspace/towbar-contracts/deployables";
import {
  type ConfigurationFile,
  configurationFileSchema,
  validateConfigurationMounts,
} from "./container-configuration.js";
import { logPolicySchema } from "./logs.js";
import { analyticsConfigSchema } from "./analytics.js";
import { appJobSchema } from "./app-jobs.js";
import {
  manifestNotificationsSchema,
  normalizeManifestNotifications,
} from "./notifications.js";
/* eslint-disable max-lines -- Versioned manifest schemas and normalization share validation rules. */

import { isIP } from "node:net";
import path from "node:path";

import { Cron } from "croner";
import { z } from "zod";
import { escape } from "minimatch";

import {
  autoDeploySchema as appAutoDeploySchema,
  deploymentInputGroupsSchema,
} from "./deployment-input-schema.js";

import {
  canonicalIp,
  findDuplicates,
  isValidBranchName,
  normalizeDomain,
  normalizeRepositoryPath,
} from "./manifest-values.js";
import {
  type AppDeployment,
  appDeploymentSchema,
  buildServerSelectionSchema,
  composeWorkloadSchema,
  externalSecretsSchema,
  ingressSchema,
  integrationReferenceSchema,
  rolloutStrategySchema,
} from "./platform-expansion.js";

import {
  type ResourceType,
  managedResourceCompatibility,
  managedResourceTypes,
} from "./datastore-engines.js";
export {
  managedResourceCompatibility,
  managedResourceTypes,
} from "./datastore-engines.js";
export type {
  DeployableKind,
  ManagedResourceType,
  ResourceType,
} from "./datastore-engines.js";

export {
  digestValue,
  normalizeDomain,
  normalizeRepositoryPath,
  stableStringify,
  validateSecretObject,
  validateServerLoginSecret,
} from "./manifest-values.js";

const appIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const dockerNetworkPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const dockerMemoryPattern = /^\d+(?:\.\d+)?[bkmg]$/i;
const dockerVolumePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const dockerImagePattern = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/;
const s3BucketPattern =
  /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const gcsBucketPattern =
  /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const sshUsernamePattern = /^[a-z_][a-z0-9_-]{0,31}$/i;
const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isValidBranchName, "Expected a valid Git branch name");
const hookArgumentSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => !value.includes("\0"),
    "Hook arguments cannot contain null bytes",
  );

const repositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .superRefine((value, context) => {
    try {
      normalizeRepositoryPath(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Invalid repository path",
      });
    }
  });

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .superRefine((value, context) => {
    try {
      normalizeDomain(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid domain",
      });
    }
  });

export const ipAddressSchema = z
  .string()
  .trim()
  .refine((value) => isIP(value) !== 0, "Expected an IPv4 or IPv6 address");

const serverReferenceSchema = ipAddressSchema;

const redirectSchema = z
  .object({
    host: domainSchema,
    status: z.union([z.literal(301), z.literal(302)]).optional(),
  })
  .strict();

export const serverConfigurationSchema = z
  .object({
    buildConcurrency: z.number().int().min(1).max(16).optional(),
    previewBuildConcurrency: z.number().int().min(1).max(4).optional(),
    hostLogCollection: z.boolean().optional(),
    ip: ipAddressSchema,
    ssh: z
      .object({
        host: ipAddressSchema.optional(),
        username: z.string().trim().regex(sshUsernamePattern),
        port: z.number().int().min(1).max(65_535).optional(),
      })
      .strict(),
  })
  .strict();

const deploymentHookSchema = z
  .object({
    command: z.array(hookArgumentSchema).min(1).max(64),
    entrypoint: hookArgumentSchema.optional(),
    timeoutSeconds: z.number().int().min(5).max(1_800).optional(),
  })
  .strict();

const containerResourcesSchema = z
  .object({
    cpus: z.number().positive().max(128),
    memory: z.string().trim().regex(dockerMemoryPattern),
  })
  .strict();

const dockerVolumeSchema = z
  .object({
    name: z.string().trim().regex(dockerVolumePattern),
    mountPath: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          value.startsWith("/") &&
          !value.split("/").some((segment) => segment === ".."),
        "Expected an absolute container path without parent traversal",
      ),
  })
  .strict();

export const appVolumeSchema = dockerVolumeSchema
  .extend({
    initialData: z.enum(["image", "previous-container"]).optional(),
  })
  .superRefine((volume, context) => {
    const value = volume.mountPath;
    if (
      !/^\/[a-zA-Z0-9_./-]+$/.test(value) ||
      value === "/" ||
      value.endsWith("/") ||
      value
        .split("/")
        .slice(1)
        .some((part) => !part || part === ".") ||
      ["/proc", "/sys", "/dev", "/etc", "/run", "/var/run"].some(
        (root) => value === root || value.startsWith(`${root}/`),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["mountPath"],
        message:
          "Use a canonical application data directory, such as /app/uploads or /data",
      });
    }
  });

const resourceHealthSchema = z
  .object({
    type: z.enum(["command", "container", "http"]),
    port: z.number().int().min(1).max(65_535).optional(),
    publicPath: z.string().trim().startsWith("/").max(1_024).optional(),
    path: z.string().trim().startsWith("/").max(1_024).optional(),
    command: z.array(hookArgumentSchema).min(1).max(64).optional(),
    timeoutSeconds: z.number().int().min(5).max(600).optional(),
  })
  .strict()
  .superRefine((health, context) => {
    if (health.type === "http" && !health.path) {
      context.addIssue({
        code: "custom",
        message: "HTTP health checks require a path",
        path: ["path"],
      });
    }
    if (health.type === "command" && !health.command) {
      context.addIssue({
        code: "custom",
        message: "Command health checks require a command",
        path: ["command"],
      });
    }
    if (health.type !== "http" && (health.path || health.port)) {
      context.addIssue({
        code: "custom",
        message: "Only HTTP health checks accept a path",
        path: ["path"],
      });
    }
    if (health.type !== "command" && health.command) {
      context.addIssue({
        code: "custom",
        message: "Only command health checks accept a command",
        path: ["command"],
      });
    }
  });

const resourceAccessSchema = z
  .object({
    sshTunnel: z
      .object({
        hostPort: z.number().int().min(1_024).max(65_535),
      })
      .strict(),
  })
  .strict();

const backupPrefixSchema = z
  .string()
  .trim()
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").some((segment) => segment === ".."),
    "Backup prefix must be relative and cannot contain parent traversal",
  )
  .optional();

export const backupProviders = ["s3", "r2", "gcs"] as const;
export type BackupProvider = (typeof backupProviders)[number];
const legacyBackupProviders = ["s3", "gcs"] as const;

const resourceBackupS3Schema = z
  .object({
    bucket: z.string().trim().regex(s3BucketPattern),
    encryption: z.enum(["AES256", "aws:kms"]).optional(),
    kmsKeyId: z.string().trim().min(1).max(2_048).optional(),
    prefix: backupPrefixSchema,
    region: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((s3, context) => {
    if (s3.encryption === "aws:kms" && !s3.kmsKeyId) {
      context.addIssue({
        code: "custom",
        message: "AWS KMS backup encryption requires kmsKeyId",
        path: ["kmsKeyId"],
      });
    }
    if (s3.encryption !== "aws:kms" && s3.kmsKeyId) {
      context.addIssue({
        code: "custom",
        message: "kmsKeyId is only valid with aws:kms encryption",
        path: ["kmsKeyId"],
      });
    }
  });

const resourceBackupGcsSchema = z
  .object({
    bucket: z.string().trim().regex(gcsBucketPattern),
    prefix: backupPrefixSchema,
    region: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const resourceBackupSchema = z
  .object({
    integration: integrationReferenceSchema.optional(),
    gcs: resourceBackupGcsSchema.optional(),
    restoreFrom: z.enum(legacyBackupProviders).optional(),
    retention: z
      .object({ keepLast: z.number().int().min(1).max(100).optional() })
      .strict()
      .optional(),
    s3: resourceBackupS3Schema.optional(),
    schedule: z
      .object({
        cron: z.string().trim().min(1).max(120),
        timezone: z.literal("UTC").optional(),
      })
      .strict()
      .superRefine((schedule, context) => {
        try {
          validateBackupCron(schedule.cron);
        } catch (error) {
          context.addIssue({
            code: "custom",
            message:
              error instanceof Error
                ? error.message
                : "Invalid backup cron expression",
            path: ["cron"],
          });
        }
      })
      .optional(),
  })
  .strict()
  .superRefine((backup, context) => {
    const destinations = (
      [backup.s3 && "s3", backup.gcs && "gcs"] as const
    ).filter((value): value is (typeof legacyBackupProviders)[number] =>
      Boolean(value),
    );
    if (backup.integration && destinations.length > 0) {
      context.addIssue({
        code: "custom",
        message:
          "A named backup integration cannot be combined with legacy provider destinations",
        path: ["integration"],
      });
    }
    if (!backup.integration && destinations.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A named backup integration is required",
        path: [],
      });
    }
    if (backup.integration && backup.restoreFrom) {
      context.addIssue({
        code: "custom",
        message: "restoreFrom is derived from the named backup integration",
        path: ["restoreFrom"],
      });
    }
    if (!backup.integration && destinations.length > 1 && !backup.restoreFrom) {
      context.addIssue({
        code: "custom",
        message:
          "restoreFrom is required when multiple backup destinations are declared",
        path: ["restoreFrom"],
      });
    }
    if (
      !backup.integration &&
      backup.restoreFrom &&
      !destinations.includes(backup.restoreFrom)
    ) {
      context.addIssue({
        code: "custom",
        message: `restoreFrom '${backup.restoreFrom}' must reference a declared backup destination`,
        path: ["restoreFrom"],
      });
    }
  });

export const appSchema = z
  .object({
    analytics: analyticsConfigSchema.optional(),
    logs: logPolicySchema.optional(),
    jobs: z.array(appJobSchema).max(20).optional(),
    notifications: manifestNotificationsSchema.optional(),
    autoDeploy: appAutoDeploySchema.optional(),
    vulnerabilityScanning: z.boolean().optional(),
    id: z.string().trim().regex(appIdPattern),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    server: serverReferenceSchema,
    deployment: appDeploymentSchema.optional(),
    dockerfile: repositoryPathSchema.optional(),
    context: repositoryPathSchema.optional(),
    buildServer: buildServerSelectionSchema.nullable().optional(),
    rollout: rolloutStrategySchema.optional(),
    externalSecrets: externalSecretsSchema.optional(),
    ingress: ingressSchema.optional(),
    container: z
      .object({
        configFiles: z.array(configurationFileSchema).max(50).optional(),
        command: z.array(hookArgumentSchema).min(1).max(64).optional(),
        entrypoint: z
          .string()
          .max(4_096)
          .refine(
            (value) => !value.includes("\0"),
            "Entrypoints cannot contain null bytes",
          )
          .optional(),
        hostLogs: z
          .object({ dockerJsonFiles: z.literal(true) })
          .strict()
          .optional(),
        network: z.string().trim().regex(dockerNetworkPattern).optional(),
        networkAlias: z.string().trim().regex(appIdPattern).optional(),
        port: z.number().int().min(1).max(65_535),
        volumes: z.array(appVolumeSchema).max(20).optional(),
        resources: containerResourcesSchema.optional(),
      })
      .strict(),
    health: z
      .union([
        resourceHealthSchema,
        z
          .object({
            type: z.literal("http").optional(),
            port: z.number().int().min(1).max(65_535).optional(),
            publicPath: z.string().trim().startsWith("/").max(1_024).optional(),
            path: z.string().trim().startsWith("/").max(1_024),
            timeoutSeconds: z.number().int().min(5).max(600).optional(),
          })
          .strict(),
      ])
      .optional(),
    hooks: z
      .object({
        postDeploy: deploymentHookSchema.optional(),
        preDeploy: deploymentHookSchema.optional(),
      })
      .strict()
      .refine((hooks) => hooks.preDeploy || hooks.postDeploy, {
        message: "At least one deployment hook is required",
      })
      .optional(),
    domains: z
      .object({
        primary: domainSchema,
        redirects: z.array(redirectSchema).max(20).optional(),
      })
      .strict()
      .optional(),
    tls: tlsSchema.optional(),
    preview: z
      .object({
        domain: domainSchema,
        enabled: z.literal(true),
        ttlHours: z.number().int().min(1).max(720).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  // eslint-disable-next-line complexity -- The refinement is a declarative list of independent manifest invariants.
  .superRefine((app, context) => {
    validateConfigurationMounts(app.container, context);
    validatePublicHealth(app, context);
    if (
      (app.rollout?.type ?? "rolling") === "rolling" &&
      (app.health?.type === "command" ||
        app.health?.type === "container" ||
        (app.health?.port && app.health.port !== app.container.port))
    )
      context.addIssue({
        code: "custom",
        path: ["health"],
        message: "Rolling deployments require HTTP health on the service port",
      });
    if (app.container.hostLogs) {
      if (!app.container.resources || !app.container.volumes?.length)
        context.addIssue({
          code: "custom",
          path: ["container", "hostLogs"],
          message:
            "Host log collectors require CPU/memory limits and persistent named storage",
        });
      if (app.rollout?.type !== "recreate" || !app.rollout.maintenanceMode)
        context.addIssue({
          code: "custom",
          path: ["rollout"],
          message:
            "Host log collectors require recreate with maintenance mode to keep one writer per buffer volume",
        });
      if (app.preview)
        context.addIssue({
          code: "custom",
          path: ["preview"],
          message: "Host log collectors cannot enable Preview deployments",
        });
      const logPath = "/var/lib/docker/containers";
      if (
        app.container.volumes?.some(
          (volume) =>
            volume.mountPath === logPath ||
            volume.mountPath.startsWith(`${logPath}/`) ||
            logPath.startsWith(`${volume.mountPath}/`),
        )
      )
        context.addIssue({
          code: "custom",
          path: ["container", "volumes"],
          message: "Named storage cannot overlap the read-only host log mount",
        });
    }
    if (app.analytics && !app.domains) {
      context.addIssue({
        code: "custom",
        path: ["analytics"],
        message: "Analytics requires a public service domain",
      });
    }
    if (!app.deployment && !app.dockerfile) {
      context.addIssue({
        code: "custom",
        path: ["deployment"],
        message: "Declare an explicit deployment type",
      });
    }
    if (app.deployment && (app.dockerfile || app.context)) {
      context.addIssue({
        code: "custom",
        path: ["deployment"],
        message:
          "Deployment-specific fields belong inside deployment; do not combine them with legacy dockerfile/context fields",
      });
    }
    if (app.deployment?.type === "image" && app.buildServer) {
      context.addIssue({
        code: "custom",
        path: ["buildServer"],
        message: "Prebuilt image deployments do not use a build server",
      });
    }
    findDuplicates((app.jobs ?? []).map((job) => job.name)).forEach((name) =>
      context.addIssue({
        code: "custom",
        path: ["jobs"],
        message: `Job name '${name}' is declared more than once`,
      }),
    );
    const volumes = app.container.volumes ?? [];
    for (const [index, volume] of volumes.entries()) {
      if (
        volumes
          .slice(0, index)
          .some(
            (other) =>
              other.name === volume.name ||
              other.mountPath === volume.mountPath ||
              other.mountPath.startsWith(`${volume.mountPath}/`) ||
              volume.mountPath.startsWith(`${other.mountPath}/`),
          )
      ) {
        context.addIssue({
          code: "custom",
          path: ["container", "volumes", index],
          message:
            "Volume names must be unique and mount paths must not overlap",
        });
      }
    }
    const dockerfileDeployment =
      app.deployment?.type === "dockerfile"
        ? app.deployment
        : app.dockerfile
          ? {
              type: "dockerfile" as const,
              context: app.context ?? ".",
              dockerfile: app.dockerfile,
              timeoutSeconds: 2_700,
            }
          : undefined;
    if (dockerfileDeployment) {
      let normalizedContext: string;
      let normalizedDockerfile: string;
      try {
        normalizedContext = normalizeRepositoryPath(
          dockerfileDeployment.context,
        );
        normalizedDockerfile = normalizeRepositoryPath(
          dockerfileDeployment.dockerfile,
        );
      } catch {
        // The field-level validators already recorded the precise path issue.
        return;
      }
      const relativeDockerfile = path.posix.relative(
        normalizedContext,
        normalizedDockerfile,
      );
      if (
        relativeDockerfile === ".." ||
        relativeDockerfile.startsWith("../") ||
        path.posix.isAbsolute(relativeDockerfile)
      ) {
        context.addIssue({
          code: "custom",
          message: "Dockerfile must be inside the declared build context",
          path: app.deployment ? ["deployment", "dockerfile"] : ["dockerfile"],
        });
      }
    }

    if (
      app.rollout?.type === "rolling" &&
      (app.container.volumes?.length ?? 0) > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["rollout"],
        message:
          "Rolling deployment is unavailable for apps with single-writer managed volumes; use recreate with an impact reason",
      });
    }
    if (app.rollout?.type === "rolling" && app.container.networkAlias) {
      context.addIssue({
        code: "custom",
        path: ["rollout"],
        message:
          "Rolling deployment is unavailable for singleton network aliases; use recreate with an impact reason",
      });
    }
    if (
      app.rollout?.type === "recreate" &&
      ((app.container.volumes?.length ?? 0) > 0 ||
        Boolean(app.container.networkAlias)) &&
      !app.rollout.maintenanceMode
    ) {
      context.addIssue({
        code: "custom",
        path: ["rollout", "maintenanceMode"],
        message:
          "Apps with single-writer volumes or singleton network aliases must enable maintenance mode so the previous release stops before replacement",
      });
    }
    if (app.container.networkAlias && !app.container.network) {
      context.addIssue({
        code: "custom",
        message: "A network alias requires a Docker network",
        path: ["container", "networkAlias"],
      });
    }
    if (app.container.networkAlias && app.preview) {
      context.addIssue({
        code: "custom",
        message:
          "Apps with a stable network alias cannot enable Preview deployments",
        path: ["preview"],
      });
    }
    if (app.tls && !app.domains) {
      context.addIssue({
        code: "custom",
        message: "TLS configuration requires a primary domain",
        path: ["tls"],
      });
    }
    if (app.ingress?.type === "cloudflare-tunnel" && !app.domains) {
      context.addIssue({
        code: "custom",
        message: "Cloudflare Tunnel ingress requires a primary domain",
        path: ["ingress"],
      });
    }
    if (app.preview && !app.domains) {
      context.addIssue({
        code: "custom",
        message:
          "Preview deployments require production domains and TLS configuration",
        path: ["preview", "domain"],
      });
    }
    if (app.preview && !app.tls) {
      context.addIssue({
        code: "custom",
        message: "Preview deployments require TLS configuration",
        path: ["preview", "domain"],
      });
    }
  });

function validateResourceBackupSupport(
  resource: {
    backup?: unknown;
    container?: { volumes?: Array<{ mountPath: string; name: string }> };
    image?: string;
    type: ResourceType;
  },
  context: z.RefinementCtx,
) {
  if (!resource.backup) return;
  const image = resource.image ?? defaultResourceImage(resource.type)!;
  const defaultVolume = defaultResourceVolume(resource.type, image)!;
  const declared = resource.container?.volumes ?? [];
  const effectiveVolumes = declared.some(
    (volume) => volume.mountPath === defaultVolume.mountPath,
  )
    ? declared
    : [defaultVolume, ...declared];
  if (effectiveVolumes.length !== 1)
    context.addIssue({
      code: "custom",
      message:
        "Managed database backup and restore supports only the engine data volume",
      path: ["container", "volumes"],
    });
}

function validateResourceImage(
  resource: {
    image?: string;
    type: ResourceType;
  },
  context: z.RefinementCtx,
) {
  const image = resource.image ?? defaultResourceImage(resource.type);
  if (!image) {
    context.addIssue({
      code: "custom",
      message: "Datastore requires an image",
      path: ["image"],
    });
  } else if (!hasImmutableImageSelector(image)) {
    context.addIssue({
      code: "custom",
      message: "Datastore images require an explicit non-latest tag or digest",
      path: ["image"],
    });
  }
}

function validateManagedResourceImage(
  resource: { image?: string; type: ResourceType },
  context: z.RefinementCtx,
) {
  if (!resource.image) return;
  if (!/@sha256:[a-f0-9]{64}$/u.test(resource.image)) {
    context.addIssue({
      code: "custom",
      message:
        "Custom managed database images must include an immutable sha256 digest",
      path: ["image"],
    });
    return;
  }
  const taggedReference = resource.image.split("@")[0]!;
  const tag = taggedReference.slice(taggedReference.lastIndexOf(":") + 1);
  const match = (
    resource.type === "postgres" ? /^v?(\d+)(?:[.-]|$)/u : /v?(\d+)(?:[.-]|$)/u
  ).exec(tag);
  const compatibility = managedResourceCompatibility[resource.type];
  const supported: readonly number[] =
    "supportedMajorVersions" in compatibility
      ? compatibility.supportedMajorVersions
      : [compatibility.majorVersion];
  if (!match || !supported.includes(Number(match[1]))) {
    context.addIssue({
      code: "custom",
      message: `${resource.type} images must declare supported major version${supported.length > 1 ? "s" : ""} ${supported.join(", ")} in the tag`,
      path: ["image"],
    });
  }
}

function validateResourceConnectivity(
  resource: {
    access?: { sshTunnel: { hostPort: number } };
    container?: { network?: string; networkAlias?: string; port?: number };
    type: ResourceType;
  },
  context: z.RefinementCtx,
) {
  if (resource.container?.networkAlias && !resource.container.network) {
    context.addIssue({
      code: "custom",
      message: "A network alias requires a declared Docker network",
      path: ["container", "networkAlias"],
    });
  }
  const port = resource.container?.port ?? defaultResourcePort(resource.type);
  if (resource.access?.sshTunnel && !port) {
    context.addIssue({
      code: "custom",
      message: "SSH tunnel access requires a container port",
      path: ["access", "sshTunnel", "hostPort"],
    });
  }
}

export const resourceSchema = z
  .object({
    access: resourceAccessSchema.optional(),
    logs: logPolicySchema.optional(),
    autoDeploy: z.boolean().optional(),
    backup: resourceBackupSchema.optional(),
    notifications: manifestNotificationsSchema.optional(),
    externalSecrets: externalSecretsSchema.optional(),
    ingress: ingressSchema.optional(),
    id: z.string().trim().regex(appIdPattern),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    type: z.enum(managedResourceTypes),
    image: z.string().trim().regex(dockerImagePattern).optional(),
    server: serverReferenceSchema,
    container: z
      .object({
        configFiles: z.array(configurationFileSchema).max(50).optional(),
        command: z.array(hookArgumentSchema).min(1).max(64).optional(),
        entrypoint: z
          .string()
          .max(4_096)
          .refine(
            (value) => !value.includes("\0"),
            "Entrypoints cannot contain null bytes",
          )
          .optional(),
        network: z.string().trim().regex(dockerNetworkPattern).optional(),
        networkAlias: z.string().trim().regex(appIdPattern).optional(),
        port: z.number().int().min(1).max(65_535).optional(),
        resources: containerResourcesSchema.optional(),
        volumes: z.array(dockerVolumeSchema).max(20).optional(),
      })
      .strict()
      .optional(),
    health: resourceHealthSchema.optional(),
    domains: z
      .object({
        primary: domainSchema,
        redirects: z.array(redirectSchema).max(20).optional(),
      })
      .strict()
      .optional(),
    tls: tlsSchema.optional(),
  })
  .strict()
  .superRefine((resource, context) => {
    const port = resource.container?.port ?? defaultResourcePort(resource.type);
    const defaultVolume = defaultResourceVolume(
      resource.type,
      resource.image ?? defaultResourceImage(resource.type)!,
    );
    validateConfigurationMounts(
      {
        ...resource.container,
        volumes: [
          ...(defaultVolume ? [defaultVolume] : []),
          ...(resource.container?.volumes ?? []),
        ],
      },
      context,
    );
    validatePublicHealth(resource, context, port);
    validateResourceImage(resource, context);
    validateManagedResourceImage(resource, context);
    validateResourceConnectivity(resource, context);
    validateResourceBackupSupport(resource, context);
    const volumes = resource.container?.volumes ?? [];
    findDuplicates(volumes.map((volume) => volume.name)).forEach((name) =>
      context.addIssue({
        code: "custom",
        message: `Volume '${name}' is declared more than once`,
        path: ["container", "volumes"],
      }),
    );
    findDuplicates(volumes.map((volume) => volume.mountPath)).forEach(
      (mountPath) =>
        context.addIssue({
          code: "custom",
          message: `Volume mount '${mountPath}' is declared more than once`,
          path: ["container", "volumes"],
        }),
    );
    if (resource.domains && !port) {
      context.addIssue({
        code: "custom",
        message: "Domains require a container port",
        path: ["container", "port"],
      });
    }
    const effectiveHealthType = resource.health?.type ?? "command";
    if (
      resource.domains &&
      effectiveHealthType !== "http" &&
      !resource.health?.publicPath
    ) {
      context.addIssue({
        code: "custom",
        message: "Public resources require an HTTP health check",
        path: ["health", "type"],
      });
    }
    if (resource.health?.type === "http" && !port) {
      context.addIssue({
        code: "custom",
        message: "HTTP health checks require a container port",
        path: ["container", "port"],
      });
    }
    if (resource.tls && !resource.domains) {
      context.addIssue({
        code: "custom",
        message: "TLS configuration requires a primary domain",
        path: ["tls"],
      });
    }
    if (resource.ingress?.type === "cloudflare-tunnel" && !resource.domains) {
      context.addIssue({
        code: "custom",
        message: "Cloudflare Tunnel ingress requires a primary domain",
        path: ["ingress"],
      });
    }
  });

export const resolvedDeploymentManifestSchema = z
  .object({
    version: z.literal(2),
    defaults: z
      .object({
        buildServer: buildServerSelectionSchema.optional(),
      })
      .strict()
      .optional(),
    deploymentInputs: deploymentInputGroupsSchema.optional(),
    source: z
      .object({
        branch: branchSchema.optional(),
      })
      .strict()
      .optional(),
    apps: z.array(appSchema).max(500).optional(),
    compose: z.array(composeWorkloadSchema).max(100).optional(),
    resources: z.array(resourceSchema).max(500).optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const deployables = [
      ...(manifest.apps ?? []),
      ...(manifest.resources ?? []),
    ];
    findDuplicates([
      ...(manifest.apps ?? []).map((app) => `app:${app.id}`),
      ...(manifest.resources ?? []).map(
        (resource) => `resource:${resource.id}`,
      ),
      ...(manifest.compose ?? []).map((workload) => `compose:${workload.id}`),
    ]).forEach((id) =>
      context.addIssue({
        code: "custom",
        message: `Deployable id '${id}' is declared more than once`,
        path: [],
      }),
    );

    const claimedDomains = new Map<string, string>();
    const claimedNetworkAliases = new Map<string, string>();
    const claimedSshTunnelPorts = new Map<string, string>();

    (manifest.apps ?? []).forEach((app, appIndex) => {
      const { network, networkAlias } = app.container;
      if (!network || !networkAlias) return;
      const key = `${canonicalIp(app.server)}\u0000${network}\u0000${networkAlias}`;
      const owner = claimedNetworkAliases.get(key);
      if (owner) {
        context.addIssue({
          code: "custom",
          message: `Network alias '${networkAlias}' is already claimed by deployable '${owner}' on this server and network`,
          path: ["apps", appIndex, "container", "networkAlias"],
        });
      } else {
        claimedNetworkAliases.set(key, app.id);
      }
    });

    (manifest.resources ?? []).forEach((resource, resourceIndex) => {
      const serverIp = canonicalIp(resource.server);
      const network = resource.container?.network;
      if (network) {
        const alias = resource.container?.networkAlias ?? resource.id;
        const key = `${serverIp}\u0000${network}\u0000${alias}`;
        const owner = claimedNetworkAliases.get(key);
        if (owner) {
          context.addIssue({
            code: "custom",
            message: `Network alias '${alias}' is already claimed by deployable '${owner}' on this server and network`,
            path: ["resources", resourceIndex, "container", "networkAlias"],
          });
        } else {
          claimedNetworkAliases.set(key, resource.id);
        }
      }

      const hostPort = resource.access?.sshTunnel.hostPort;
      if (hostPort) {
        const key = `${serverIp}\u0000${hostPort}`;
        const owner = claimedSshTunnelPorts.get(key);
        if (owner) {
          context.addIssue({
            code: "custom",
            message: `SSH tunnel host port '${hostPort}' is already claimed by resource '${owner}' on this server`,
            path: [
              "resources",
              resourceIndex,
              "access",
              "sshTunnel",
              "hostPort",
            ],
          });
        } else {
          claimedSshTunnelPorts.set(key, resource.id);
        }
      }
    });

    Object.entries(manifest.deploymentInputs ?? {}).forEach(
      ([group, inputs]) => {
        findDuplicates(inputs).forEach((input) =>
          context.addIssue({
            code: "custom",
            message: `Deployment input '${input}' is declared more than once`,
            path: ["deploymentInputs", group],
          }),
        );
      },
    );

    const automaticDeployables = [
      ...(manifest.apps ?? []).map((app, index) => ({
        app,
        index,
        collection: "apps",
      })),
      ...(manifest.compose ?? []).map((app, index) => ({
        app,
        index,
        collection: "compose",
      })),
    ];
    automaticDeployables.forEach(({ app, index, collection }) => {
      if (typeof app.autoDeploy !== "object") return;
      findDuplicates(app.autoDeploy.inputs).forEach((input) =>
        context.addIssue({
          code: "custom",
          message: `Deployment input '${input}' is declared more than once`,
          path: [collection, index, "autoDeploy", "inputs"],
        }),
      );
      app.autoDeploy.inputs.forEach((input, inputIndex) => {
        if (
          input.startsWith("$") &&
          !manifest.deploymentInputs?.[input.slice(1)]
        ) {
          context.addIssue({
            code: "custom",
            message: `Deployment input group '${input}' is not declared`,
            path: [collection, index, "autoDeploy", "inputs", inputIndex],
          });
        }
      });
    });

    deployables.forEach((app, appIndex) => {
      const collection = "type" in app ? "resources" : "apps";
      if (!app.domains) return;
      const domains = [
        app.domains.primary,
        ...(app.domains.redirects ?? []).map((redirect) => redirect.host),
      ];
      domains.forEach((value) => {
        const domain = normalizeDomain(value);
        const owner = claimedDomains.get(domain);
        if (owner) {
          context.addIssue({
            code: "custom",
            message: `Domain '${domain}' is already claimed by app '${owner}'`,
            path: [collection, appIndex, "domains"],
          });
          return;
        }
        claimedDomains.set(domain, app.id);
      });
    });
    (manifest.compose ?? []).forEach((workload, workloadIndex) => {
      Object.entries(workload.services).forEach(([service, policy]) => {
        (policy.domains ?? []).forEach((value) => {
          const domain = normalizeDomain(value);
          const owner = claimedDomains.get(domain);
          if (owner) {
            context.addIssue({
              code: "custom",
              message: `Domain '${domain}' is already claimed by deployable '${owner}'`,
              path: ["compose", workloadIndex, "services", service, "domains"],
            });
          } else claimedDomains.set(domain, `${workload.id}/${service}`);
        });
      });
    });
  });

export type DeploymentManifestInput = z.input<
  typeof resolvedDeploymentManifestSchema
>;

export type ManifestIssue = {
  column?: number;
  line?: number;
  message: string;
  path: Array<number | string>;
};

export class ManifestValidationError extends Error {
  readonly issues: ManifestIssue[];

  constructor(issues: ManifestIssue[]) {
    super("Towbar deployment manifest is invalid");
    this.name = "ManifestValidationError";
    this.issues = issues;
  }
}

export function normalizeDeploymentManifest(
  manifest: DeploymentManifestInput,
): NormalizedDeploymentManifest {
  const parsed = resolvedDeploymentManifestSchema.parse(manifest);
  const sourceBranch = parsed.source?.branch ?? "main";
  return {
    version: parsed.version,
    source: { branch: sourceBranch },
    apps: (parsed.apps ?? [])
      // eslint-disable-next-line complexity -- Normalization handles every optional app capability in one canonical pass.
      .map((app) => {
        const deployment = normalizeAppDeployment(app);
        const buildServer =
          deployment.type === "image" || app.buildServer === null
            ? undefined
            : (app.buildServer ?? parsed.defaults?.buildServer);
        const automaticDeployment = normalizeAutomaticDeployment(
          app.autoDeploy,
          parsed.deploymentInputs,
        );
        return {
          kind: "app" as const,
          ...(app.logs ? { logs: app.logs } : {}),
          ...(app.analytics ? { analytics: app.analytics } : {}),
          ...(app.notifications
            ? {
                notifications: normalizeManifestNotifications(
                  app.notifications,
                ),
              }
            : {}),
          ...(app.jobs?.length
            ? {
                jobs: [...app.jobs].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              }
            : {}),
          autoDeploy: automaticDeployment.enabled,
          vulnerabilityScanning: app.vulnerabilityScanning ?? false,
          id: app.id,
          name: app.name,
          ...(app.description ? { description: app.description } : {}),
          server: canonicalIp(app.server),
          sourceBranch,
          deployment,
          ...(deployment.type === "dockerfile"
            ? { dockerfile: deployment.dockerfile }
            : {}),
          context:
            "context" in deployment
              ? normalizeRepositoryPath(deployment.context)
              : ".",
          ...(buildServer
            ? {
                buildServer: {
                  ...buildServer,
                  ip: canonicalIp(buildServer.ip),
                },
              }
            : {}),
          rollout: app.rollout ?? rolloutStrategySchema.parse(undefined),
          ...(app.externalSecrets
            ? { externalSecrets: app.externalSecrets }
            : {}),
          ...(app.ingress ? { ingress: app.ingress } : {}),
          deploymentInputs: automaticDeployment.inputs.length
            ? [
                ...new Set([
                  ...automaticDeployment.inputs,
                  ...(app.container.configFiles ?? []).map(
                    (file) => file.source,
                  ),
                ]),
              ].sort()
            : [],
          container: {
            ...normalizeContainerOverrides(app.container),
            ...(app.container.hostLogs
              ? { hostLogs: app.container.hostLogs }
              : {}),
            ...(app.container.network
              ? { network: app.container.network.trim() }
              : {}),
            ...(app.container.networkAlias
              ? { networkAlias: app.container.networkAlias.trim() }
              : {}),
            port: app.container.port,
            ...(app.container.volumes?.length
              ? {
                  volumes: app.container.volumes
                    .map((volume) => ({ ...volume }))
                    .sort((a, b) => a.name.localeCompare(b.name)),
                }
              : {}),
            ...(app.container.resources
              ? {
                  resources: {
                    cpus: app.container.resources.cpus,
                    memory: app.container.resources.memory.toLowerCase(),
                  },
                }
              : {}),
          },
          health: normalizeAppHealth(app.health),
          hooks: {
            ...(app.hooks?.postDeploy
              ? { postDeploy: normalizeDeploymentHook(app.hooks.postDeploy) }
              : {}),
            ...(app.hooks?.preDeploy
              ? { preDeploy: normalizeDeploymentHook(app.hooks.preDeploy) }
              : {}),
          },
          ...normalizePreviewConfig(app.preview),
          ...(app.domains
            ? {
                domains: {
                  primary: normalizeDomain(app.domains.primary),
                  redirects: (app.domains.redirects ?? [])
                    .map((redirect) => ({
                      host: normalizeDomain(redirect.host),
                      status: redirect.status ?? 301,
                    }))
                    .sort((left, right) => left.host.localeCompare(right.host)),
                },
              }
            : {}),
          ...(app.tls ? { tls: app.tls } : {}),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id)),
    ...(parsed.compose?.length
      ? {
          compose: [...parsed.compose]
            .map((workload) => {
              const automaticDeployment = normalizeAutomaticDeployment(
                workload.autoDeploy,
                parsed.deploymentInputs,
              );
              return {
                ...workload,
                autoDeploy: automaticDeployment.enabled,
                services: Object.fromEntries(
                  Object.entries(workload.services).map(([name, policy]) => [
                    name,
                    {
                      ...policy,
                      ...(policy.domains
                        ? { domains: policy.domains.map(normalizeDomain) }
                        : {}),
                    },
                  ]),
                ),
                ...(workload.notifications
                  ? {
                      notifications: normalizeManifestNotifications(
                        workload.notifications,
                      ),
                    }
                  : {}),
                container: { port: 0 as const, volumes: [] as [] },
                context: ".",
                ...(automaticDeployment.inputs.length
                  ? { deploymentInputScope: automaticDeployment.inputs }
                  : {}),
                deploymentInputs: automaticDeployment.inputs.length
                  ? [
                      ...new Set([
                        ...automaticDeployment.inputs,
                        ...[workload.file, ...workload.overrides].map((file) =>
                          escape(normalizeRepositoryPath(file), {
                            magicalBraces: true,
                          }),
                        ),
                      ]),
                    ].sort()
                  : ["**"],
                health: { path: "/", timeoutSeconds: 300 },
                hooks: {},
                kind: "compose" as const,
                sourceBranch,
                vulnerabilityScanning: false,
                server: canonicalIp(workload.server),
              };
            })
            .sort((left, right) => left.id.localeCompare(right.id)),
        }
      : {}),
    resources: (parsed.resources ?? [])
      .map((resource) => normalizeResource(resource, sourceBranch))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function normalizeAppDeployment(
  app: z.output<typeof appSchema>,
): AppDeployment {
  if (app.deployment) return app.deployment;
  return appDeploymentSchema.parse({
    type: "dockerfile",
    context: app.context ?? ".",
    dockerfile: app.dockerfile,
  });
}

export function normalizeServerConfiguration(
  input: z.input<typeof serverConfigurationSchema>,
): NormalizedServer {
  const server = serverConfigurationSchema.parse(input);
  const buildConcurrency = server.buildConcurrency ?? 1;
  return {
    buildConcurrency,
    ...(server.hostLogCollection ? { hostLogCollection: true } : {}),
    previewBuildConcurrency: Math.min(
      server.previewBuildConcurrency ?? 1,
      buildConcurrency,
    ),
    ip: canonicalIp(server.ip),
    ssh: {
      host: canonicalIp(server.ssh.host ?? server.ip),
      port: server.ssh.port ?? 22,
      username: server.ssh.username,
    },
  };
}

function normalizeAutomaticDeployment(
  autoDeploy: z.output<typeof appAutoDeploySchema> | undefined,
  groups: Record<string, string[]> | undefined,
) {
  if (typeof autoDeploy !== "object") {
    return { enabled: autoDeploy ?? false, inputs: [] as string[] };
  }
  const inputs = autoDeploy.inputs.flatMap((input) =>
    input.startsWith("$") ? (groups?.[input.slice(1)] ?? []) : [input],
  );
  return {
    enabled: true,
    inputs: [...new Set(inputs.map(normalizeDeploymentInputPattern))].sort(),
  };
}

function normalizeDeploymentInputPattern(value: string) {
  return value.trim().replace(/^\.\//u, "");
}

export function isNormalizedResource(
  deployable: NormalizedDeployable,
): deployable is NormalizedResource {
  return (
    deployable.kind !== undefined &&
    deployable.kind !== "app" &&
    deployable.kind !== "compose"
  );
}

export function isNormalizedCompose(
  deployable: NormalizedDeployable,
): deployable is NormalizedComposeWorkload {
  return deployable.kind === "compose";
}

export function isNormalizedApp(
  deployable: NormalizedDeployable,
): deployable is NormalizedApp {
  return deployable.kind === "app";
}

function normalizeResource(
  resource: z.output<typeof resourceSchema>,
  sourceBranch: string,
): NormalizedResource {
  const kind = resource.type;
  const image = resource.image ?? defaultResourceImage(kind)!;
  const port = resource.container?.port ?? defaultResourcePort(kind);
  const defaultVolume = defaultResourceVolume(kind, image);
  const declaredVolumes = resource.container?.volumes ?? [];
  const volumes = defaultVolume
    ? declaredVolumes.some(
        (volume) => volume.mountPath === defaultVolume.mountPath,
      )
      ? declaredVolumes
      : [defaultVolume, ...declaredVolumes]
    : declaredVolumes;
  const health = normalizeResourceHealth(resource);
  const backup = normalizeResourceBackup(resource.backup);
  return {
    ...normalizeResourceAccess(resource.access),
    ...(resource.logs ? { logs: resource.logs } : {}),
    ...(resource.notifications
      ? {
          notifications: normalizeManifestNotifications(resource.notifications),
        }
      : {}),
    ...(resource.externalSecrets
      ? { externalSecrets: resource.externalSecrets }
      : {}),
    ...(resource.ingress ? { ingress: resource.ingress } : {}),
    autoDeploy: resource.autoDeploy ?? false,
    ...(backup ? { backup } : {}),
    container: normalizeResourceContainer(resource, kind, port, volumes),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.domains
      ? {
          domains: {
            primary: normalizeDomain(resource.domains.primary),
            redirects: (resource.domains.redirects ?? [])
              .map((redirect) => ({
                host: normalizeDomain(redirect.host),
                status: redirect.status ?? 301,
              }))
              .sort((left, right) => left.host.localeCompare(right.host)),
          },
        }
      : {}),
    health,
    id: resource.id,
    image,
    kind,
    name: resource.name,
    server: canonicalIp(resource.server),
    sourceBranch,
    ...(resource.tls ? { tls: resource.tls } : {}),
  };
}

function normalizeResourceAccess(
  access: z.output<typeof resourceAccessSchema> | undefined,
) {
  if (!access) return {};
  return {
    access: {
      sshTunnel: {
        hostPort: access.sshTunnel.hostPort,
      },
    },
  };
}

function normalizeResourceContainer(
  resource: z.output<typeof resourceSchema>,
  kind: NormalizedResource["kind"],
  port: number | undefined,
  volumes: Array<{ mountPath: string; name: string }>,
): NormalizedResource["container"] {
  return {
    ...normalizeContainerOverrides(resource.container ?? {}),
    command:
      resource.container?.command ??
      (kind === "redis"
        ? [
            "sh",
            "-c",
            'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"',
          ]
        : kind === "dragonfly"
          ? [
              "sh",
              "-c",
              'exec dragonfly --dir=/data --dbfilename=dump.rdb --requirepass="$REDIS_PASSWORD"',
            ]
          : kind === "keydb"
            ? [
                "sh",
                "-c",
                'exec keydb-server --appendonly yes --requirepass "$REDIS_PASSWORD"',
              ]
            : []),
    ...(resource.container?.network
      ? {
          network: resource.container.network.trim(),
          networkAlias: resource.container.networkAlias?.trim() ?? resource.id,
        }
      : {}),
    ...(port ? { port } : {}),
    resources: resource.container?.resources
      ? {
          cpus: resource.container.resources.cpus,
          memory: resource.container.resources.memory.toLowerCase(),
        }
      : defaultResourceLimits(kind),
    volumes: volumes.map((volume) => ({ ...volume })),
  };
}

function normalizeResourceBackup(
  backup: z.output<typeof resourceBackupSchema> | undefined,
): NormalizedResource["backup"] {
  if (!backup) return undefined;
  const destinations = [backup.s3 && "s3", backup.gcs && "gcs"].filter(
    Boolean,
  ) as Array<"s3" | "gcs">;
  const restoreFrom = backup.integration
    ? undefined
    : (backup.restoreFrom ??
      (destinations.length === 1 ? destinations[0]! : "s3"));
  return {
    ...(backup.integration ? { integration: backup.integration } : {}),
    ...(backup.gcs
      ? {
          gcs: {
            bucket: backup.gcs.bucket,
            prefix: backup.gcs.prefix || "towbar",
            ...(backup.gcs.region ? { region: backup.gcs.region } : {}),
          },
        }
      : {}),
    ...(restoreFrom ? { restoreFrom } : {}),
    retention: { keepLast: backup.retention?.keepLast ?? 7 },
    ...(backup.s3
      ? {
          s3: {
            bucket: backup.s3.bucket,
            encryption: backup.s3.encryption ?? "AES256",
            ...(backup.s3.kmsKeyId ? { kmsKeyId: backup.s3.kmsKeyId } : {}),
            prefix: backup.s3.prefix || "towbar",
            ...(backup.s3.region ? { region: backup.s3.region } : {}),
          },
        }
      : {}),
    ...(backup.schedule
      ? {
          schedule: {
            cron: backup.schedule.cron,
            timezone: "UTC" as const,
          },
        }
      : {}),
  };
}

export function validateBackupCron(expression: string) {
  const job = new Cron(expression, {
    mode: "5-part",
    paused: true,
    timezone: "UTC",
  });
  const runs = job.nextRuns(128, new Date("2024-01-01T00:00:00.000Z"));
  if (runs.length < 2) return;
  for (let index = 1; index < runs.length; index += 1) {
    if (runs[index]!.getTime() - runs[index - 1]!.getTime() < 60 * 60_000) {
      throw new Error(
        "Backup cron schedules cannot run more than once per hour",
      );
    }
  }
}

export function getLatestBackupScheduleOccurrence(
  expression: string,
  now = new Date(),
) {
  validateBackupCron(expression);
  return (
    new Cron(expression, {
      mode: "5-part",
      paused: true,
      timezone: "UTC",
    }).previousRuns(1, new Date(now.getTime() + 1_000))[0] ?? null
  );
}

function normalizeResourceHealth(
  resource: z.output<typeof resourceSchema>,
): NormalizedResource["health"] {
  if (resource.health?.type === "command") {
    return {
      ...(resource.health.publicPath
        ? { publicPath: resource.health.publicPath }
        : {}),
      command: [...resource.health.command!],
      timeoutSeconds: resource.health.timeoutSeconds ?? 60,
      type: "command",
    };
  }
  if (resource.health?.type === "http") {
    return {
      path: resource.health.path!,
      ...(resource.health.port ? { port: resource.health.port } : {}),
      ...(resource.health.publicPath
        ? { publicPath: resource.health.publicPath }
        : {}),
      timeoutSeconds: resource.health.timeoutSeconds ?? 60,
      type: "http",
    };
  }
  if (resource.health?.type === "container") {
    return {
      timeoutSeconds: resource.health.timeoutSeconds ?? 60,
      type: "container",
      ...(resource.health.publicPath
        ? { publicPath: resource.health.publicPath }
        : {}),
    };
  }
  return {
    command: [...managedResourceCompatibility[resource.type].healthCommand],
    timeoutSeconds: 60,
    type: "command",
  };
}

function defaultResourceImage(type: ResourceType) {
  return managedResourceCompatibility[type].image;
}

function defaultResourcePort(type: ResourceType) {
  return managedResourceCompatibility[type].port;
}

function defaultResourceVolume(type: ResourceType, image: string) {
  if (type === "postgres") {
    return {
      mountPath:
        postgresImageMajorVersion(image) >= 18
          ? "/var/lib/postgresql"
          : "/var/lib/postgresql/data",
      name: "data",
    };
  }
  return {
    mountPath: managedResourceCompatibility[type].volumePath,
    name: "data",
  };
}

function postgresImageMajorVersion(image: string) {
  const tag = image.split("@")[0]?.split(":").at(-1) ?? "";
  const match = /^v?(\d+)/u.exec(tag);
  return match ? Number(match[1]) : 0;
}

function defaultResourceLimits(type: ResourceType) {
  return managedResourceCompatibility[type].resources;
}

function hasImmutableImageSelector(image: string) {
  if (image.includes("@")) return true;
  const finalSegment = image.split("/").at(-1) ?? "";
  const tag = finalSegment.includes(":")
    ? finalSegment.slice(finalSegment.lastIndexOf(":") + 1)
    : "";
  return Boolean(tag) && tag.toLowerCase() !== "latest";
}

function normalizeDeploymentHook(input: {
  command: string[];
  timeoutSeconds?: number;
  entrypoint?: string;
}): NormalizedDeploymentHook {
  return {
    command: [...input.command],
    ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
    timeoutSeconds: input.timeoutSeconds ?? 300,
  };
}

function normalizePreviewConfig(
  input: z.output<typeof appSchema>["preview"],
): Pick<NormalizedApp, "preview"> {
  if (!input) return {};
  return {
    preview: {
      domain: normalizeDomain(input.domain),
      enabled: true,
      ttlHours: input.ttlHours ?? 72,
    },
  };
}

function normalizeContainerOverrides(container: {
  configFiles?: ConfigurationFile[];
  command?: string[];
  entrypoint?: string;
}) {
  return {
    ...(container.command !== undefined
      ? { command: [...container.command] }
      : {}),
    ...(container.entrypoint !== undefined
      ? { entrypoint: container.entrypoint }
      : {}),
    ...(container.configFiles?.length
      ? {
          configFiles: [...container.configFiles].sort((a, b) =>
            a.mountPath.localeCompare(b.mountPath),
          ),
        }
      : {}),
  };
}

function normalizeAppHealth(
  health: z.output<typeof appSchema>["health"],
): NormalizedHealth {
  if (health?.type === "command")
    return {
      type: "command",
      command: health.command!,
      ...(health.publicPath ? { publicPath: health.publicPath } : {}),
      timeoutSeconds: health.timeoutSeconds ?? 60,
    };
  if (health?.type === "container")
    return {
      type: "container",
      ...(health.publicPath ? { publicPath: health.publicPath } : {}),
      timeoutSeconds: health.timeoutSeconds ?? 60,
    };
  return {
    path: health?.path ?? "/api/health",
    timeoutSeconds: health?.timeoutSeconds ?? 60,
    ...(health?.port ? { port: health.port } : {}),
    ...(health?.publicPath ? { publicPath: health.publicPath } : {}),
  };
}

function validatePublicHealth(
  workload: {
    domains?: unknown;
    health?: { type?: string; port?: number; publicPath?: string };
    container?: { port?: number };
  },
  context: z.RefinementCtx,
  containerPort = workload.container?.port,
) {
  const health = workload.health;
  if (
    workload.domains &&
    health &&
    (health.type === "command" ||
      health.type === "container" ||
      (health.port && health.port !== containerPort)) &&
    !health.publicPath
  )
    context.addIssue({
      code: "custom",
      path: ["health", "publicPath"],
      message:
        "Declare a publicPath to verify ingress separately from container readiness",
    });
}
