import { z } from "zod";

export const integrationProviders = [
  "aws",
  "s3",
  "r2",
  "gcs",
  "github",
  "registry",
  "infisical",
  "doppler",
  "cloudflare",
] as const;
export const integrationProviderSchema = z.enum(integrationProviders);
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;

export const integrationPurposes = [
  "backup",
  "source",
  "image",
  "secret",
  "ingress",
] as const;
export const integrationPurposeSchema = z.enum(integrationPurposes);
export type IntegrationPurpose = z.infer<typeof integrationPurposeSchema>;

const environmentName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u);
export const integrationScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("workspace"), purpose: integrationPurposeSchema })
    .strict(),
  z
    .object({
      kind: z.literal("control-plane"),
      purpose: z.literal("backup"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("repository"),
      purpose: integrationPurposeSchema,
      repositoryId: z.uuid(),
      environments: z.array(environmentName).min(1).max(50),
    })
    .strict(),
]);
export type IntegrationScope = z.infer<typeof integrationScopeSchema>;

const httpsUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === "https:", "HTTPS is required");
const credentialText = z.string().min(1).max(8_192);
const objectStorageEndpointSchema = z
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:")
      context.addIssue({ code: "custom", message: "HTTPS is required" });
    if (url.username || url.password)
      context.addIssue({
        code: "custom",
        message: "Object-storage endpoints cannot contain credentials",
      });
    if (url.search || url.hash)
      context.addIssue({
        code: "custom",
        message:
          "Object-storage endpoints cannot contain a query string or fragment",
      });
  })
  .transform((value) => value.replace(/\/+$/u, ""));

export const awsConnectionConfigurationSchema = z
  .object({
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u),
  })
  .strict();
export const awsConnectionCredentialsSchema = z
  .object({
    accessKeyId: z.string().trim().min(16).max(128),
    secretAccessKey: z.string().min(20).max(256),
  })
  .strict();

export const s3ConnectionConfigurationSchema = z
  .object({
    endpoint: objectStorageEndpointSchema.optional(),
    region: z.string().trim().min(1).max(64),
    bucket: z.string().trim().min(3).max(255).optional(),
    prefix: z.string().trim().max(512).optional(),
    addressingStyle: z.enum(["auto", "path", "virtual"]).default("auto"),
    allowPrivateNetwork: z.boolean().default(false),
    customCa: z
      .string()
      .max(64 * 1_024)
      .refine(
        (value) =>
          !value.includes("\0") &&
          /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/u.test(
            value,
          ),
        "Custom CA must contain PEM-encoded certificates",
      )
      .optional(),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (!configuration.endpoint && configuration.customCa)
      context.addIssue({
        code: "custom",
        message: "A custom CA certificate requires a custom endpoint",
        path: ["customCa"],
      });
    if (!configuration.endpoint && configuration.allowPrivateNetwork)
      context.addIssue({
        code: "custom",
        message: "Private-network access requires a custom endpoint",
        path: ["allowPrivateNetwork"],
      });
  });
export const s3ConnectionCredentialsSchema = awsConnectionCredentialsSchema;

export const gcsConnectionConfigurationSchema = z
  .object({
    projectId: z.string().trim().min(1).max(256),
    bucket: z.string().trim().min(3).max(255).optional(),
    prefix: z.string().trim().max(512).optional(),
  })
  .strict();
export const gcsConnectionCredentialsSchema = z
  .object({
    serviceAccountJson: credentialText,
  })
  .strict();

export const githubConnectionConfigurationSchema = z
  .object({
    apiUrl: httpsUrlSchema.default("https://api.github.com"),
  })
  .strict();
export const githubConnectionCredentialsSchema = z
  .object({
    appId: z.string().trim().min(1).max(64),
    privateKey: credentialText,
  })
  .strict();

