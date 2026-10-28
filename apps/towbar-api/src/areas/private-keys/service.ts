import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  decryptCredential,
  encryptCredential,
  parseCredentialsMasterKey,
} from "@workspace/towbar-core";
import {
  serverCredentialVerifications,
  servers,
  workspacePrivateKeys,
} from "@workspace/towbar-database/schema";
import { getEnv } from "../../env.js";
import { conflict, notFound, unprocessable } from "../../http/errors.js";
import { getTowbarDatabase } from "../../infrastructure/database.js";

type PrivateKeyAlgorithm = "ed25519" | "rsa" | "other";
export type PrivateKeyMaterial = {
  algorithm: PrivateKeyAlgorithm;
  privateKey: string;
  publicKey: string | null;
};

const publicSelection = {
  algorithm: workspacePrivateKeys.algorithm,
  createdAt: workspacePrivateKeys.createdAt,
  description: workspacePrivateKeys.description,
  generated: workspacePrivateKeys.generated,
  id: workspacePrivateKeys.id,
  name: workspacePrivateKeys.name,
  publicKey: workspacePrivateKeys.publicKey,
  updatedAt: workspacePrivateKeys.updatedAt,
} as const;

function associatedData(workspaceId: string, id: string) {
  return `workspace-private-key:${workspaceId}:${id}`;
}

function sshString(value: Buffer | string) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function sshMpint(value: Buffer) {
  let body = value;
  while (body.length > 1 && body[0] === 0) body = body.subarray(1);
  if (body[0] && (body[0] & 0x80) !== 0)
    body = Buffer.concat([Buffer.from([0]), body]);
  return sshString(body);
}

function toOpenSshPublicKey(key: KeyObject, name: string) {
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x) {
    const algorithm = "ssh-ed25519";
    const body = Buffer.concat([
      sshString(algorithm),
      sshString(Buffer.from(jwk.x, "base64url")),
    ]);
    return `${algorithm} ${body.toString("base64")} ${name}`;
  }
  if (jwk.kty === "RSA" && jwk.e && jwk.n) {
    const algorithm = "ssh-rsa";
    const body = Buffer.concat([
      sshString(algorithm),
      sshMpint(Buffer.from(jwk.e, "base64url")),
      sshMpint(Buffer.from(jwk.n, "base64url")),
    ]);
    return `${algorithm} ${body.toString("base64")} ${name}`;
  }
  throw unprocessable("Use an ED25519 or RSA SSH private key");
}

function publicKeyIdentity(value: string) {
  const [algorithm, body] = value.trim().split(/\s+/u);
  if (!algorithm || !body || !body.match(/^[A-Za-z0-9+/=]+$/u))
    throw unprocessable("Enter a valid OpenSSH public key");
  return `${algorithm} ${body}`;
}

function algorithmFromPublicKey(value: string): PrivateKeyAlgorithm {
  const algorithm = value.trim().split(/\s+/u)[0];
  return algorithm === "ssh-ed25519"
    ? "ed25519"
    : algorithm === "ssh-rsa"
      ? "rsa"
      : "other";
}

export function normalizeManualKey(input: {
  name: string;
  privateKey: string;
  publicKey?: string | null;
}): PrivateKeyMaterial {
  const privateKey = input.privateKey.trim();
  if (!privateKey) throw unprocessable("Enter an unencrypted SSH private key");
  let parsed: KeyObject | null = null;
  try {
    parsed = createPrivateKey(privateKey);
  } catch {
    if (!privateKey.includes("-----BEGIN OPENSSH PRIVATE KEY-----"))
      throw unprocessable("Enter a valid unencrypted SSH private key");
  }
  const suppliedPublicKey = input.publicKey?.trim() || null;
  if (!parsed) {
    if (suppliedPublicKey) publicKeyIdentity(suppliedPublicKey);
    return {
      algorithm: suppliedPublicKey
        ? algorithmFromPublicKey(suppliedPublicKey)
        : "other",
      privateKey,
      publicKey: suppliedPublicKey,
    };
  }
  const publicKey = toOpenSshPublicKey(createPublicKey(parsed), input.name);
  if (
    suppliedPublicKey &&
    publicKeyIdentity(suppliedPublicKey) !== publicKeyIdentity(publicKey)
  )
    throw unprocessable("The public key does not match the private key");
  return {
    algorithm: algorithmFromPublicKey(publicKey),
    privateKey,
    publicKey,
  };
}

export function generateKey(
  algorithm: Exclude<PrivateKeyAlgorithm, "other">,
  name: string,
): PrivateKeyMaterial {
  const pair =
    algorithm === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("rsa", { modulusLength: 4096 });
  return {
    algorithm,
    privateKey: pair.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string,
    publicKey: toOpenSshPublicKey(pair.publicKey, name),
  };
}

