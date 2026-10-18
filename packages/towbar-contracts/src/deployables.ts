import type { LogPolicy } from "./logs.js";
import type { TlsPolicy } from "./tls.js";
import type { z } from "zod";
import type { AnalyticsConfig } from "./analytics.js";
import type { ManifestNotifications } from "./notifications.js";
import type { AppJob } from "./app-jobs.js";
import type { ConfigurationFile } from "./container-configuration.js";
import type { ResourceType } from "./datastore-engines.js";
import type {
  AppDeployment,
  ComposeWorkload,
  buildServerSelectionSchema,
  externalSecretsSchema,
  ingressSchema,
  rolloutStrategySchema,
} from "./platform-expansion.js";

export type AppVolume = {
  name: string;
  mountPath: string;
  initialData?: "image" | "previous-container";
};
export type NormalizedServer = {
  buildConcurrency: number;
  previewBuildConcurrency?: number;
  hostLogCollection?: boolean;
  ip: string;
  ssh: { host: string; port: number; username: string };
};

export type NormalizedDeploymentHook = {
  command: string[];
  entrypoint?: string;
  timeoutSeconds: number;
};

export type NormalizedApp = {
  logs?: LogPolicy;
  analytics?: AnalyticsConfig;
  notifications?: ManifestNotifications;
  jobs?: AppJob[];
  kind?: "app";
  autoDeploy: boolean;
  vulnerabilityScanning: boolean;
  container: {
    configFiles?: ConfigurationFile[];
    command?: string[];
    entrypoint?: string;
    hostLogs?: { dockerJsonFiles: true };
    network?: string;
    networkAlias?: string;
    port: number;
    volumes?: AppVolume[];
    resources?: { cpus: number; memory: string };
  };
  buildServer?: z.infer<typeof buildServerSelectionSchema>;
  context: string;
  deployment?: AppDeployment;
  deploymentInputs: string[];
  description?: string;
  faviconDomain?: string;
  dockerfile?: string;
  domains?: {
    primary: string;
    redirects: Array<{ host: string; status: 301 | 302 }>;
  };
  health: NormalizedHealth;
  hooks: {
    postDeploy?: NormalizedDeploymentHook;
    preDeploy?: NormalizedDeploymentHook;
  };
  id: string;
  name: string;
  preview?: {
    domain: string;
    enabled: true;
    ttlHours: number;
  };
  externalSecrets?: z.infer<typeof externalSecretsSchema>;
  ingress?: z.infer<typeof ingressSchema>;
  rollout?: z.infer<typeof rolloutStrategySchema>;
  server: string;
  sourceBranch: string;
  tls?: TlsPolicy;
};

export type NormalizedResource = {
  logs?: LogPolicy;
  notifications?: ManifestNotifications;
  externalSecrets?: z.infer<typeof externalSecretsSchema>;
  ingress?: z.infer<typeof ingressSchema>;
  access?: {
    sshTunnel: { hostPort: number };
  };
  autoDeploy: boolean;
  backup?: {
    integration?: string;
    gcs?: {
      bucket: string;
      prefix: string;
      region?: string;
    };
    restoreFrom?: "s3" | "gcs";
    retention: { keepLast: number };
    s3?: {
      bucket: string;
      encryption: "AES256" | "aws:kms";
      kmsKeyId?: string;
      prefix: string;
      region?: string;
    };
    schedule?: { cron: string; timezone: "UTC" };
  };
  container: {
    command: string[];
    entrypoint?: string;
    configFiles?: ConfigurationFile[];
    network?: string;
    networkAlias?: string;
    port?: number;
    resources: { cpus: number; memory: string };
    volumes: Array<{ mountPath: string; name: string }>;
  };
  description?: string;
  domains?: NormalizedApp["domains"];
  health: NormalizedHealth & { type: "http" | "command" | "container" };
  id: string;
  image: string;
  kind: ResourceType;
  name: string;
  server: string;
  sourceBranch: string;
  tls?: TlsPolicy;
};

export type NormalizedComposeWorkload = Omit<ComposeWorkload, "autoDeploy"> & {
  autoDeploy: boolean;
  container: {
    network?: string;
    networkAlias?: string;
    port: number;
    resources?: { cpus: number; memory: string };
    volumes: [];
  };
  context: string;
  deployment?: never;
  deploymentInputs: string[];
  deploymentInputScope?: string[];
  domains?: NormalizedApp["domains"];
  health: NormalizedApp["health"];
  hooks: NormalizedApp["hooks"];
  ingress?: never;
  kind: "compose";
  jobs?: NormalizedApp["jobs"];
  preview?: NormalizedApp["preview"];
  sourceBranch: string;
  tls?: NormalizedApp["tls"];
  vulnerabilityScanning: boolean;
};

export type NormalizedDeployable =
  NormalizedApp | NormalizedComposeWorkload | NormalizedResource;

export type NormalizedDeploymentManifest = {
  apps: NormalizedApp[];
  compose?: NormalizedComposeWorkload[];
  resources?: NormalizedResource[];
  source: { branch: string };
  version: 2;
};

export type NormalizedHealth = (
  | { type?: "http"; path: string; port?: number; timeoutSeconds: number }
  | { type: "command"; command: string[]; timeoutSeconds: number }
  | { type: "container"; timeoutSeconds: number }
) & { publicPath?: string };
