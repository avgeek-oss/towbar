import { recordAuditEvent } from "../../infrastructure/audit.js";
import { auditAttribution } from "../auth/actor-context.js";
import { captureQueuedActor } from "../auth/actor-context.js";
import { randomUUID } from "node:crypto";
import { enqueueMonitoringAgent } from "../../infrastructure/temporal.js";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";

import {
  digestValue,
  getDeployableDeploymentDigest,
  requiresServerPreparation,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  imageVulnerabilityScans,
  logCollectors,
  managedSecrets,
  monitoringAgents,
  previewEnvironments,
  resourceOperations,
  serverChecks,
  serverCredentialVerifications,
  serverPreparations,
  servers,
  sshHostKeys,
} from "@workspace/towbar-database/schema";

import { conflict, notFound } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { getServer, serverSelection, toPublicServer } from "./service.js";

import type { NormalizedServer } from "@workspace/towbar-core";

export async function createServer(input: {
  config: NormalizedServer;
  workspaceId: string;
}) {
  return await getTowbarDatabase().transaction(async (transaction) => {
    const [existing] = await transaction
      .select(serverSelection)
      .from(servers)
      .where(
        and(
          eq(servers.workspaceId, input.workspaceId),
          eq(servers.canonicalIp, input.config.ip),
        ),
      )
      .for("update")
      .limit(1);
    if (existing && !existing.archivedAt) {
      throw conflict(
        `Server '${input.config.ip}' is already configured`,
        "SERVER_ALREADY_EXISTS",
      );
    }
    const configDigest = digestValue(input.config);
    const [server] = existing
      ? await transaction
          .update(servers)
          .set({
            archivedAt: null,
            config: input.config,
            configDigest,
            preparedConfigDigest: requiresServerPreparation(
              existing.config,
              input.config,
            )
              ? existing.preparedConfigDigest
              : configDigest,
            updatedAt: new Date(),
          })
          .where(eq(servers.id, existing.id))
          .returning(serverSelection)
      : await transaction
          .insert(servers)
          .values({
            canonicalIp: input.config.ip,
            config: input.config,
            configDigest,
            workspaceId: input.workspaceId,
          })
          .returning(serverSelection);
    if (!server) throw new Error("Unable to create server");
    return toPublicServer(server);
  });
}

