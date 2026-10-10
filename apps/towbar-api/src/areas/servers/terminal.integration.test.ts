import { installationSetupSecret } from "../auth/setup-secret.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test from "node:test";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import {
  configureSettingsTestEnv,
  settingsTestClient,
} from "../team/settings-test-client.js";

const databaseUrl = process.env.TOWBAR_TERMINAL_TEST_DATABASE_URL;
void test(
  "browser terminal reaches real OpenSSH with scoped, revocable and pinned access",
  { skip: !databaseUrl, timeout: 90000 },
  async (t) => {
    configureSettingsTestEnv(databaseUrl);
    const { eq } = await import("drizzle-orm");
    const schema = await import("@workspace/towbar-database/schema");
    const { normalizeServerConfiguration } =
      await import("@workspace/towbar-core");
    const { getEnv } = await import("../../env.js");
    const { getTowbarDatabase, closeDatabase } =
      await import("../../infrastructure/database.js");
    const auth = await import("../auth/service.js");
    const { createApp } = await import("../../app.js");
    const { createServer } = await import("./lifecycle.js");
    const { trustServerHostKey } = await import("./trusted-host-keys.js");
    const { createWorkspacePrivateKey, revealWorkspacePrivateKey } =
      await import("../private-keys/service.js");
    const { promoteVerifiedServerPrivateKey } =
      await import("../secrets/store.js");
    const { attachServerTerminal } = await import("./terminal-transport.js");
    const { createHash } = await import("node:crypto");
    const db = getTowbarDatabase();
    const dockerName = `towbar-terminal-test-${randomUUID()}`;
    const docker = (...args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    const app = createApp();
    const origin = new URL(getEnv().TOWBAR_APP_BASE_URL).origin;
    const client = settingsTestClient(app, origin);
    const password = "A unique terminal testing passphrase 831721";
    let listener: Server | undefined;
    let stop: (() => void) | undefined;
    const connections: WebSocket[] = [];
    const until = async (check: () => boolean, timeout = 12000) => {
      const end = Date.now() + timeout;
      while (!check()) {
        assert(Date.now() < end, "Timed out waiting for terminal state");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      const setup = await auth.createInitialAdmin({
        setupSecret: installationSetupSecret(),
        displayName: "Admin",
        teamName: "Terminal",
        email: "admin@terminal.test",
        password,
      });
      const headers = client.cookies(setup);
      const identity = (await auth.findSession(headers))!;
      const admin = identity.user;
      const key = await createWorkspacePrivateKey({
        algorithm: "ed25519",
        name: "Terminal test",
        workspaceId: admin.workspaceId,
        requestedBy: admin.id,
      });
      const privateKey = await revealWorkspacePrivateKey(
        key!.id,
        admin.workspaceId,
      );
      docker(
        "run",
        "-d",
        "--name",
        dockerName,
        "-p",
        "127.0.0.1::22",
        "--entrypoint",
        "sh",
        "towbar-v2-e2e-target:local",
        "-c",
        "mkdir -p /run/sshd; ssh-keygen -A; exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o AllowTcpForwarding=no",
      );
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          dockerName,
          "sh",
          "-c",
          "cat > /home/deploy/.ssh/authorized_keys; chown deploy:deploy /home/deploy/.ssh/authorized_keys; chmod 600 /home/deploy/.ssh/authorized_keys",
        ],
        { input: key!.publicKey + "\n" },
      );
      const port = Number(
        docker("port", dockerName, "22/tcp").split(":").at(-1),
      );
      const server = await createServer({
        config: normalizeServerConfiguration({
          ip: "127.0.0.1",
          ssh: { username: "deploy", port },
        }),
        workspaceId: admin.workspaceId,
      });
      const serverId = server!.id;
      await db.transaction((tx) =>
        promoteVerifiedServerPrivateKey(
          {
            actorUserId: admin.id,
            expectedRevision: null,
            privateKey,
            privateKeyId: key!.id,
            serverId,
            workspaceId: admin.workspaceId,
          },
          tx,
        ),
      );
      const publicKey = docker(
        "exec",
        dockerName,
        "cat",
        "/etc/ssh/ssh_host_ed25519_key.pub",
      )
        .split(" ")
        .slice(0, 2)
        .join(" ");
      const fingerprint =
        "SHA256:" +
        createHash("sha256")
          .update(Buffer.from(publicKey.split(" ")[1]!, "base64"))
          .digest("base64")
          .replace(/=+$/, "");
      await trustServerHostKey({
        serverId,
        workspaceId: admin.workspaceId,
        trustedBy: admin.id,
        publicKey,
        fingerprint,
        algorithm: "ssh-ed25519",
      });
      listener = serve({
        fetch: app.fetch,
        port: 0,
        hostname: "127.0.0.1",
      }) as Server;
      stop = attachServerTerminal(listener);
      if (!listener.listening) await once(listener, "listening");
      const address = listener.address();
      assert(address && typeof address !== "string");
      const url = `ws://127.0.0.1:${address.port}/v1/terminal`;
      const ticket = async () => {
        const response = await client.request(
          `/v1/core/servers/${serverId}/terminal`,
          headers,
          {},
        );
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(response.headers.get("cache-control"), "no-store");
        const data = (await response.json()) as { ticket: string };
        assert(!JSON.stringify(data).includes("PRIVATE KEY"));
        return data.ticket;
      };
      function connect(value: string, cookie = headers.get("cookie")!) {
        const ws = new WebSocket(url, { origin, headers: { cookie } });
        connections.push(ws);
        const state = { ready: false, closed: false, output: "", reason: "" };
        ws.on("open", () =>
          ws.send(
            JSON.stringify({
              type: "connect",
              ticket: value,
              cols: 100,
              rows: 30,
            }),
          ),
        );
        ws.on("message", (raw, binary) => {
          if (binary) {
            state.output += raw.toString();
            ws.send(
              JSON.stringify({
                type: "ack",
                bytes: Buffer.byteLength(raw as Buffer),
              }),
            );
          } else {
            const message = JSON.parse(raw.toString());
            if (message.type === "ready") state.ready = true;
            if (message.type === "closed") state.reason = message.message;
          }
        });
        ws.on("close", () => {
          state.closed = true;
        });
        return { ws, state };
      }
      await t.test(
        "rejects unknown origins before WebSocket upgrade",
        async () => {
          const ws = new WebSocket(url, { origin: "https://attacker.example" });
          const [error] = await once(ws, "error");
          assert.match(String(error), /403/);
        },
      );
      const firstTicket = await ticket();
      const first = connect(firstTicket);
      await until(() => first.state.ready || first.state.closed);
      assert(first.state.ready, first.state.reason);
      await t.test(
        "commands, Unicode, resize and bounded output traverse a real PTY",
        async () => {
          first.ws.send(
            JSON.stringify({
              type: "input",
              data: "printf 'terminal-'; printf 'works ☀\\n'\n",
            }),
          );
          await until(() => first.state.output.includes("terminal-works ☀"));
          first.ws.send(
            JSON.stringify({ type: "resize", rows: 41, cols: 122 }),
          );
          first.ws.send(JSON.stringify({ type: "input", data: "stty size\n" }));
          await until(() => first.state.output.includes("41 122"));
          first.ws.send(
            JSON.stringify({
              type: "input",
              data: "python3 -c 'print(\"x\" * 400000)'\n",
            }),
          );
          await until(() => first.state.output.length > 400000);
          assert(!first.state.closed);
        },
      );
      await t.test(
        "tickets are single-use and require the issuing browser session",
        async () => {
          const replay = connect(firstTicket);
          await until(() => replay.state.closed);
          assert(!replay.state.ready);
          const stolen = connect(await ticket(), "");
          await until(() => stolen.state.closed);
          assert(!stolen.state.ready);
        },
      );
      await t.test(
        "members, cross-team servers, and stale sign-ins cannot get a ticket",
        async () => {
          const { createTeamMember } = await import("../team/service.js");
          const member = await createTeamMember(admin, {
            name: "Member",
            email: "member@terminal.test",
            password,
            role: "member",
          });
          await db
            .update(schema.users)
            .set({ mustChangePassword: false })
            .where(eq(schema.users.id, member.userId));
          const memberHeaders = client.cookies(
            await auth.authenticatePassword({
              email: "member@terminal.test",
              password,
            }),
          );
          assert.equal(
            (
              await client.request(
                `/v1/core/servers/${serverId}/terminal`,
                memberHeaders,
                {},
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await client.request(
                `/v1/core/servers/${randomUUID()}/terminal`,
                headers,
                {},
              )
            ).status,
            403,
          );
          await db
            .update(schema.sessions)
            .set({ authenticatedAt: new Date(Date.now() - 11 * 60000) })
            .where(eq(schema.sessions.id, identity.sessionId));
          const stale = await client.request(
            `/v1/core/servers/${serverId}/terminal`,
            headers,
            {},
          );
          assert.equal(stale.status, 403);
          assert.match(await stale.text(), /REAUTHENTICATION_REQUIRED/);
          await db
            .update(schema.sessions)
            .set({ authenticatedAt: new Date() })
            .where(eq(schema.sessions.id, identity.sessionId));
        },
      );
      await t.test("role revocation closes an existing shell", async () => {
        await db
          .update(schema.workspaceMembers)
          .set({ role: "viewer" })
          .where(eq(schema.workspaceMembers.userId, admin.id));
        await until(() => first.state.closed);
        assert.match(first.state.reason, /session, role/);
        await db
          .update(schema.workspaceMembers)
          .set({ role: "admin" })
          .where(eq(schema.workspaceMembers.userId, admin.id));
      });
      await t.test("a changed host key never opens a shell", async () => {
        docker(
          "exec",
          dockerName,
          "sh",
          "-c",
          "rm /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub; ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key; kill -HUP $(cat /run/sshd.pid)",
        );
        const mismatched = connect(await ticket());
        await until(() => mismatched.state.closed);
        assert(!mismatched.state.ready);
        assert.match(mismatched.state.reason, /identity changed/);
      });
      const audits = await db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, serverId));
      assert(audits.some((event) => event.action === "server.terminal.opened"));
      assert(audits.some((event) => event.action === "server.terminal.closed"));
      assert(!JSON.stringify(audits).includes("terminal-works"));
      assert(!JSON.stringify(audits).includes("PRIVATE KEY"));
    } finally {
      for (const ws of connections) ws.terminate();
      stop?.();
      if (listener)
        await new Promise<void>((resolve) => listener!.close(() => resolve()));
      try {
        docker("rm", "-f", "-v", dockerName);
      } catch {
        /* Container creation may have failed. */
      }
      await closeDatabase();
    }
  },
);
