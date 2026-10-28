import type {
  IntegrationProvider,
  IntegrationPurpose,
  IntegrationScope,
  IntegrationTarget,
} from "@workspace/towbar-core";
import type { integrationAuthorizations } from "@workspace/towbar-database/schema";

import { notFound } from "../../http/errors.js";
import { getRuntimeIntegration } from "../../infrastructure/runtime-integrations.js";

type Connection = typeof integrationAuthorizations.$inferSelect;

const purposeByProvider: Record<IntegrationProvider, IntegrationPurpose> = {
  aws: "backup",
  cloudflare: "ingress",
  doppler: "secret",
  gcs: "backup",
  github: "source",
  infisical: "secret",
  r2: "backup",
  registry: "image",
  s3: "backup",
};

export function resolveIntegration(input: {
  workspaceId: string;
  slug: string;
  target: IntegrationTarget;
  providers: readonly IntegrationProvider[];
  expectedRevision?: number;
}) {
  const runtime = runtimeResolution(
    input.workspaceId,
    input.slug,
    input.providers,
  );
  if (runtime) return Promise.resolve(runtime);
  return Promise.reject(notFound("Integration"));
}

export function resolveIntegrationById(input: {
  workspaceId: string;
  id: string;
  target: IntegrationTarget;
  providers: readonly IntegrationProvider[];
  expectedRevision?: number;
}) {
  if (input.id.startsWith("environment:")) {
    const runtime = runtimeResolution(
      input.workspaceId,
      input.id.slice("environment:".length),
      input.providers,
    );
    if (!runtime) return Promise.reject(notFound("Integration"));
    return Promise.resolve(runtime);
  }
  return Promise.reject(notFound("Integration"));
}

function runtimeResolution(
  workspaceId: string,
  slug: string,
  providers: readonly IntegrationProvider[],
) {
  const provider = providers.find((candidate) => candidate === slug);
  if (!provider) return null;
  const connectionInput = getRuntimeIntegration(provider);
  if (!connectionInput) return null;
  const now = new Date(0);
  const connection: Connection = {
    createdAt: now,
    credentialHint: null,
    description: "Configured by the Towbar runtime environment",
    disconnectedAt: null,
    encryptedPayload: null,
    id: `environment:${provider}`,
    name: provider,
    provider,
    revision: 1,
    scopes: [
      {
        kind: "workspace",
        purpose: purposeByProvider[provider],
      } as IntegrationScope,
    ],
    slug: provider,
    updatedAt: now,
    verificationMessage: "Configured by the Towbar runtime environment",
    verificationStatus: "verified",
    verifiedAt: null,
    workspaceId,
  };
  return { connection, connectionInput };
}
