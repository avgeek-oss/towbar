"use client";
import { useEffect, useRef } from "react";
import type { LogFilter, LogRecord } from "@workspace/towbar-web-client";
import { config } from "@/lib/config";

export function useLogFollow(input: {
  enabled: boolean;
  cursor?: string;
  filters: LogFilter | null;
  onRecords: (records: LogRecord[], accessRevision: string) => void;
  onError: (message: string) => void;
}) {
  const handlers = useRef(input);
  const checkpoint = useRef<{ filters: LogFilter; cursor?: string }>(undefined);
  useEffect(() => {
    handlers.current = input;
  }, [input]);
  useEffect(() => {
    if (!input.enabled || !input.filters) return;
    const controller = new AbortController(),
      filters = input.filters;
    let cursor =
      checkpoint.current?.filters === filters
        ? checkpoint.current.cursor
        : input.cursor;
    const run = async () => {
      while (!controller.signal.aborted) {
        const response = await fetch(
          new URL("/v1/core/logs/tail", config.apiBaseUrl),
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filters, cursor }),
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body)
          throw new Error(
            "Could not follow logs. Refresh the search or check your access.",
          );
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder
              .decode(chunk.value, { stream: true })
              .replaceAll("\r\n", "\n");
            if (buffer.length > 2 * 1024 * 1024)
              throw new Error(
                "The log stream exceeded its buffer. Narrow the filters.",
              );
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const message = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const lines = message.split("\n"),
                event = lines
                  .find((line) => line.startsWith("event:"))
                  ?.slice(6)
                  .trim();
              const data = lines
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              if (event === "error") {
                const error = JSON.parse(data) as { message: string };
                window.dispatchEvent(new Event("towbar:clear-private-data"));
                throw new Error(error.message);
              }
              if (event === "records") {
                const page = JSON.parse(data) as {
                  records: LogRecord[];
                  nextCursor: string;
                  accessRevision: string;
                };
                cursor = page.nextCursor;
                checkpoint.current = { filters, cursor };
                handlers.current.onRecords(page.records, page.accessRevision);
              }
            }
          }
        } finally {
          await reader.cancel();
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1000);
          function done() {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          }
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    };
    void run().catch((error: unknown) => {
      if (!controller.signal.aborted)
        handlers.current.onError(
          error instanceof Error ? error.message : "Log following stopped.",
        );
    });
    return () => controller.abort();
  }, [input.enabled, input.filters, input.cursor]);
}
