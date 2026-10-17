"use client";
import { useRouter as useNextRouter } from "next/navigation";
import { useMemo } from "react";
import { requestNavigation } from "@/lib/unsaved-navigation";

export function useRouter() {
  const router = useNextRouter();
  return useMemo(
    () => ({
      ...router,
      push: (...args: Parameters<typeof router.push>) =>
        requestNavigation(() => router.push(...args)),
    }),
    [router],
  );
}