export const registryConnectionConfigurationSchema = z
  .object({
    registry: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .refine((value) => {
        if (
          !/^(?:localhost|[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/u.test(
            value,
          )
        )
          return false;
        try {
          const url = new URL(`https://${value}`);
          const hostname = url.hostname.replace(/^\[|\]$/gu, "");
          if (hostname === "localhost" || hostname.includes(":")) return true;
          return hostname
            .split(".")
            .every(
              (label) =>
                label.length >= 1 &&
                label.length <= 63 &&
                /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label),
            );
        } catch {
          return false;
        }
      }, "Enter a registry host with an optional port, without a scheme or path"),
    allowPrivateNetwork: z.boolean().default(false),
  })
  .strict();
export const registryConnectionCredentialsSchema = z
  .object({
    username: z.string().max(256),
    password: credentialText,
  })
  .strict();

export const infisicalConnectionConfigurationSchema = z
  .object({
    baseUrl: httpsUrlSchema.default("https://app.infisical.com"),
    allowPrivateNetwork: z.boolean().default(false),
  })
  .strict();
export const infisicalConnectionCredentialsSchema = z
  .object({
    clientId: credentialText,
    clientSecret: credentialText,
  })
  .strict();

export const dopplerConnectionConfigurationSchema = z.object({}).strict();
export const dopplerConnectionCredentialsSchema = z
  .object({ token: credentialText })
  .strict();
export const cloudflareConnectionConfigurationSchema = z
  .object({
    accountId: z.string().trim().min(1).max(64),
    zoneId: z.string().trim().min(1).max(64).optional(),
    cloudflaredImage: z
      .string()
      .trim()
      .regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/u)
      .default(
        "cloudflare/cloudflared@sha256:b269e8abd07a5bf6f3f4be65d5050b2174eca89c56a0241a8ff32a16aec454e4",
      ),
  })
  .strict();
export const cloudflareConnectionCredentialsSchema = z
  .object({ apiToken: credentialText })
  .strict();
const providerConnectionSchemas = [
  z
    .object({
      provider: z.literal("aws"),
      configuration: awsConnectionConfigurationSchema,
      credentials: awsConnectionCredentialsSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("s3"),
      configuration: s3ConnectionConfigurationSchema,
      credentials: s3ConnectionCredentialsSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("r2"),
      configuration: s3ConnectionConfigurationSchema.refine(
        (configuration) => Boolean(configuration.endpoint),
        {
          message: "Cloudflare R2 requires its account-specific endpoint",
          path: ["endpoint"],
        },
      ),
      credentials: s3ConnectionCredentialsSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("gcs"),
      configuration: gcsConnectionConfigurationSchema,
      credentials: gcsConnectionCredentialsSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("github"),
      configuration: githubConnectionConfigurationSchema,
      credentials: githubConnectionCredentialsSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("registry"),
      configuration: registryConnectionConfigurationSchema,
      credentials: registryConnectionCredentialsSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("infisical"),
      configuration: infisicalConnectionConfigurationSchema,
      credentials: infisicalConnectionCredentialsSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("doppler"),
      configuration: dopplerConnectionConfigurationSchema,
      credentials: dopplerConnectionCredentialsSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("cloudflare"),
      configuration: cloudflareConnectionConfigurationSchema,
      credentials: cloudflareConnectionCredentialsSchema,
    })
    .strict(),
] as const;

export const providerConnectionSchema = z.union(providerConnectionSchemas);
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export type NamedBackupStorageConnection = Extract<
  ProviderConnection,
  { provider: "s3" | "r2" | "gcs" }
>;

export function parseProviderConnection(input: {
  provider: IntegrationProvider;
  configuration: unknown;
  credentials: unknown;
}) {
  return providerConnectionSchema.parse(input);
}
export type IntegrationTarget =
  | { kind: "control-plane"; purpose: "backup" }
  | { kind: "workspace"; purpose: IntegrationPurpose }
  | {
      kind: "repository";
      purpose: IntegrationPurpose;
      repositoryId: string;
      environment: string;
    };

export function integrationScopeAllows(
  scopes: IntegrationScope[],
  target: IntegrationTarget,
) {
  return scopes.some(
    (scope) =>
      scope.purpose === target.purpose &&
      ((scope.kind === "workspace" && target.kind !== "control-plane") ||
        (scope.kind === "control-plane" && target.kind === "control-plane") ||
        (scope.kind === "repository" &&
          target.kind === "repository" &&
          scope.repositoryId === target.repositoryId &&
          scope.environments.includes(target.environment))),
  );
}

export function integrationCredentialAssociatedData(
  workspaceId: string,
  id: string,
  provider: IntegrationProvider = "aws",
) {
  return `${workspaceId}:integration:${id}:${provider}`;
}

export function credentialHint(
  provider: IntegrationProvider,
  credentials: Record<string, unknown>,
) {
  const candidate =
    provider === "aws" || provider === "s3" || provider === "r2"
      ? credentials.accessKeyId
      : provider === "github"
        ? credentials.appId
        : provider === "registry"
          ? credentials.username
          : (credentials.token ?? credentials.apiToken ?? credentials.clientId);
  return typeof candidate === "string" ? candidate.slice(-8) : null;
}
