"use client";

import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web";
import type { RuntimeCapacity } from "@workspace/towbar-web-client";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  allocatedCpuPercent,
  allocatedMemoryPercent,
} from "@/lib/allocated-capacity";
import type { DefinedLimits } from "./defined-resource-limit";
import animationData from "../../public/animations/capacity-fire.json";

export function CapacityPressureIndicator({
  limits,
  runtime,
}: {
  limits: DefinedLimits;
  runtime?: RuntimeCapacity["runtimes"][number];
}) {
  const cpu = allocatedCpuPercent(runtime?.cpuPercent, limits?.cpus);
  const memory = allocatedMemoryPercent(
    runtime?.memoryUsageBytes,
    limits?.memory,
  );
  const highest =
    (cpu ?? -1) >= (memory ?? -1)
      ? { name: "CPU", value: cpu }
      : { name: "Memory", value: memory };
  if (highest.value === null || highest.value < 90) return null;
  const description = `${highest.name} ${highest.value.toFixed(1)}%`;
  return (
    <TooltipText
      role="img"
      aria-label={description}
      tooltip={description}
      tabIndex={0}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <CapacityFire />
    </TooltipText>
  );
}

function CapacityFire() {
  const container = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    const target = container.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation: AnimationItem | undefined;
    let disposed = false;
    let visible = false;
    function synchronizePlayback() {
      if (!animation) return;
      if (reducedMotion.matches) animation.goToAndStop(0, true);
      else if (visible && !document.hidden) animation.play();
      else animation.pause();
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      synchronizePlayback();
    });
    observer.observe(target);
    reducedMotion.addEventListener("change", synchronizePlayback);
    document.addEventListener("visibilitychange", synchronizePlayback);
    void import("lottie-web")
      .then(({ default: lottie }) => {
        if (disposed) return;
        animation = lottie.loadAnimation({
          container: target,
          renderer: "svg",
          loop: true,
          autoplay: false,
          animationData: structuredClone(animationData),
          rendererSettings: {
            progressiveLoad: true,
            preserveAspectRatio: "none",
          },
        });
        animation.addEventListener("DOMLoaded", () => {
          if (!disposed) {
            setReady(true);
            synchronizePlayback();
          }
        });
        synchronizePlayback();
      })
      .catch((error: unknown) => {
        console.error("Unable to load the capacity fire animation", error);
      });
    return () => {
      disposed = true;
      observer.disconnect();
      reducedMotion.removeEventListener("change", synchronizePlayback);
      document.removeEventListener("visibilitychange", synchronizePlayback);
      animation?.destroy();
    };
  }, []);
  return (
    <span
      aria-hidden="true"
      className="capacity-fire relative inline-flex h-5 w-4"
    >
      {!ready ? (
        <svg
          viewBox="0 0 24 24"
          className="absolute inset-0 h-5 w-4"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M12 2C13 7 18 8 18 12C20 10 20 8 20 8C25 17 19 23 12 23C5 23 1 18 4 12C5 15 7 15 7 13C7 8 11 6 12 2Z"
            fill="#ff4b2b"
          />
          <path
            d="M12 9C13 12 17 14 17 17C17 20 15 22 12 22C9 22 7 20 7 17C7 14 11 12 12 9Z"
            fill="#ff952c"
          />
          <path
            d="M12 15C13 17 14.5 17.5 14.5 19C14.5 21 13.5 22 12 22C10.5 22 9.5 21 9.5 19C9.5 17.5 11 17 12 15Z"
            fill="#ffe685"
          />
        </svg>
      ) : null}
      <span
        ref={container}
        data-slot="capacity-fire-animation"
        className="h-5 w-4 [&>svg]:block"
      />
    </span>
  );
}
