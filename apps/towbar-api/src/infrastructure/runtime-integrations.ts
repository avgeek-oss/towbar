import { createPrivateKey } from "node:crypto";

import {
  type IntegrationProvider,
  type ProviderConnection,
  cloudflareConnectionConfigurationSchema,
  cloudflareConnectionCredentialsSchema,
  dopplerConnectionConfigurationSchema,
  dopplerConnectionCredentialsSchema,
  gcsConnectionConfigurationSchema,
  gcsConnectionCredentialsSchema,
  githubConnectionConfigurationSchema,
  githubConnectionCredentialsSchema,
  infisicalConnectionConfigurationSchema,
  infisicalConnectionCredentialsSchema,
  registryConnectionConfigurationSchema,
  registryConnectionCredentialsSchema,
  s3ConnectionConfigurationSchema,
  s3ConnectionCredentialsSchema,
} from "@workspace/towbar-core";
import { z } from "zod";

type Environment = Record<string, string | undefined>;

const enabledSchema = z.enum(["true", "false"]);
const booleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export type IntegrationCapability = {
  category:
    "backup" | "external-secrets" | "registry" | "source-control" | "platform";
  provider: IntegrationProvider;
};

export type PublicIntegrationDetail = { label: string; value: string };

export function getPublicIntegrationCapabilities(
  environment: Environment = process.env,
) {
  const runtime = getRuntimeIntegrations(environment);
  return runtime.capabilities.map((capability) => {
    const connection = runtime.providers[capability.provider];
    const details: PublicIntegrationDetail[] = [];
    const add = (label: string, value?: string) => {
      if (value) details.push({ label, value });
    };
    switch (connection?.provider) {
      case "aws":
        add("Region", connection.configuration.region);
        break;
      case "s3":
      case "r2":
        add("Endpoint", connection.configuration.endpoint);
        add("Region", connection.configuration.region);
        add("Bucket", connection.configuration.bucket);
        add("Prefix", connection.configuration.prefix);
        break;
      case "gcs":
        add("Project ID", connection.configuration.projectId);
        add("Bucket", connection.configuration.bucket);
        add("Prefix", connection.configuration.prefix);
        break;
      case "registry":
        add("Registry host", connection.configuration.registry);
        break;
      case "infisical":
        add("Server", new URL(connection.configuration.baseUrl).origin);
        break;
      case "cloudflare":
        add("Account ID", connection.configuration.accountId);
        add("Zone ID", connection.configuration.zoneId);
        break;
    }
    return { ...capability, details };
  });
}

export type GitHubRuntimeConfiguration = {
  apiUrl: string;
  appId: string;
  appSlug: string;
  privateKey: string;
  webhookSecret?: string;
};

type RuntimeIntegrations = {
  capabilities: IntegrationCapability[];
  github?: GitHubRuntimeConfiguration;
  providers: Partial<Record<IntegrationProvider, ProviderConnection>>;
};

let cached: RuntimeIntegrations | undefined;

export function getRuntimeIntegrations(
  environment: Environment = process.env,
): RuntimeIntegrations {
  if (environment === process.env && cached) return cached;
  const parsed = parseRuntimeIntegrations(environment);
  if (environment === process.env) cached = parsed;
  return parsed;
}

export function getRuntimeIntegration(provider: IntegrationProvider) {
  return getRuntimeIntegrations().providers[provider] ?? null;
}

export function getGitHubRuntimeConfiguration() {
  return getRuntimeIntegrations().github ?? null;
}

export function requireGitHubRuntimeConfiguration() {
  const configuration = getGitHubRuntimeConfiguration();
  if (!configuration)
    throw new Error(
      "The GitHub integration is not enabled in the Towbar environment",
    );
  return configuration;
}

