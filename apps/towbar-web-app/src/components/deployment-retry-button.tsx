"use client";

import { useRef } from "react";
import { ReloadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Deployment } from "@workspace/towbar-web-client";
import { useRouter } from "@/hooks/use-guarded-router";
import { api } from "@/lib/api";
import { deploymentHref } from "@/lib/deployment-route";
import { useAccess } from "./access-context";
import { ActionButton } from "./page-parts";

export function DeploymentRetryButton({
  deploymentId,
  preview = false,
}: {
  deploymentId: string;
  preview?: boolean;
}) {
  const { can } = useAccess();
  const router = useRouter();
  const requestKey = useRef<string | null>(null);
  if (!can("admin")) return null;
  return (
    <ActionButton
      action={() => {
        requestKey.current ??= crypto.randomUUID();
        return api.post<{ deployment: Deployment }>(
          `/v1/core/deployments/${deploymentId}/actions/retry`,
          undefined,
          { "Idempotency-Key": requestKey.current },
        );
      }}
      confirm={{
        title: preview ? "Retry this Preview?" : "Retry this deployment?",
        description: preview
          ? "Deploy the pull request’s latest revision using its current Preview configuration and secrets."
          : "Queue another deployment attempt. A successful attempt may replace the running release.",
        actionLabel: "Retry deployment",
      }}
      onSuccess={(result) => router.push(deploymentHref(result.deployment))}
      pendingLabel="Queueing…"
      success="Retry queued"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={ReloadIcon}
        className="size-4 shrink-0"
      />
      Retry
    </ActionButton>
  );
}
