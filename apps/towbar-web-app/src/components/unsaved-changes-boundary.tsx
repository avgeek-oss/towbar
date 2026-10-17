"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AlertDialog } from "@avgeek-oss/design-system/overlays/alert-dialog";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import {
  approveNavigation,
  assignPage,
  shouldWarnOnUnload,
  hasUnsavedChanges,
  requestNavigation,
} from "@/lib/unsaved-navigation";

export function UnsavedChangesBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, setPending] = useState<(() => void) | null>(null);
  useEffect(() => {
    const confirm = (event: Event) =>
      setPending(() => (event as CustomEvent<() => void>).detail);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (shouldWarnOnUnload()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !hasUnsavedChanges()
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download"))
        return;
      const url = new URL(link.href);
      if (
        url.href === window.location.href ||
        (url.pathname === window.location.pathname &&
          url.search === window.location.search)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestNavigation(() =>
        url.origin === window.location.origin
          ? router.push(`${url.pathname}${url.search}${url.hash}`)
          : assignPage(url.href),
      );
    };
    let index = 0;
    let currentPath = window.location.pathname;
    let restoring: number | null = null;
    let approvedPop = false;
    const history = window.history;
    const push = history.pushState;
    const replace = history.replaceState;
    replace.call(history, { ...history.state, towbarIndex: index }, "");
    history.pushState = function (data, unused, url) {
      push.call(this, { ...data, towbarIndex: ++index }, unused, url);
      currentPath = window.location.pathname;
    };
    history.replaceState = function (data, unused, url) {
      replace.call(this, { ...data, towbarIndex: index }, unused, url);
      currentPath = window.location.pathname;
    };
    const pop = (event: PopStateEvent) => {
      const target = event.state?.towbarIndex;
      if (restoring !== null) {
        event.stopImmediatePropagation();
        const delta = restoring;
        restoring = null;
        requestNavigation(() => {
          approvedPop = true;
          history.go(delta);
        });
        return;
      }
      if (
        !approvedPop &&
        hasUnsavedChanges() &&
        currentPath !== window.location.pathname &&
        typeof target === "number" &&
        target !== index
      ) {
        event.stopImmediatePropagation();
        restoring = target - index;
        history.go(index - target);
        return;
      }
      approvedPop = false;
      if (typeof target === "number") index = target;
      currentPath = window.location.pathname;
    };
    window.addEventListener("towbar:confirm-navigation", confirm);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", pop, true);
    return () => {
      window.removeEventListener("towbar:confirm-navigation", confirm);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", pop, true);
      history.pushState = push;
      history.replaceState = replace;
    };
  }, [router]);
  return (
    <>
      {children}
      <AlertDialog.Backdrop
        isOpen={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>
                Discard unsaved changes?
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              Your changes have not been saved.
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="secondary" onPress={() => setPending(null)}>
                Stay
              </Button>
              <Button
                variant="danger"
                onPress={() => {
                  if (pending) approveNavigation(pending);
                  setPending(null);
                }}
              >
                Discard changes
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}
