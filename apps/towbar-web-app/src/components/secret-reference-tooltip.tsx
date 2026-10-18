"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";

export function SecretReferenceTooltip({
  children,
  reference,
  reveal,
}: {
  children: ReactNode;
  reference: string;
  reveal?: () => Promise<string>;
}) {
  const generation = useRef(0);
  const opened = useRef(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number }>();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string>();

  useEffect(() => {
    const request = generation;
    const clear = () => {
      request.current++;
      opened.current = false;
      setOpen(false);
      setPreview(undefined);
    };
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      request.current++;
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);

  async function changeOpen(next: boolean) {
    if (opened.current === next) return;
    opened.current = next;
    setOpen(next);
    const current = ++generation.current;
    if (!next) {
      setPreview(undefined);
      return;
    }
    if (!reveal) {
      setPreview("You don't have permission to view this value");
      return;
    }
    setPreview("Loading value…");
    try {
      const value = await reveal();
      if (current === generation.current) setPreview(value || "Empty value");
    } catch {
      if (current === generation.current)
        setPreview("Unable to show shared secret value");
    }
  }

  return (
    <Tooltip isOpen={open} onOpenChange={(next) => void changeOpen(next)}>
      <Tooltip.Trigger
        render={(props) => (
          <div
            {...props}
            className={`${props.className ?? ""} relative w-full min-w-0`}
          />
        )}
        aria-label={`Shared secret reference ${reference}`}
        onMouseEnter={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setPointer({
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          });
          void changeOpen(true);
        }}
        onFocusCapture={() => {
          setPointer(undefined);
          void changeOpen(true);
        }}
        onBlurCapture={() => void changeOpen(false)}
        onMouseLeave={() => void changeOpen(false)}
      >
        {children}
        <span
          ref={anchor}
          aria-hidden="true"
          className="pointer-events-none absolute size-0"
          style={{ left: pointer?.x ?? 0, top: pointer?.y ?? 0 }}
        />
      </Tooltip.Trigger>
      <Tooltip.Content
        className="max-w-[min(24rem,calc(100vw-2rem))] whitespace-pre-wrap text-xs [overflow-wrap:anywhere]"
        triggerRef={pointer ? anchor : undefined}
        placement="top"
        showArrow
      >
        <Tooltip.Arrow />
        {preview ?? "Loading value…"}
      </Tooltip.Content>
    </Tooltip>
  );
}
