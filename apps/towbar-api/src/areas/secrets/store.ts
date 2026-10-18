import { recordAuditEvent } from "../../infrastructure/audit.js";
import { auditAttribution } from "../auth/actor-context.js";
import { createPrivateKey, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  applySecretMutation,
  decryptCredential,
  encryptCredential,
  parseCredentialsMasterKey,
  requiredKeysForStage,
  validateSecretObject,
} from "@workspace/towbar-core";
import {
  apps,
  managedSecrets,
  serverCredentialVerifications,
  servers,
  sourceEnvironments,
  sources,
  sshHostKeys,
  workspaces,
} from "@workspace/towbar-database/schema";
import { getEnv } from "../../env.js";
import { conflict, notFound, unprocessable } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import type { SecretMutation } from "@workspace/towbar-core";

export type SecretDatabase = Pick<
  ReturnType<typeof getTowbarDatabase>,
  "select" | "insert" | "update" | "delete" | "execute"
>;
export type SecretOwner = { workspaceId: string } & (
  | { type: "workspace" }
  | { type: "repository"; id: string }
  | { type: "app"; id: string }
  | { type: "server"; id: string }
);
export type SecretSlot = SecretOwner & {
  environment: string;
  stage: string;
};
export const ownerKey = (owner: SecretOwner) =>
  owner.type === "workspace"
    ? `workspace:${owner.workspaceId}`
    : `${owner.type}:${owner.id}`;
export const slotKey = (slot: SecretSlot) =>
  `${slot.workspaceId}:${ownerKey(slot)}:${slot.environment}:${slot.stage}`;

export async function requireSecretOwner(
  owner: SecretOwner,
  database: SecretDatabase = getTowbarDatabase(),
) {
  if (owner.type === "workspace") {
    const [workspace] = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, owner.workspaceId))
      .limit(1);
    if (!workspace) throw notFound("Workspace");
    return { sourceId: null, appId: null, serverId: null };
  }
  const table =
    owner.type === "app"
      ? apps
      : owner.type === "repository"
        ? sources
        : servers;
  const [row] = await database
    .select()
    .from(table)
    .where(
      and(
        eq(table.id, owner.id),
        eq(table.workspaceId, owner.workspaceId),
        owner.type === "server" ? isNull(servers.archivedAt) : undefined,
      ),
    )
    .limit(1);
  if (!row) throw notFound(owner.type);
  return {
    sourceId:
      owner.type === "app"
        ? (row as typeof apps.$inferSelect).sourceId
        : owner.type === "repository"
          ? owner.id
          : null,
    appId: owner.type === "app" ? owner.id : null,
    serverId: owner.type === "server" ? owner.id : null,
  };
}

export function secretSlotFilter(slot: SecretSlot) {
  return and(
    eq(managedSecrets.workspaceId, slot.workspaceId),
    eq(managedSecrets.owner, ownerKey(slot)),
    eq(managedSecrets.environment, slot.environment),
    eq(managedSecrets.stage, slot.stage),
  );
}

async function declaredKeysForSlot(slot: SecretSlot, database: SecretDatabase) {
  if (slot.type !== "app") return null;
  const [instance] = await database
    .select({
      declarations: apps.requiredSecrets,
      environment: sourceEnvironments.name,
    })
    .from(apps)
    .innerJoin(
      sourceEnvironments,
      and(
        eq(sourceEnvironments.id, apps.sourceEnvironmentId),
        eq(sourceEnvironments.sourceId, apps.sourceId),
      ),
    )
    .where(and(eq(apps.id, slot.id), eq(apps.workspaceId, slot.workspaceId)))
    .limit(1);
  if (!instance)
    throw conflict(
      "This instance requires an environment mapping",
      "ENVIRONMENT_REQUIRED",
    );
  if (
    slot.environment !== instance.environment &&
    slot.environment !== `preview:${instance.environment}`
  ) {
    throw unprocessable(
      "Secret environment does not match this instance",
      "SECRET_ENVIRONMENT_MISMATCH",
    );
  }
  return requiredKeysForStage(instance.declarations, slot.stage);
}

function valuesFromSecretRow(
  slot: SecretSlot,
  row: typeof managedSecrets.$inferSelect | undefined,
  declaredKeys: string[] | null,
) {
  if (!row) return {} as Record<string, string>;
  try {
    const values = decryptCredential<Record<string, string>>({
      associatedData: `${slotKey(slot)}:${row.id}`,
      masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
      envelope: row.encryptedPayload,
    });
    return declaredKeys === null
      ? values
      : Object.fromEntries(
          declaredKeys.flatMap((key) =>
            Object.hasOwn(values, key) ? [[key, values[key]!]] : [],
          ),
        );
  } catch {
    throw unprocessable(
      "Stored credentials could not be unlocked. Check the installation encryption key.",
      "SECRET_DECRYPTION_FAILED",
    );
  }
}

