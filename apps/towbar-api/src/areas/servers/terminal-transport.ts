import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { Client, type ClientChannel } from "ssh2";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { getEnv } from "../../env.js";
import { authorizeTerminal, consumeTerminalTicket } from "./terminal.js";
import { terminalPrivateKey } from "./terminal-key.js";

const dimensions = {
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(3).max(200),
};
const messageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("connect"),
      ticket: z.string().regex(/^[\w-]{43}$/),
      ...dimensions,
    })
    .strict(),
  z.object({ type: z.literal("resize"), ...dimensions }).strict(),
  z.object({ type: z.literal("input"), data: z.string().max(16384) }).strict(),
  z
    .object({
      type: z.literal("ack"),
      bytes: z.number().int().min(1).max(1048576),
    })
    .strict(),
]);
type Connection = Awaited<ReturnType<typeof consumeTerminalTicket>>;

export function attachServerTerminal(server: Server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  const active = new Map<WebSocket, Connection>();
  server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/v1/terminal" ||
      request.headers.origin !== new URL(getEnv().TOWBAR_APP_BASE_URL).origin ||
      wss.clients.size >= 64
    ) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const headers = new Headers({ cookie: request.headers.cookie ?? "" });
      const connectionId = randomUUID();
      let ssh: Client | undefined;
      let channel: ClientChannel | undefined;
      let connection: Connection | undefined;
      let connecting = false;
      let closed = false;
      let outstanding = 0;
      let authenticatedAt = 0;
      let lastInput = Date.now();
      let checking = false;
      let framesAt = Date.now();
      let frames = 0;
      let inputBytes = 0;
      let pong = true;
      const send = (value: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
      };
      const timeout = setTimeout(
        () => close("Connection timed out. Connect again."),
        10000,
      );
      const timer = setInterval(() => {
        if (!connection || checking || closed) return;
        if (Date.now() - lastInput > 15 * 60000)
          return close("Disconnected after 15 minutes without input.");
        if (Date.now() - authenticatedAt > 60 * 60000)
          return close(
            "The one-hour session limit was reached. Connect again.",
          );
        checking = true;
        let deadline: ReturnType<typeof setTimeout>;
        void Promise.race([
          authorizeTerminal(connection.ticket, headers),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Access check timed out")),
              5000,
            );
          }),
        ])
          .catch(() =>
            close(
              "Your session, role, or server credentials changed. Connect again.",
            ),
          )
          .finally(() => {
            clearTimeout(deadline);
            checking = false;
          });
      }, 5000);
      const heartbeat = setInterval(() => {
        if (!pong) return close("The browser connection was lost.");
        pong = false;
        ws.ping();
      }, 30000);
      function close(reason: string) {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        clearInterval(timer);
        clearInterval(heartbeat);
        channel?.destroy();
        ssh?.destroy();
        active.delete(ws);
        send({ type: "closed", message: reason });
        ws.close(1000);
        const terminate = setTimeout(() => ws.terminate(), 1000);
        terminate.unref();
      }
      const output = (data: Buffer) => {
        if (closed) return;
        outstanding += data.length;
        if (outstanding > 1048576 || ws.bufferedAmount > 1048576)
          return close(
            "Terminal output exceeded the browser buffer. Connect again.",
          );
        ws.send(data, { binary: true });
        if (outstanding >= 262144) {
          channel?.pause();
          channel?.stderr.pause();
        }
      };
      ws.on("pong", () => {
        pong = true;
      });
      ws.on("close", () => close("Disconnected"));
      ws.on("error", () => close("The browser connection failed."));
      ws.on("message", (raw, binary) => {
        if (closed) return;
        if (Date.now() - framesAt >= 1000) {
          framesAt = Date.now();
          frames = 0;
          inputBytes = 0;
        }
        if (++frames > 500 || binary) return close("Invalid terminal input.");
        let message: z.infer<typeof messageSchema>;
        try {
          message = messageSchema.parse(JSON.parse(raw.toString()));
        } catch {
          return close("Invalid terminal message.");
        }
        if (message.type === "connect") {
          if (connecting) return close("This terminal is already connecting.");
          connecting = true;
          void (async () => {
            connection = await consumeTerminalTicket(message.ticket, headers);
            if (closed) return;
            if (
              active.size >= 20 ||
              [...active.values()].filter(
                (value) => value.ticket.userId === connection!.ticket.userId,
              ).length >= 3
            )
              return close(
                "The terminal session limit was reached. Disconnect another session first.",
              );
            active.set(ws, connection);
            authenticatedAt = Date.now();
            clearTimeout(timeout);
            ssh = new Client();
            let hostMismatch = false;
            ssh.on("error", () =>
              close(
                hostMismatch
                  ? "Server identity changed. Verify its host key in Configuration."
                  : "SSH connection failed. Check server Configuration and network access.",
              ),
            );
            ssh.on("close", () => close("SSH session ended."));
            ssh.on("ready", () => {
              void (async () => {
                await authorizeTerminal(connection!.ticket, headers);
                if (closed) {
                  return;
                }
                ssh!.shell(
                  {
                    term: "xterm-256color",
                    cols: message.cols,
                    rows: message.rows,
                  },
                  (error, stream) => {
                    if (error)
                      return close(
                        "The server could not open an interactive shell.",
                      );
                    if (closed) {
                      stream.destroy();
                      return;
                    }
                    channel = stream;
                    stream.on("data", output);
                    stream.stderr.on("data", output);
                    stream.on("close", () => close("Shell session ended."));
                    stream.on("error", () => close("The SSH shell failed."));
                    send({ type: "ready", connectionId });
                  },
                );
              })().catch(() =>
                close(
                  "Terminal authorization could not be confirmed. Connect again.",
                ),
              );
            });
            const config = connection.server.config;
            ssh.connect({
              host: config.ssh.host ?? config.ip,
              port: config.ssh.port ?? 22,
              username: config.ssh.username,
              privateKey: terminalPrivateKey(connection.privateKey),
              readyTimeout: 20000,
              keepaliveInterval: 15000,
              keepaliveCountMax: 2,
              agentForward: false,
              tryKeyboard: false,
              hostVerifier: (key: Buffer) => {
                const trusted = connection!.server.hostKeys.some((item) => {
                  const stored = Buffer.from(
                    item.publicKey.trim().split(/\s+/)[1] ?? "",
                    "base64",
                  );
                  return (
                    stored.length === key.length && timingSafeEqual(stored, key)
                  );
                });
                hostMismatch = !trusted;
                return trusted;
              },
            });
            connection.privateKey = "";
          })().catch(() =>
            close(
              "Unable to open this terminal. Check your session and server Configuration, then connect again.",
            ),
          );
          return;
        }
        if (!channel) return close("The SSH shell is not connected.");
        if (message.type === "input") {
          inputBytes += Buffer.byteLength(message.data);
          if (inputBytes > 524288 || channel.writableLength > 262144)
            return close("Terminal input exceeded the connection buffer.");
          lastInput = Date.now();
          channel.write(message.data);
        } else if (message.type === "resize")
          channel.setWindow(message.rows, message.cols, 0, 0);
        else {
          if (message.bytes > outstanding)
            return close("Invalid output acknowledgement.");
          outstanding -= message.bytes;
          if (outstanding < 65536) {
            channel.resume();
            channel.stderr.resume();
          }
        }
      });
    });
  });
  return () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