export async function updateServer(input: {
  config: NormalizedServer;
  serverId: string;
  workspaceId: string;
}) {
  return await getTowbarDatabase().transaction(async (transaction) => {
    const [current] = await transaction
      .select(serverSelection)
      .from(servers)
      .where(
        and(
          eq(servers.id, input.serverId),
          eq(servers.workspaceId, input.workspaceId),
          isNull(servers.archivedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) throw notFound("Server");
    if (input.config.ip !== current.canonicalIp) {
      throw conflict(
        "A server IP cannot be changed. Add a new server instead.",
        "SERVER_IP_IMMUTABLE",
      );
    }
    const configDigest = digestValue(input.config);
    const preservePreparation =
      Boolean(current.preparedAt) &&
      current.preparedConfigDigest === current.configDigest &&
      !requiresServerPreparation(current.config, input.config);
    const [server] = await transaction
      .update(servers)
      .set({
        config: input.config,
        configDigest,
        preparedConfigDigest: preservePreparation
          ? configDigest
          : current.preparedConfigDigest,
        updatedAt: new Date(),
      })
      .where(eq(servers.id, current.id))
      .returning(serverSelection);
    if (!server) throw new Error("Unable to update server");
    const deployables = await transaction
      .select({
        config: apps.config,
        id: apps.id,
        sourceInputDigest: apps.sourceInputDigest,
      })
      .from(apps)
      .where(and(eq(apps.serverId, current.id), isNull(apps.archivedAt)));
    for (const deployable of deployables) {
      await transaction
        .update(apps)
        .set({
          deploymentDigest: getDeployableDeploymentDigest({
            deployable: deployable.config,
            server: input.config,
            sourceInputDigest: deployable.sourceInputDigest,
          }),
          updatedAt: new Date(),
        })
        .where(eq(apps.id, deployable.id));
    }
    return toPublicServer(server);
  });
}

export async function updateServerName(input: {
  name: string | null;
  serverId: string;
  workspaceId: string;
}) {
  const [server] = await getTowbarDatabase()
    .update(servers)
    .set({ name: input.name, updatedAt: new Date() })
    .where(
      and(
        eq(servers.id, input.serverId),
        eq(servers.workspaceId, input.workspaceId),
        isNull(servers.archivedAt),
      ),
    )
    .returning({ id: servers.id });
  if (!server) throw notFound("Server");
  return getServer(server.id, input.workspaceId);
}

export async function removeServer(input: {
  serverId: string;
  workspaceId: string;
  requestedBy: string | null;
}) {
  const pending = await getTowbarDatabase().transaction(async (transaction) => {
    const [server] = await transaction
      .select({ id: servers.id })
      .from(servers)
      .where(
        and(
          eq(servers.id, input.serverId),
          eq(servers.workspaceId, input.workspaceId),
          isNull(servers.archivedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!server) throw notFound("Server");
    const [collector] = await transaction
      .select()
      .from(logCollectors)
      .where(eq(logCollectors.serverId, server.id))
      .for("update");
    if (collector && collector.status !== "disabled")
      throw conflict(
        "Disable centralized log collection and wait for removal before removing this server.",
        "LOG_COLLECTOR_ACTIVE",
      );
    const active = await Promise.all([
      transaction
        .select({ id: serverCredentialVerifications.id })
        .from(serverCredentialVerifications)
        .where(
          and(
            eq(serverCredentialVerifications.serverId, server.id),
            inArray(serverCredentialVerifications.status, [
              "queued",
              "running",
            ]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: serverChecks.id })
        .from(serverChecks)
        .where(
          and(
            eq(serverChecks.serverId, server.id),
            inArray(serverChecks.status, ["queued", "running"]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: serverPreparations.id })
        .from(serverPreparations)
        .where(
          and(
            eq(serverPreparations.serverId, server.id),
            inArray(serverPreparations.status, ["queued", "running"]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.serverId, server.id),
            notInArray(deployments.state, [
              "cancelled",
              "failed",
              "skipped",
              "succeeded",
              "succeeded_with_warnings",
            ]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: resourceOperations.id })
        .from(resourceOperations)
        .where(
          and(
            eq(resourceOperations.serverId, server.id),
            inArray(resourceOperations.state, ["queued", "running"]),
          ),
        )
        .limit(1),
      transaction
        .select({ id: imageVulnerabilityScans.id })
        .from(imageVulnerabilityScans)
        .where(
          and(
            eq(imageVulnerabilityScans.serverId, server.id),
            inArray(imageVulnerabilityScans.state, ["pending", "running"]),
          ),
        )
        .limit(1),
    ]);
    if (active.some((rows) => rows.length))
      throw conflict(
        "Wait for active server operations to finish before removing this server.",
        "SERVER_BUSY",
      );
    const [agent] = await transaction
      .select()
      .from(monitoringAgents)
      .where(eq(monitoringAgents.serverId, server.id))
      .for("update")
      .limit(1);
    if (agent && agent.status !== "disabled") {
      if (["queued", "installing", "uninstalling"].includes(agent.status))
        throw conflict(
          "Wait for the monitoring operation to finish before removing this server.",
          "SERVER_BUSY",
        );
      const generation = randomUUID();
      await transaction
        .update(monitoringAgents)
        .set({
          generation,
          desiredState: "disabled",
          status: "queued",
          tokenHash: null,
          encryptedToken: null,
          removalRequested: true,
          removalRequestedBy: input.requestedBy,
          requestedBy: input.requestedBy,
          ...captureQueuedActor(input.workspaceId, ["server.remove"]),
          errorMessage: null,
          operationStartedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(monitoringAgents.serverId, server.id));
      return { serverId: server.id, generation };
    }
    const now = new Date();
    if (agent)
      await transaction
        .update(monitoringAgents)
        .set({
          tokenHash: null,
          encryptedToken: null,
          removalRequestedBy: null,
          desiredState: "disabled",
        })
        .where(eq(monitoringAgents.serverId, server.id));
    await transaction
      .delete(managedSecrets)
      .where(eq(managedSecrets.serverId, server.id));
    await transaction
      .update(sshHostKeys)
      .set({ revokedAt: now })
      .where(
        and(eq(sshHostKeys.serverId, server.id), isNull(sshHostKeys.revokedAt)),
      );
    await transaction
      .update(apps)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(eq(apps.serverId, server.id), isNull(apps.archivedAt)));
    await transaction
      .update(previewEnvironments)
      .set({ deletedAt: now, status: "deleted", updatedAt: now })
      .where(
        and(
          eq(previewEnvironments.serverId, server.id),
          isNull(previewEnvironments.deletedAt),
        ),
      );
    await transaction
      .update(servers)
      .set({
        archivedAt: now,
        privateKeyId: null,
        preparedAt: null,
        preparedConfigDigest: null,
        updatedAt: now,
      })
      .where(eq(servers.id, server.id));
    await recordAuditEvent(transaction, {
      action: "server.removed",
      actorUserId: input.requestedBy,
      targetId: server.id,
      targetType: "server",
      workspaceId: input.workspaceId,
      metadata: {},
      ...auditAttribution(),
    });
  });
  if (pending) await enqueueMonitoringAgent(pending).catch(() => undefined);
  return { pending: Boolean(pending) };
}
