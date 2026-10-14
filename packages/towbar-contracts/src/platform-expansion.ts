import { logPolicySchema } from "./logs.js";
import { tlsSchema } from "./tls.js";
import { z } from "zod";
import { autoDeploySchema } from "./deployment-input-schema.js";
import { manifestNotificationsSchema } from "./notifications.js";

function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

const repositoryPath = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    "Expected a repository-relative path without parent traversal",
  );

const staticAssetPath = repositoryPath.refine(
  (value) => !containsAsciiControlCharacter(value),
  "Static asset paths cannot contain control characters",
);
const staticHeaderName = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u,
    "Static header names must use HTTP token characters",
  );
const staticHeaderValue = z
  .string()
  .max(2_048)
  .refine(
    (value) => !containsAsciiControlCharacter(value),
    "Static header values cannot contain control characters",
  );

const command = z.array(z.string().min(1).max(4_096)).min(1).max(64);
const buildArguments = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    z
      .string()
      .max(4_096)
      .refine(
        (value) =>
          !value.includes("\0") &&
          !value.includes("\n") &&
          !value.includes("\r"),
        "Build argument values cannot contain null bytes or newlines",
      ),
  )
  .default({});
const buildResources = z
  .object({
    cpus: z.number().positive().max(128).default(2),
    memory: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d+)?(?:[kmgt]i?b?|b)$/iu)
      .default("2g"),
  })
  .strict()
  .default({ cpus: 2, memory: "2g" });
const buildCache = z
  .object({
    enabled: z.boolean().default(true),
    scope: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u)
      .optional(),
  })
  .strict()
  .optional();
const durationSeconds = z.number().int().min(1).max(86_400);
const pinnedOciImage = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^[^\s@]+@sha256:[a-f0-9]{64}$/u,
    "Use an immutable OCI image reference pinned by sha256 digest",
  );

const deployableOciImage = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[^\s@]+(?:@sha256:[a-f0-9]{64})?$/u, "Enter an OCI image reference")
  .refine((value) => {
    if (value.includes("@sha256:")) return true;
    const name = value.slice(value.lastIndexOf("/") + 1);
    return name.includes(":") && !name.endsWith(":latest");
  }, "Use an explicit image tag or an immutable sha256 digest; latest is not allowed");

export const approvedBuildpackBuilders = [
  "paketobuildpacks/builder-jammy-base@sha256:c696f4078229f82f7e3faf9fd806554f897dcdc09686c9fee3edd0ff914560ff",
  "heroku/builder@sha256:84d80b3c0d242961414a3c4d0a00c3518e6de01ef936423cfbaf1b0aa0f9155c",
  "heroku/builder@sha256:6e26ec6a0f1bd0c8ba225fba57574ef3f1238e474a6bf06c3bebcb2fd4560659",
] as const;

const approvedBuildpackBuilder = pinnedOciImage.refine(
  (value) => approvedBuildpackBuilders.includes(value as never),
  "Use a Towbar-reviewed Paketo or Heroku builder digest",
);
const buildpackReference = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      (value.startsWith("./") && repositoryPath.safeParse(value).success) ||
      /^[a-z0-9][a-z0-9._/-]*@(?:sha256:[a-f0-9]{64}|v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.test(
        value,
      ),
    "Use a repository-relative buildpack or an exact registry version/digest",
  );

export const integrationReferenceSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const buildServerSelectionSchema = z
  .object({
    ip: z.ipv4().or(z.ipv6()),
    allowRuntimeFallback: z.boolean().default(false),
    transfer: z.enum(["direct", "registry"]).default("direct"),
    registry: integrationReferenceSchema.optional(),
    architecture: z.enum(["amd64", "arm64"]).optional(),
  })
  .strict()
  .superRefine((selection, context) => {
    if (selection.transfer === "registry" && !selection.registry) {
      context.addIssue({
        code: "custom",
        path: ["registry"],
        message: "Registry transfer requires a registry integration",
      });
    }
    if (selection.transfer === "direct" && selection.registry) {
      context.addIssue({
        code: "custom",
        path: ["registry"],
        message: "A registry integration is valid only for registry transfer",
      });
    }
  });

const explicitRolloutStrategySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("rolling"),
      replicas: z.number().int().min(1).max(100).default(1),
      maxSurge: z.number().int().min(0).max(100).default(1),
      maxUnavailable: z.number().int().min(0).max(100).default(0),
      startupDeadlineSeconds: durationSeconds.default(300),
      minimumHealthySeconds: z.number().int().min(0).max(600).default(10),
      failureThreshold: z.number().int().min(1).max(20).default(3),
      drainSeconds: z.number().int().min(0).max(600).default(10),
      terminationSeconds: durationSeconds.default(30),
    })
    .strict()
    .superRefine((rollout, context) => {
      if (rollout.maxSurge === 0 && rollout.maxUnavailable === 0) {
        context.addIssue({
          code: "custom",
          message: "A rolling rollout must permit surge or unavailability",
        });
      }
    }),
  z
    .object({
      type: z.literal("recreate"),
      reason: z.string().trim().min(1).max(500),
      maintenanceMode: z.boolean().default(false),
      terminationSeconds: durationSeconds.default(30),
    })
    .strict(),
]);

export const rolloutStrategySchema = explicitRolloutStrategySchema.default({
  type: "rolling",
  replicas: 1,
  maxSurge: 1,
  maxUnavailable: 0,
  startupDeadlineSeconds: 300,
  minimumHealthySeconds: 10,
  failureThreshold: 3,
  drainSeconds: 10,
  terminationSeconds: 30,
});

const sourceBuildFields = {
  context: repositoryPath.default("."),
  arguments: buildArguments,
  resources: buildResources,
  buildCommand: command.optional(),
  startCommand: command.optional(),
  configFile: repositoryPath.optional(),
  architecture: z.enum(["amd64", "arm64"]).optional(),
  timeoutSeconds: z.number().int().min(60).max(7_200).default(2_700),
  cache: buildCache,
};

export const appDeploymentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("dockerfile"),
      context: repositoryPath.default("."),
      arguments: buildArguments,
      resources: buildResources,
      dockerfile: repositoryPath,
      target: z.string().trim().min(1).max(128).optional(),
      architecture: z.enum(["amd64", "arm64"]).optional(),
      cache: buildCache,
      timeoutSeconds: z.number().int().min(60).max(7_200).default(2_700),
    })
    .strict(),
  z
    .object({
      type: z.literal("static"),
      context: repositoryPath.default("."),
      arguments: buildArguments,
      resources: buildResources,
      output: staticAssetPath,
      buildCommand: command.optional(),
      architecture: z.enum(["amd64", "arm64"]).optional(),
      cache: buildCache,
      nodeImage: pinnedOciImage,
      runtimeImage: pinnedOciImage.default(
        "nginxinc/nginx-unprivileged@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6",
      ),
      spaFallback: z.boolean().default(false),
      index: staticAssetPath.default("index.html"),
      errorPage: staticAssetPath.optional(),
      headers: z.record(staticHeaderName, staticHeaderValue).optional(),
      timeoutSeconds: z.number().int().min(60).max(7_200).default(1_800),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      image: deployableOciImage,
      registry: integrationReferenceSchema.optional(),
      platform: z.enum(["linux/amd64", "linux/arm64"]).optional(),
      pullPolicy: z
        .enum(["if-not-present", "always"])
        .default("if-not-present"),
    })
    .strict(),
  z
    .object({
      type: z.literal("railpack"),
      ...sourceBuildFields,
      version: z.string().trim().min(1).max(100),
      image: pinnedOciImage,
    })
    .strict(),
  z
    .object({
      type: z.literal("nixpacks"),
      ...sourceBuildFields,
      version: z.string().trim().min(1).max(100),
      image: pinnedOciImage,
    })
    .strict(),
  z
    .object({
      type: z.literal("buildpack"),
      ...sourceBuildFields,
      packImage: pinnedOciImage,
      builder: approvedBuildpackBuilder,
      buildpacks: z.array(buildpackReference).max(20).optional(),
    })
    .strict(),
]);
export type AppDeployment = z.infer<typeof appDeploymentSchema>;

