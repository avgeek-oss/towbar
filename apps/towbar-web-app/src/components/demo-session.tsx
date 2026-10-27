"use client";

import { useCallback, useEffect, useState } from "react";
import {
  IdentityAuthFrame,
  IdentityAuthHeading,
} from "@avgeek-oss/design-system/patterns/auth/identity-auth-frame";
import { TowbarLockup } from "@workspace/towbar-web-ui/brand";
import { Button, ButtonLink } from "@avgeek-oss/design-system/buttons/button";
import Link from "next/link";
import { Alert } from "@avgeek-oss/design-system/feedback/alert";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";

export const isPublicDemo =
  process.env.NEXT_PUBLIC_TOWBAR_PUBLIC_DEMO === "true";

async function sessionAction(action: "start" | "reset" | "end") {
  const response = await fetch(
    action === "end" ? "/__demo/session" : `/__demo/${action}`,
    {
      method: action === "end" ? "DELETE" : "POST",
      credentials: "same-origin",
    },
  );
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      payload.error?.message ?? "The demo is unavailable. Try again shortly.",
    );
  window.location.assign(action === "end" ? "/demo" : "/");
}

export function DemoWelcome() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    setEnded(new URLSearchParams(window.location.search).has("ended"));
  }, []);
  return (
    <main>
      <IdentityAuthFrame>
        <div className="content-grid">
          <Link aria-label="Towbar demo" className="w-fit" href="/demo">
            <TowbarLockup />
          </Link>
          <IdentityAuthHeading
            title="Explore Towbar Control Plane"
            titleElementType="h1"
          >
            Browse services, servers, and deployments. No account needed.
          </IdentityAuthHeading>
          <p className="pt-4 text-sm leading-relaxed text-muted">
            This demo uses sample data. Your changes reset when the demo ends.
          </p>
          {ended && (
            <Alert status="default">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>Your demo has ended.</Alert.Description>
              </Alert.Content>
            </Alert>
          )}
          {error && (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{error}</Alert.Description>
              </Alert.Content>
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              isDisabled={busy}
              onPress={() => {
                setBusy(true);
                setError(undefined);
                void sessionAction("start").catch((error: Error) => {
                  setError(error.message);
                  setBusy(false);
                });
              }}
            >
              {busy ? "Starting demo…" : "Start demo"}
            </Button>
            <ButtonLink variant="secondary" href="https://www.towbar.dev/docs">
              Read the docs
            </ButtonLink>
          </div>
        </div>
      </IdentityAuthFrame>
    </main>
  );
}

export function DemoBoundary({ children }: { children: React.ReactNode }) {
  const trackNotice = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => {
      node.parentElement?.style.setProperty(
        "--app-shell-top-offset",
        `${node.offsetHeight}px`,
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const [expiresAt, setExpiresAt] = useState<number>();
  const [remaining, setRemaining] = useState<number>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/__demo/session", { cache: "no-store" });
        if (!response.ok)
          throw new Error("Could not check your demo. Reload to try again.");
        const session = await response.json();
        if (!active) return;
        if (!session.active) {
          window.location.replace("/demo?ended=1");
          return;
        }
        setExpiresAt(session.expiresAt);
        setRemaining(
          Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)),
        );
      } catch (error) {
        if (active) setError((error as Error).message);
      }
    };
    void refresh();
    const poll = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(poll);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) window.location.replace("/demo?ended=1");
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const action = (name: "reset" | "end") => {
    setBusy(true);
    setError(undefined);
    void sessionAction(name).catch((error: Error) => {
      setError(error.message);
      setBusy(false);
    });
  };
  if (remaining === undefined)
    return (
      <div className="grid min-h-dvh place-items-center">
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <Spinner aria-label="Opening demo" />
        )}
      </div>
    );
  return (
    <div>
      <aside
        ref={trackNotice}
        aria-label="Demo session"
        className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-separator bg-surface-secondary px-4 py-2 text-sm"
      >
        <p className="whitespace-nowrap">
          <strong>Demo ends in </strong>
          <span className="tabular-nums">
            {Math.floor(remaining / 60)}:
            {String(remaining % 60).padStart(2, "0")}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => action("reset")}
          >
            Reset demo
          </Button>
          <Button
            variant="danger"
            isDisabled={busy}
            onPress={() => action("end")}
          >
            End demo
          </Button>
        </div>
        {remaining <= 60 && (
          <p role="status" className="w-full">
            Less than a minute left. Reset the demo to keep exploring.
          </p>
        )}
        {error && (
          <p role="alert" className="w-full text-danger">
            {error}
          </p>
        )}
      </aside>
      {children}
    </div>
  );
}
