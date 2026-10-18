"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { secretReferenceError } from "@/lib/secret-reference";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";

export function SecretReferenceTooltip({
  children,
  reference,
  reveal,
}: {
  children: ReactNode;
  reference: { scope: "globals" | "repo"; key: string };
  reveal?: () => Promise<string>;
}) {
  const generation = useRef(0);
  const opened = useRef(false);
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
    if (!next) setOpen(false);
    const current = ++generation.current;
    if (!next) {
      setPreview(undefined);
      return;
    }
    if (!reveal) {
      setPreview("You don't have permission to view this value");
      setOpen(true);
      return;
    }
    try {
      const value = await reveal();
      if (current === generation.current) {
        setPreview(value || "Empty value");
        setOpen(true);
      }
    } catch (error) {
      if (current === generation.current) {
        setPreview(secretReferenceError(error, reference));
        setOpen(true);
      }
    }
  }

  return (
    <Tooltip isOpen={open} onOpenChange={(next) => void changeOpen(next)}>
      <Tooltip.Trigger
        render={(props) => (
          <div
            {...props}
            className={`${props.className ?? ""} w-full min-w-0`}
          />
        )}
        aria-label={`Shared secret reference ${reference.scope}.${reference.key}`}
        onMouseEnter={() => void changeOpen(true)}
        onFocusCapture={() => void changeOpen(true)}
        onBlurCapture={() => void changeOpen(false)}
        onMouseLeave={() => void changeOpen(false)}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Content
        className="max-w-[min(24rem,calc(100vw-2rem))] whitespace-pre-wrap text-xs [overflow-wrap:anywhere]"
        placement="top start"
        showArrow
      >
        <Tooltip.Arrow />
        {preview}
      </Tooltip.Content>
    </Tooltip>
  );
}