export async function readSecretMetadata(
  slot: SecretSlot,
  database: SecretDatabase = getTowbarDatabase(),
) {
  const declaredKeys = await declaredKeysForSlot(slot, database);
  const [row] = await database
    .select()
    .from(managedSecrets)
    .where(secretSlotFilter(slot))
    .limit(1);
  const metadata = {
    keys: row?.keys ?? [],
    revision: row?.revision ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
  if (declaredKeys === null)
    return { ...metadata, missingKeys: [] as string[], declared: false };
  const values = valuesFromSecretRow(slot, row, declaredKeys);
  return {
    ...metadata,
    keys: [...declaredKeys].sort(),
    missingKeys: declaredKeys
      .filter((key) => !Object.hasOwn(values, key))
      .sort(),
    declared: true,
  };
}

export async function readSecretValues(
  slot: SecretSlot,
  database: SecretDatabase = getTowbarDatabase(),
) {
  const declaredKeys = await declaredKeysForSlot(slot, database);
  const [row] = await database
    .select()
    .from(managedSecrets)
    .where(secretSlotFilter(slot))
    .limit(1);
  return {
    values: valuesFromSecretRow(slot, row, declaredKeys),
    revision: row?.revision ?? null,
  };
}

export async function mutateSecret(
  slot: SecretSlot,
  mutation: SecretMutation,
  actorUserId: string | null,
  validate?: (values: Record<string, string>) => void,
) {
  return await getTowbarDatabase().transaction(async (database) =>
    mutateSecretInDatabase(slot, mutation, actorUserId, validate, database),
  );
}

async function mutateSecretInDatabase(
  slot: SecretSlot,
  mutation: SecretMutation,
  actorUserId: string | null,
  validate: ((values: Record<string, string>) => void) | undefined,
  database: SecretDatabase,
) {
  // Serialize the empty-slot case too; SELECT FOR UPDATE alone cannot lock a missing row.
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${slotKey(slot)}, 0))`,
  );
  const owner = await requireSecretOwner(slot, database);
  const [row] = await database
    .select()
    .from(managedSecrets)
    .where(secretSlotFilter(slot))
    .limit(1);
  if ((row?.revision ?? null) !== mutation.expectedRevision)
    throw conflict(
      "These secrets changed after loading. Refresh before saving.",
      "SECRET_VERSION_CHANGED",
    );
  const declaredKeys = await declaredKeysForSlot(slot, database);
  const mutatedKeys = [...Object.keys(mutation.set), ...mutation.delete];
  if (
    declaredKeys !== null &&
    mutatedKeys.some((key) => !declaredKeys.includes(key))
  ) {
    throw unprocessable(
      "Required secret keys are managed in YAML. Edit or clear declared values here; sync YAML to add or remove keys.",
      "SECRET_DECLARATIONS_MANAGED",
    );
  }
  const currentValues = valuesFromSecretRow(slot, row, declaredKeys);
  const values = applySecretMutation(currentValues, mutation);
  if (["build", "deployment", "pre_deploy", "post_deploy"].includes(slot.stage))
    validateSecretObject(
      values,
      slot.stage === "build" ? "build" : "deployment",
    );
  if (Buffer.byteLength(JSON.stringify(values), "utf8") > 256 * 1024)
    throw unprocessable(
      "Secret values exceed the 256 KiB limit",
      "SECRET_TOO_LARGE",
    );
  if (slot.stage === "build" && Object.hasOwn(values, "TOWBAR_BUILD_ENV_JSON"))
    throw unprocessable("TOWBAR_BUILD_ENV_JSON is reserved by Towbar");
  validate?.(values);
  const id = row?.id ?? randomUUID();
  const revision = randomUUID();
  const updatedAt = new Date();
  const record = {
    ...owner,
    id,
    workspaceId: slot.workspaceId,
    owner: ownerKey(slot),
    environment: slot.environment,
    stage: slot.stage,
    revision,
    updatedAt,
    keys:
      declaredKeys === null
        ? Object.keys(values).sort()
        : [...declaredKeys].sort(),
    encryptedPayload: encryptCredential({
      associatedData: `${slotKey(slot)}:${id}`,
      masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
      value: values,
    }),
  };
  if (row)
    await database
      .update(managedSecrets)
      .set(record)
      .where(eq(managedSecrets.id, id));
  else await database.insert(managedSecrets).values(record);
  await recordAuditEvent(database, {
    workspaceId: slot.workspaceId,
    actorUserId,
    action: "secrets.updated",
    targetType: slot.type,
    targetId: ownerKey(slot),
    metadata: {
      environment: slot.environment,
      stage: slot.stage,
      revision,
    },
    ...auditAttribution(),
  });
  return { keys: record.keys, revision, updatedAt };
}

export async function mutateServerCredentials(
  slot: SecretSlot & { type: "server" },
  mutation: SecretMutation,
  actorUserId: string | null,
) {
  return await getTowbarDatabase().transaction(async (database) => {
    const credential = await mutateSecretInDatabase(
      slot,
      mutation,
      actorUserId,
      validateServerCredentialValues,
      database,
    );
    if (mutation.delete.includes("privateKey")) {
      await database
        .delete(serverCredentialVerifications)
        .where(eq(serverCredentialVerifications.serverId, slot.id));
      await database
        .delete(sshHostKeys)
        .where(eq(sshHostKeys.serverId, slot.id));
      await database
        .update(servers)
        .set({ privateKeyId: null, updatedAt: new Date() })
        .where(eq(servers.id, slot.id));
    }
    return credential;
  });
}

export function validateServerCredentialValues(values: Record<string, string>) {
  if (Object.keys(values).some((key) => key !== "privateKey"))
    throw unprocessable("Only the SSH private key is stored per server");
  if (values.privateKey !== undefined) {
    if (!values.privateKey.trim())
      throw unprocessable("Enter an SSH private key or remove the key");
    if (!values.privateKey.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
      try {
        createPrivateKey(values.privateKey);
      } catch {
        throw unprocessable("Enter a valid unencrypted SSH private key");
      }
    }
  }
}

export async function promoteVerifiedServerPrivateKey(
  input: {
    actorUserId: string | null;
    expectedRevision: string | null;
    privateKey: string;
    privateKeyId: string;
    serverId: string;
    workspaceId: string;
  },
  database: SecretDatabase,
) {
  const slot: SecretSlot = {
    type: "server",
    id: input.serverId,
    workspaceId: input.workspaceId,
    environment: "production",
    stage: "credentials",
  };
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${slotKey(slot)}, 0))`,
  );
  const owner = await requireSecretOwner(slot, database);
  const [row] = await database
    .select()
    .from(managedSecrets)
    .where(secretSlotFilter(slot))
    .limit(1);
  if ((row?.revision ?? null) !== input.expectedRevision)
    throw conflict(
      "Server credentials changed during verification. Enter the key again.",
      "SECRET_VERSION_CHANGED",
    );
  const values = {
    ...valuesFromSecretRow(slot, row, null),
    privateKey: input.privateKey,
  };
  validateServerCredentialValues(values);
  const id = row?.id ?? randomUUID();
  const revision = randomUUID();
  const updatedAt = new Date();
  const record = {
    ...owner,
    id,
    workspaceId: slot.workspaceId,
    owner: ownerKey(slot),
    environment: slot.environment,
    stage: slot.stage,
    revision,
    updatedAt,
    keys: Object.keys(values).sort(),
    encryptedPayload: encryptCredential({
      associatedData: `${slotKey(slot)}:${id}`,
      masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
      value: values,
    }),
  };
  if (row)
    await database
      .update(managedSecrets)
      .set(record)
      .where(eq(managedSecrets.id, id));
  else await database.insert(managedSecrets).values(record);
  await recordAuditEvent(database, {
    workspaceId: slot.workspaceId,
    actorUserId: input.actorUserId,
    action: "server.credentials.verified",
    targetType: "server",
    targetId: input.serverId,
    metadata: { revision },
    ...auditAttribution(),
  });
  await database
    .update(servers)
    .set({ privateKeyId: input.privateKeyId, updatedAt })
    .where(
      and(
        eq(servers.id, input.serverId),
        eq(servers.workspaceId, input.workspaceId),
      ),
    );
  return { keys: record.keys, revision, updatedAt };
}

