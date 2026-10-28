"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link01Icon, Unlink01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { AlertDialog } from "@avgeek-oss/design-system/overlays/alert-dialog";
import { QueryError } from "@workspace/towbar-web-ui/query-state";
import { api } from "@/lib/api";
import { config } from "@/lib/config";
import { useAccess } from "./access-context";
import { InlineLink } from "./page-parts";
import "@xterm/xterm/css/xterm.css";

type Status = "idle" | "connecting" | "connected" | "disconnected";
export function ServerTerminal({
  serverId,
  host,
  credentialsPending,
}: {
  serverId: string;
  host: string;
  credentialsPending: boolean;
}) {
  const { can } = useAccess();
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const generation = useRef(0);
  const invalidateConnection = useCallback(() => {
    generation.current += 1;
  }, []);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>();
  const [hasOutput, setHasOutput] = useState(false);
  const [isConfirmingDisconnect, setIsConfirmingDisconnect] = useState(false);
  const clearTerminal = useCallback(() => {
    const term = terminal.current;
    if (term) {
      term.options.disableStdin = true;
      term.reset();
      term.clear();
    }
    setHasOutput(false);
  }, []);
  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !container.current) return;
        const term = new Terminal({
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          lineHeight: 1.35,
          cursorBlink: !window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches,
          cursorStyle: "bar",
          cursorWidth: 2,
          cursorInactiveStyle: "none",
          scrollback: 3000,
          screenReaderMode: true,
          theme: {
            background: "#18181b",
            foreground: "#f4f4f5",
            cursor: "#fbbf24",
            selectionBackground: "#52525b",
            black: "#27272a",
            red: "#f87171",
            green: "#74da96",
            yellow: "#fbbf24",
            blue: "#60a5fa",
            magenta: "#c084fc",
            cyan: "#67e8f9",
            white: "#d4d4d8",
            brightBlack: "#a1a1aa",
            brightRed: "#fca5a5",
            brightGreen: "#a7f3d0",
            brightYellow: "#fde68a",
            brightBlue: "#93c5fd",
            brightMagenta: "#e9d5ff",
            brightCyan: "#a5f3fc",
            brightWhite: "#fafafa",
          },
        });
        const sizing = new FitAddon();
        term.loadAddon(sizing);
        term.open(container.current);
        sizing.fit();
        terminal.current = term;
        fit.current = sizing;
        const input = term.onData((data) => {
          const current = socket.current;
          if (
            current?.readyState !== WebSocket.OPEN ||
            term.options.disableStdin
          )
            return;
          // Bound paste messages without splitting Unicode code points.
          for (const part of data.match(/.{1,8192}/gsu) ?? [])
            current.send(JSON.stringify({ type: "input", data: part }));
        });
        const resize = term.onResize(({ cols, rows }) => {
          if (
            socket.current?.readyState === WebSocket.OPEN &&
            !term.options.disableStdin
          )
            socket.current.send(JSON.stringify({ type: "resize", cols, rows }));
        });
        const clipboard = term.parser.registerOscHandler(52, () => true);
        const observer = new ResizeObserver(() => sizing.fit());
        observer.observe(container.current);
        term.options.disableStdin = true;
        setLoaded(true);
        dispose = () => {
          observer.disconnect();
          input.dispose();
          resize.dispose();
          clipboard.dispose();
          term.dispose();
          terminal.current = null;
          fit.current = null;
        };
      })
      .catch(() => {
        if (!disposed)
          setMessage(
            "The terminal could not load. Refresh the page to try again.",
          );
      });
    return () => {
      disposed = true;
      invalidateConnection();
      socket.current?.close();
      socket.current = null;
      dispose?.();
    };
  }, [invalidateConnection]);

  async function connect() {
    const term = terminal.current;
    if (!term) return;
    const current = ++generation.current;
    socket.current?.close();
    setMessage(undefined);
    setStatus("connecting");
    term.options.disableStdin = true;
    try {
      const result = await api.post<{ ticket: string; websocketPath: string }>(
        `/v1/core/servers/${serverId}/terminal`,
      );
      if (current !== generation.current) return;
      fit.current?.fit();
      const url = new URL(result.websocketPath, config.apiBaseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      socket.current = ws;
      let reason = "Disconnected";
      ws.onopen = () => {
        if (current !== generation.current) {
          ws.close();
          return;
        }
        term.reset();
        setHasOutput(true);
        ws.send(
          JSON.stringify({
            type: "connect",
            ticket: result.ticket,
            cols: Math.max(10, Math.min(500, term.cols)),
            rows: Math.max(3, Math.min(200, term.rows)),
          }),
        );
      };
      ws.onmessage = (event: MessageEvent) => {
        if (current !== generation.current) return;
        if (event.data instanceof ArrayBuffer) {
          const bytes = event.data.byteLength;
          term.write(new Uint8Array(event.data), () => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: "ack", bytes }));
          });
          return;
        }
        const data = JSON.parse(String(event.data)) as {
          type: string;
          message?: string;
        };
        if (data.type === "ready") {
          setStatus("connected");
          term.options.disableStdin = false;
          term.focus();
        }
        if (data.type === "closed") {
          reason = data.message ?? "Disconnected";
          setMessage(reason);
        }
      };
      ws.onerror = () => {
        reason = "Unable to connect. Check the API connection and try again.";
      };
      ws.onclose = () => {
        if (current !== generation.current) return;
        socket.current = null;
        clearTerminal();
        setIsConfirmingDisconnect(false);
        setStatus("disconnected");
        setMessage(reason);
      };
    } catch (error) {
      if (current !== generation.current) return;
      setStatus("disconnected");
      setMessage(
        error instanceof Error ? error.message : "Unable to open the terminal.",
      );
    }
  }
  function disconnect() {
    setIsConfirmingDisconnect(false);
    invalidateConnection();
    socket.current?.close();
    socket.current = null;
    clearTerminal();
    setStatus("disconnected");
    setMessage(undefined);
  }
  if (!can("admin"))
    return <QueryError message="Only admins can open a server terminal." />;
  return (
    <Widget>
      <Widget.Header className="flex-wrap gap-y-2">
        <Widget.Title className="shrink-0 whitespace-nowrap">
          SSH terminal
        </Widget.Title>
        <div className="ml-auto flex items-center gap-3">
          {status === "connected" || status === "connecting" ? (
            <Button
              className="h-6! gap-1.5 text-xs font-normal before:absolute before:inset-x-0 before:-inset-y-2 [&_svg]:size-3.5!"
              variant="danger"
              onPress={() => setIsConfirmingDisconnect(true)}
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={Unlink01Icon}
                className="size-4"
              />
              Disconnect
            </Button>
          ) : (
            <Button
              className="h-6! gap-1.5 text-xs font-normal before:absolute before:inset-x-0 before:-inset-y-2 [&_svg]:size-3.5!"
              isDisabled={!loaded || credentialsPending}
              onPress={() => void connect()}
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={Link01Icon}
                className="size-4"
              />
              Connect
            </Button>
          )}
        </div>
      </Widget.Header>
      <Widget.Content className="relative min-w-0 overflow-hidden p-3! bg-[#18181b]!">
        <div
          ref={container}
          className="h-[min(55vh,640px)] min-h-80 w-full"
          aria-label={`SSH terminal for ${host}`}
        />
        {!hasOutput ? (
          <div className="absolute inset-0 flex select-none items-center justify-center bg-[#18181b] p-6">
            <p className="max-w-md text-center text-sm text-[#f4f4f5]">
              {credentialsPending
                ? "Connect a private key and trust this server in Configuration to use the terminal."
                : "Securely connect an interactive shell using the stored SSH key"}
            </p>
          </div>
        ) : null}
      </Widget.Content>
      <Widget.Footer className="flex-wrap gap-2">
        <Widget.FooterDescription>
          {credentialsPending ? (
            <InlineLink href={`/servers/${serverId}/settings/configuration`}>
              Open Configuration
            </InlineLink>
          ) : null}
          {message && message !== "Disconnected" ? (
            <span className="block" role="status">
              {message}
            </span>
          ) : null}
          <span
            className={
              message && message !== "Disconnected" ? "mt-1 block" : "block"
            }
          >
            Terminal contents are not recorded by Towbar. Use with caution.
          </span>
        </Widget.FooterDescription>
      </Widget.Footer>
      <AlertDialog.Backdrop
        isOpen={isConfirmingDisconnect}
        onOpenChange={setIsConfirmingDisconnect}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>Disconnect terminal?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              This ends the current SSH session. All terminal contents will be
              removed from this page.
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                onPress={() => setIsConfirmingDisconnect(false)}
                variant="secondary"
              >
                Keep connected
              </Button>
              <Button onPress={disconnect} variant="danger">
                Disconnect
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </Widget>
  );
}
