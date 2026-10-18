import { randomUUID } from "node:crypto";
import {
  integrationInstallations,
  servers,
  sourceEnvironments,
  sources,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";

export async function seedConnectedEnvironment(
  workspaceId: string,
  repositoryName = "platform",
) {
  const database = getTowbarDatabase();
  const installationId = randomUUID();
  const sourceId = randomUUID();
  await database.insert(integrationInstallations).values({
    provider: "github",
    id: installationId,
    workspaceId,
    externalId: installationId,
    principalName: "api-test",
    principalType: "Organization",
  });
  await database.insert(sources).values({
    id: sourceId,
    workspaceId,
    integrationInstallationId: installationId,
    repositoryOwner: "api-test",
    repositoryName,
  });
  const [environment] = await database
    .insert(sourceEnvironments)
    .values({
      sourceId,
      name: "production",
      branch: "main",
    })
    .returning({ id: sourceEnvironments.id });
  return { sourceId, environmentId: environment!.id };
}

export async function seedApiServers(
  rows: { id: string; workspaceId: string; ip: string }[],
) {
  await getTowbarDatabase()
    .insert(servers)
    .values(
      rows.map(({ id, workspaceId, ip }) => ({
        id,
        workspaceId,
        canonicalIp: ip,
        configDigest: "test-digest",
        config: {
          ip,
          ssh: { host: ip, port: 22, username: "ubuntu" },
          buildConcurrency: 1,
        },
      })),
    );
}
