import { desc, inArray } from "drizzle-orm";
import type { servers } from "@workspace/towbar-database/schema";
import { serverPreparations } from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
export async function getLatestServerPreparations(serverIds: string[]) {
  if (serverIds.length === 0) {
    return new Map<
      string,
      {
        configDigest: string;
        status: "queued" | "running" | "succeeded" | "failed";
      }
    >();
  }
  const preparations = await getTowbarDatabase()
    .selectDistinctOn([serverPreparations.serverId], {
      configDigest: serverPreparations.configDigest,
      serverId: serverPreparations.serverId,
      status: serverPreparations.status,
    })
    .from(serverPreparations)
    .where(inArray(serverPreparations.serverId, serverIds))
    .orderBy(serverPreparations.serverId, desc(serverPreparations.createdAt));
  return new Map(
    preparations.map((preparation) => [
      preparation.serverId,
      {
        configDigest: preparation.configDigest,
        status: preparation.status,
      },
    ]),
  );
}

export function toPublicServer(
  server: Omit<typeof servers.$inferSelect, "lastRemovedAt">,
  latestPreparation?: {
    configDigest: string;
    status: "queued" | "running" | "succeeded" | "failed";
  },
) {
  const ready =
    Boolean(server.preparedAt) &&
    server.preparedConfigDigest === server.configDigest;
  const currentPreparation =
    latestPreparation?.configDigest === server.configDigest;
  return {
    archivedAt: server.archivedAt,
    canonicalIp: server.canonicalIp,
    config: {
      buildConcurrency: server.config.buildConcurrency,
      previewBuildConcurrency: server.config.previewBuildConcurrency,
      hostLogCollection: server.config.hostLogCollection === true,
      ip: server.config.ip,
      ssh: server.config.ssh,
    },
    createdAt: server.createdAt,
    id: server.id,
    name: server.name,
    preparedAt: server.preparedAt,
    updatedAt: server.updatedAt,
    setupStatus: ready
      ? ("ready" as const)
      : currentPreparation &&
          (latestPreparation.status === "queued" ||
            latestPreparation.status === "running")
        ? ("preparing" as const)
        : currentPreparation && latestPreparation.status === "failed"
          ? ("failed" as const)
          : ("pending" as const),
  };
}
