import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { roleAllows } from "@workspace/towbar-access";
import {
  servers,
  sshHostKeys,
  workspacePrivateKeys,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { HttpError, conflict, forbidden } from "../../http/errors.js";
import { incrementPersistentBucket } from "../../http/rate-limit.js";
import { requireRecentAuthentication } from "../auth/recent-authentication.js";
import { findSession } from "../auth/service.js";
import {
  readSecretMetadata,
  resolveServerCredentials,
} from "../secrets/store.js";
import type { AuthenticatedUser } from "../../http/types.js";

type Ticket = {
  userId: string;
  workspaceId: string;
  sessionId: string;
  serverId: string;
  expiresAt: number;
  configuration: string;
};
const tickets = new Map<string, Ticket>();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function target(serverId: string, workspaceId: string) {
  const database = getTowbarDatabase();
  const [server] = await database
    .select({
      config: servers.config,
      configDigest: servers.configDigest,
      privateKeyId: servers.privateKeyId,
      keyName: workspacePrivateKeys.name,
      keyUpdatedAt: workspacePrivateKeys.updatedAt,
    })
    .from(servers)
    .leftJoin(
      workspacePrivateKeys,
      and(
        eq(workspacePrivateKeys.id, servers.privateKeyId),
        eq(workspacePrivateKeys.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(servers.id, serverId),
        eq(servers.workspaceId, workspaceId),
        isNull(servers.archivedAt),
      ),
    );
  if (!server) throw forbidden("This server is unavailable");
  if (!server.privateKeyId)
    throw conflict(
      "Connect a private key in server Configuration before opening the terminal",
      "SERVER_CREDENTIALS_MISSING",
    );
  const hostKeys = await database
    .select({
      publicKey: sshHostKeys.publicKey,
      fingerprint: sshHostKeys.fingerprint,
    })
    .from(sshHostKeys)
    .where(
      and(eq(sshHostKeys.serverId, serverId), isNull(sshHostKeys.revokedAt)),
    );
  if (!hostKeys.length)
    throw conflict(
      "Verify and trust the server in Configuration before opening the terminal",
      "HOST_KEY_NOT_TRUSTED",
    );
  const credential = await readSecretMetadata({
    type: "server",
    id: serverId,
    workspaceId,
    environment: "production",
    stage: "credentials",
  });
  if (!credential.keys.includes("privateKey"))
    throw conflict(
      "Connect a private key in server Configuration before opening the terminal",
      "SERVER_CREDENTIALS_MISSING",
    );
  const configuration = digest(
    JSON.stringify([
      server.configDigest,
      server.privateKeyId,
      server.keyUpdatedAt,
      credential.revision,
      hostKeys.map((key) => key.publicKey).sort(),
    ]),
  );
  return { ...server, hostKeys, configuration };
}

export async function issueTerminalTicket(
  user: AuthenticatedUser,
  sessionId: string,
  serverId: string,
) {
  if (!roleAllows(user.workspaceRole, "admin"))
    throw forbidden("Only admins can open a server terminal");
  await requireRecentAuthentication(user.id, sessionId);
  const bucket = await incrementPersistentBucket(
    `terminal:${user.id}`,
    new Date(),
    60000,
  );
  if (bucket.attempts > 10)
    throw new HttpError(
      429,
      "TERMINAL_RATE_LIMITED",
      "Too many connection attempts. Try again in a minute.",
    );
  const server = await target(serverId, user.workspaceId);
  for (const [hash, ticket] of tickets)
    if (ticket.expiresAt <= Date.now()) tickets.delete(hash);
  if (
    tickets.size >= 100 ||
    [...tickets.values()].filter((ticket) => ticket.userId === user.id)
      .length >= 3
  )
    throw conflict(
      "Finish the pending terminal connection before opening another",
      "TERMINAL_BUSY",
    );
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 30000;
  tickets.set(digest(ticket), {
    userId: user.id,
    workspaceId: user.workspaceId,
    sessionId,
    serverId,
    expiresAt,
    configuration: server.configuration,
  });
  return {
    ticket,
    expiresAt: new Date(expiresAt).toISOString(),
    websocketPath: "/v1/terminal",
  };
}

export async function authorizeTerminal(ticket: Ticket, headers: Headers) {
  const identity = await findSession(headers);
  if (
    !identity ||
    identity.sessionId !== ticket.sessionId ||
    identity.user.id !== ticket.userId ||
    identity.user.workspaceId !== ticket.workspaceId ||
    identity.user.mustChangePassword ||
    !roleAllows(identity.user.workspaceRole, "admin")
  )
    throw forbidden("Your terminal access has ended. Sign in again.");
  const current = await target(ticket.serverId, ticket.workspaceId);
  if (current.configuration !== ticket.configuration)
    throw conflict(
      "Server credentials or trusted keys changed. Reconnect after checking Configuration.",
    );
  return current;
}

export async function consumeTerminalTicket(value: string, headers: Headers) {
  const hash = digest(value);
  const ticket = tickets.get(hash);
  tickets.delete(hash);
  if (!ticket || ticket.expiresAt <= Date.now())
    throw forbidden("This terminal connection has expired. Connect again.");
  const server = await authorizeTerminal(ticket, headers);
  await requireRecentAuthentication(ticket.userId, ticket.sessionId);
  const credentials = await resolveServerCredentials(ticket);
  return { ticket, server, privateKey: credentials.values.privateKey! };
}