async function requireUniqueName(
  workspaceId: string,
  name: string,
  exceptId?: string,
) {
  const [existing] = await getTowbarDatabase()
    .select({ id: workspacePrivateKeys.id })
    .from(workspacePrivateKeys)
    .where(
      and(
        eq(workspacePrivateKeys.workspaceId, workspaceId),
        eq(workspacePrivateKeys.name, name),
        exceptId ? sql`${workspacePrivateKeys.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  if (existing)
    throw conflict(
      "A private key with this name already exists.",
      "PRIVATE_KEY_NAME_EXISTS",
    );
}

export async function listWorkspacePrivateKeys(workspaceId: string) {
  return await getTowbarDatabase()
    .select({
      ...publicSelection,
      usageCount: sql<number>`count(${servers.id})::int`,
    })
    .from(workspacePrivateKeys)
    .leftJoin(servers, eq(servers.privateKeyId, workspacePrivateKeys.id))
    .where(eq(workspacePrivateKeys.workspaceId, workspaceId))
    .groupBy(workspacePrivateKeys.id)
    .orderBy(workspacePrivateKeys.name);
}

export async function createWorkspacePrivateKey(input: {
  algorithm?: "ed25519" | "rsa";
  description?: string | null;
  name: string;
  privateKey?: string;
  publicKey?: string | null;
  workspaceId: string;
}) {
  await requireUniqueName(input.workspaceId, input.name);
  const generated = Boolean(input.algorithm);
  const material = input.algorithm
    ? generateKey(input.algorithm, input.name)
    : normalizeManualKey({
        name: input.name,
        privateKey: input.privateKey ?? "",
        publicKey: input.publicKey,
      });
  const id = randomUUID();
  const now = new Date();
  const [created] = await getTowbarDatabase()
    .insert(workspacePrivateKeys)
    .values({
      algorithm: material.algorithm,
      createdAt: now,
      description: input.description || null,
      encryptedPrivateKey: encryptCredential({
        associatedData: associatedData(input.workspaceId, id),
        masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
        value: material.privateKey,
      }),
      generated,
      id,
      name: input.name,
      publicKey: material.publicKey,
      updatedAt: now,
      workspaceId: input.workspaceId,
    })
    .returning(publicSelection);
  if (!created) throw new Error("Unable to create private key");
  return { ...created, usageCount: 0 };
}

async function getPrivateKeyRow(id: string, workspaceId: string) {
  const [key] = await getTowbarDatabase()
    .select()
    .from(workspacePrivateKeys)
    .where(
      and(
        eq(workspacePrivateKeys.id, id),
        eq(workspacePrivateKeys.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!key) throw notFound("Private key");
  return key;
}

export async function revealWorkspacePrivateKey(
  id: string,
  workspaceId: string,
) {
  const key = await getPrivateKeyRow(id, workspaceId);
  try {
    return decryptCredential<string>({
      associatedData: associatedData(workspaceId, id),
      envelope: key.encryptedPrivateKey,
      masterKey: parseCredentialsMasterKey(getEnv().TOWBAR_CREDENTIALS_KEY),
    });
  } catch {
    throw unprocessable(
      "The private key could not be unlocked. Check the installation encryption key.",
      "PRIVATE_KEY_DECRYPTION_FAILED",
    );
  }
}

async function requireKeyUnused(id: string) {
  const [server] = await getTowbarDatabase()
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.privateKeyId, id))
    .limit(1);
  if (server)
    throw conflict(
      "Detach this key from every server before changing or deleting it.",
      "PRIVATE_KEY_IN_USE",
    );
  const [verification] = await getTowbarDatabase()
    .select({ id: serverCredentialVerifications.id })
    .from(serverCredentialVerifications)
    .where(
      and(
        eq(serverCredentialVerifications.privateKeyId, id),
        inArray(serverCredentialVerifications.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (verification)
    throw conflict(
      "Wait for the active server verification before changing or deleting this key.",
      "PRIVATE_KEY_VERIFICATION_ACTIVE",
    );
}

export async function updateWorkspacePrivateKey(input: {
  description?: string | null;
  id: string;
  name: string;
  privateKey?: string;
  publicKey?: string | null;
  workspaceId: string;
}) {
  const current = await getPrivateKeyRow(input.id, input.workspaceId);
  await requireUniqueName(input.workspaceId, input.name, input.id);
  let material: PrivateKeyMaterial | null = null;
  if (input.privateKey !== undefined) {
    await requireKeyUnused(input.id);
    material = normalizeManualKey({
      name: input.name,
      privateKey: input.privateKey,
      publicKey: input.publicKey,
    });
  }
  const now = new Date();
  const [updated] = await getTowbarDatabase()
    .update(workspacePrivateKeys)
    .set({
      algorithm: material?.algorithm ?? current.algorithm,
      description: input.description || null,
      encryptedPrivateKey: material
        ? encryptCredential({
            associatedData: associatedData(input.workspaceId, input.id),
            masterKey: parseCredentialsMasterKey(
              getEnv().TOWBAR_CREDENTIALS_KEY,
            ),
            value: material.privateKey,
          })
        : current.encryptedPrivateKey,
      generated: material ? false : current.generated,
      name: input.name,
      publicKey: material ? material.publicKey : current.publicKey,
      updatedAt: now,
    })
    .where(eq(workspacePrivateKeys.id, input.id))
    .returning(publicSelection);
  if (!updated) throw notFound("Private key");
  return updated;
}

export async function deleteWorkspacePrivateKey(input: {
  id: string;
  workspaceId: string;
}) {
  await getPrivateKeyRow(input.id, input.workspaceId);
  await requireKeyUnused(input.id);
  await getTowbarDatabase().transaction(async (database) => {
    await database
      .delete(workspacePrivateKeys)
      .where(
        and(
          eq(workspacePrivateKeys.id, input.id),
          eq(workspacePrivateKeys.workspaceId, input.workspaceId),
        ),
      );
  });
}

export async function getWorkspacePrivateKeyValue(
  id: string,
  workspaceId: string,
) {
  return await revealWorkspacePrivateKey(id, workspaceId);
}