export function parseRuntimeIntegrations(
  environment: Environment,
): RuntimeIntegrations {
  const providers: RuntimeIntegrations["providers"] = {};
  const capabilities: IntegrationCapability[] = [];
  let github: GitHubRuntimeConfiguration | undefined;

  if (isEnabled(environment, "GITHUB")) {
    const privateKey = decodeBase64(
      required(environment, "TOWBAR_GITHUB_PRIVATE_KEY_BASE64"),
      "TOWBAR_GITHUB_PRIVATE_KEY_BASE64",
    );
    createPrivateKey(privateKey);
    github = {
      apiUrl: githubConnectionConfigurationSchema.parse({
        apiUrl:
          value(environment, "TOWBAR_GITHUB_API_URL") ??
          "https://api.github.com",
      }).apiUrl,
      appId: required(environment, "TOWBAR_GITHUB_APP_ID"),
      appSlug: z
        .string()
        .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u)
        .parse(required(environment, "TOWBAR_GITHUB_APP_SLUG")),
      privateKey,
      webhookSecret: z
        .string()
        .min(16)
        .optional()
        .parse(value(environment, "TOWBAR_GITHUB_WEBHOOK_SECRET")),
    };
    providers.github = {
      provider: "github",
      configuration: { apiUrl: github.apiUrl },
      credentials: githubConnectionCredentialsSchema.parse({
        appId: github.appId,
        privateKey: github.privateKey,
      }),
    };
    capabilities.push({ category: "source-control", provider: "github" });
  }

  addProvider(environment, providers, capabilities, "registry", "registry", {
    configuration: () =>
      registryConnectionConfigurationSchema.parse({
        allowPrivateNetwork: boolean(
          environment,
          "TOWBAR_REGISTRY_ALLOW_PRIVATE_NETWORK",
          false,
        ),
        registry: required(environment, "TOWBAR_REGISTRY_HOST"),
      }),
    credentials: () =>
      registryConnectionCredentialsSchema.parse({
        password: required(environment, "TOWBAR_REGISTRY_PASSWORD"),
        username: value(environment, "TOWBAR_REGISTRY_USERNAME") ?? "",
      }),
  });
  addS3Provider(environment, providers, capabilities, "s3", "S3");
  addS3Provider(environment, providers, capabilities, "r2", "R2");
  addProvider(environment, providers, capabilities, "gcs", "backup", {
    configuration: () =>
      gcsConnectionConfigurationSchema.parse({
        bucket: value(environment, "TOWBAR_GCS_BUCKET"),
        prefix: value(environment, "TOWBAR_GCS_PREFIX"),
        projectId: required(environment, "TOWBAR_GCS_PROJECT_ID"),
      }),
    credentials: () =>
      gcsConnectionCredentialsSchema.parse({
        serviceAccountJson: decodeBase64(
          required(environment, "TOWBAR_GCS_SERVICE_ACCOUNT_JSON_BASE64"),
          "TOWBAR_GCS_SERVICE_ACCOUNT_JSON_BASE64",
        ),
      }),
  });
  addProvider(
    environment,
    providers,
    capabilities,
    "infisical",
    "external-secrets",
    {
      configuration: () =>
        infisicalConnectionConfigurationSchema.parse({
          allowPrivateNetwork: boolean(
            environment,
            "TOWBAR_INFISICAL_ALLOW_PRIVATE_NETWORK",
            false,
          ),
          baseUrl:
            value(environment, "TOWBAR_INFISICAL_BASE_URL") ??
            "https://app.infisical.com",
        }),
      credentials: () =>
        infisicalConnectionCredentialsSchema.parse({
          clientId: required(environment, "TOWBAR_INFISICAL_CLIENT_ID"),
          clientSecret: required(environment, "TOWBAR_INFISICAL_CLIENT_SECRET"),
        }),
    },
  );
  addProvider(
    environment,
    providers,
    capabilities,
    "doppler",
    "external-secrets",
    {
      configuration: () => dopplerConnectionConfigurationSchema.parse({}),
      credentials: () =>
        dopplerConnectionCredentialsSchema.parse({
          token: required(environment, "TOWBAR_DOPPLER_TOKEN"),
        }),
    },
  );
  addProvider(environment, providers, capabilities, "cloudflare", "platform", {
    configuration: () =>
      cloudflareConnectionConfigurationSchema.parse({
        accountId: required(environment, "TOWBAR_CLOUDFLARE_ACCOUNT_ID"),
        cloudflaredImage: value(
          environment,
          "TOWBAR_CLOUDFLARE_CLOUDFLARED_IMAGE",
        ),
        zoneId: value(environment, "TOWBAR_CLOUDFLARE_ZONE_ID"),
      }),
    credentials: () =>
      cloudflareConnectionCredentialsSchema.parse({
        apiToken: required(environment, "TOWBAR_CLOUDFLARE_API_TOKEN"),
      }),
  });

  if (isEnabled(environment, "AWS")) {
    const region = z
      .string()
      .min(3)
      .max(64)
      .parse(required(environment, "TOWBAR_AWS_REGION"));
    const accessKeyId = required(environment, "TOWBAR_AWS_ACCESS_KEY_ID");
    const secretAccessKey = required(
      environment,
      "TOWBAR_AWS_SECRET_ACCESS_KEY",
    );
    providers.aws = {
      provider: "aws",
      configuration: { region },
      credentials: { accessKeyId, secretAccessKey },
    };
    capabilities.push({ category: "backup", provider: "aws" });
  }

  return { capabilities, github, providers };
}