export async function resolveServerCredentials(
  input: { workspaceId: string; serverId: string },
  database: SecretDatabase = getTowbarDatabase(),
) {
  const result = await readSecretValues(
    {
      type: "server",
      id: input.serverId,
      workspaceId: input.workspaceId,
      environment: "production",
      stage: "credentials",
    },
    database,
  );
  if (!result.values.privateKey)
    throw unprocessable(
      "Configure the SSH private key in Server → Settings → Credentials",
      "SERVER_CREDENTIALS_MISSING",
    );
  return result;
}

export async function revealSecretValue(
  slot: SecretSlot,
  key: string,
  actorUserId: string | null,
) {
  await requireSecretOwner(slot);
  const { values, revision } = await readSecretValues(slot);
  if (!Object.hasOwn(values, key)) throw notFound("Secret");
  await recordAuditEvent(getTowbarDatabase(), {
    workspaceId: slot.workspaceId,
    actorUserId,
    action: "secrets.revealed",
    targetType: slot.type,
    targetId: ownerKey(slot),
    metadata: {
      environment: slot.environment,
      stage: slot.stage,
      key,
      revision,
    },
    ...auditAttribution(),
  });
  return { value: values[key]!, revision };
}

export async function revealSecretValues(
  slot: SecretSlot,
  actorUserId: string | null,
) {
  await requireSecretOwner(slot);
  const { values, revision } = await readSecretValues(slot);
  await recordAuditEvent(getTowbarDatabase(), {
    workspaceId: slot.workspaceId,
    actorUserId,
    action: "secrets.revealed",
    targetType: slot.type,
    targetId: ownerKey(slot),
    metadata: {
      environment: slot.environment,
      stage: slot.stage,
      keyCount: Object.keys(values).length,
      revision,
    },
    ...auditAttribution(),
  });
  return { values, revision };
}