const infisicalSecretSourceSchema = z
  .object({
    integration: z.literal("infisical"),
    project: z.uuid(),
    environmentSlug: z.string().trim().min(1).max(128).optional(),
    secretPath: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          !value.includes("\\") &&
          !value.includes("\0") &&
          !value.split("/").some((part) => part === ".." || part === "."),
        "Use a folder path without dot segments",
      )
      .optional(),
  })
  .strict();

const dopplerSecretSourceSchema = z
  .object({
    integration: z.literal("doppler"),
    project: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9-]*$/u),
    config: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const externalSecretsSchema = z.discriminatedUnion("integration", [
  infisicalSecretSourceSchema,
  dopplerSecretSourceSchema,
]);

export const ingressSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proxy") }).strict(),
  z
    .object({
      type: z.literal("cloudflare-tunnel"),
      integration: integrationReferenceSchema,
      tunnel: z.string().trim().min(1).max(128).optional(),
      access: z.boolean().default(false),
    })
    .strict(),
]);

const composeServicePolicySchema = z
  .object({
    domains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    ingress: ingressSchema.optional(),
    tls: tlsSchema.optional(),
  })
  .strict();

export const composeWorkloadSchema = z
  .object({
    logs: logPolicySchema.optional(),
    notifications: manifestNotificationsSchema.optional(),
    id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    autoDeploy: autoDeploySchema.default(false),
    server: z.ipv4().or(z.ipv6()),
    file: repositoryPath,
    overrides: z.array(repositoryPath).max(10).default([]),
    profiles: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    services: z
      .record(z.string().trim().min(1).max(128), composeServicePolicySchema)
      .default({}),
    externalSecrets: externalSecretsSchema.optional(),
    strategy: z.enum(["recreate", "maintenance"]).default("recreate"),
  })
  .strict()
  .superRefine((workload, context) => {
    const paths = [workload.file, ...workload.overrides];
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["overrides"],
        message: "Compose file and override paths must be unique",
      });
    }
    const tunnelPolicies: string[] = [];
    for (const [service, policy] of Object.entries(workload.services)) {
      if (policy.domains?.length && !policy.port)
        context.addIssue({
          code: "custom",
          path: ["services", service, "port"],
          message: "A service port is required when domains are declared",
        });
      if (policy.port && !policy.domains?.length)
        context.addIssue({
          code: "custom",
          path: ["services", service, "domains"],
          message:
            "Domains are required when a public service port is declared",
        });
      if (policy.ingress && !policy.domains?.length)
        context.addIssue({
          code: "custom",
          path: ["services", service, "ingress"],
          message: "Compose service ingress requires at least one domain",
        });
      if (policy.tls && !policy.domains?.length)
        context.addIssue({
          code: "custom",
          path: ["services", service, "tls"],
          message: "Compose service TLS requires at least one domain",
        });
      if (policy.tls && policy.ingress?.type === "cloudflare-tunnel")
        context.addIssue({
          code: "custom",
          path: ["services", service, "tls"],
          message: "Cloudflare Tunnel manages TLS; omit the service TLS policy",
        });
      if (policy.ingress?.type === "cloudflare-tunnel")
        tunnelPolicies.push(
          JSON.stringify({
            access: policy.ingress.access,
            integration: policy.ingress.integration,
            tunnel: policy.ingress.tunnel ?? null,
          }),
        );
    }
    if (new Set(tunnelPolicies).size > 1)
      context.addIssue({
        code: "custom",
        path: ["services"],
        message:
          "All Cloudflare Tunnel Compose services must use the same integration, tunnel and Access policy",
      });
  });
export type ComposeWorkload = z.infer<typeof composeWorkloadSchema>;