function addS3Provider(
  environment: Environment,
  providers: RuntimeIntegrations["providers"],
  capabilities: IntegrationCapability[],
  provider: "r2" | "s3",
  prefix: "R2" | "S3",
) {
  addProvider(environment, providers, capabilities, provider, "backup", {
    configuration: () =>
      s3ConnectionConfigurationSchema.parse({
        addressingStyle:
          value(environment, `TOWBAR_${prefix}_ADDRESSING_STYLE`) ?? "auto",
        allowPrivateNetwork: boolean(
          environment,
          `TOWBAR_${prefix}_ALLOW_PRIVATE_NETWORK`,
          false,
        ),
        bucket: value(environment, `TOWBAR_${prefix}_BUCKET`),
        customCa: optionalBase64(
          environment,
          `TOWBAR_${prefix}_CUSTOM_CA_BASE64`,
        ),
        endpoint: value(environment, `TOWBAR_${prefix}_ENDPOINT`),
        prefix: value(environment, `TOWBAR_${prefix}_PREFIX`),
        region: required(environment, `TOWBAR_${prefix}_REGION`),
      }),
    credentials: () =>
      s3ConnectionCredentialsSchema.parse({
        accessKeyId: required(environment, `TOWBAR_${prefix}_ACCESS_KEY_ID`),
        secretAccessKey: required(
          environment,
          `TOWBAR_${prefix}_SECRET_ACCESS_KEY`,
        ),
      }),
  });
}

function addProvider<P extends Exclude<IntegrationProvider, "aws" | "github">>(
  environment: Environment,
  providers: RuntimeIntegrations["providers"],
  capabilities: IntegrationCapability[],
  provider: P,
  category: IntegrationCapability["category"],
  parse: { configuration: () => unknown; credentials: () => unknown },
) {
  if (!isEnabled(environment, provider)) return;
  providers[provider] = {
    provider,
    configuration: parse.configuration(),
    credentials: parse.credentials(),
  } as ProviderConnection;
  capabilities.push({ category, provider });
}

function isEnabled(environment: Environment, provider: string) {
  const environmentProvider = provider.toUpperCase();
  const name = `TOWBAR_${environmentProvider}_ENABLED`;
  const raw = value(environment, name);
  if (raw === undefined) return false;
  return enabledSchema.parse(raw) === "true";
}

function boolean(environment: Environment, name: string, fallback: boolean) {
  const raw = value(environment, name);
  return raw === undefined ? fallback : booleanSchema.parse(raw);
}

function value(environment: Environment, name: string) {
  const raw = environment[name]?.trim();
  return raw ? raw : undefined;
}

function required(environment: Environment, name: string) {
  const raw = value(environment, name);
  if (!raw)
    throw new Error(`${name} is required when its integration is enabled`);
  return raw;
}

function decodeBase64(raw: string, name: string) {
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (!decoded.trim())
    throw new Error(`${name} must contain base64-encoded text`);
  return decoded;
}

function optionalBase64(environment: Environment, name: string) {
  const raw = value(environment, name);
  return raw ? decodeBase64(raw, name) : undefined;
}
