"use client";

import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Key01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "@/hooks/use-guarded-router";
import type {
  Deployment,
  InstanceSecretReadiness,
} from "@workspace/towbar-web-client";
import { ButtonLink } from "@avgeek-oss/design-system/buttons/button";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";

import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { deploymentHref } from "@/lib/deployment-route";
import { ActionButton } from "./page-parts";

export function FirstDeployment({
  canDeploy,
  deployableId,
  type,
}: {
  canDeploy: boolean;
  deployableId: string;
  type: "app" | "resource";
}) {
  const router = useRouter();
  const plural = type === "app" ? "apps" : "resources";
  const label = type === "app" ? "service" : "datastore";
  const readiness = useApiQuery<InstanceSecretReadiness>(
    `/v1/core/${plural}/${deployableId}/secrets/readiness`,
  );
  const settingsHref = `/${type === "app" ? "services" : "datastores"}/${deployableId}/settings/secrets`;

  return (
    <Widget className="min-w-0">
      <Widget.Header>
        <Widget.Title>Deployment Status</Widget.Title>
      </Widget.Header>
      <Widget.Content className="flex items-center">
        {!readiness.data ? (
          <div className="grid gap-1">
            <p className="text-sm font-medium text-foreground">
              {readiness.error
                ? "Secret status unavailable"
                : "Checking required secrets…"}
            </p>
            <p className="text-sm leading-relaxed font-normal text-muted">
              {readiness.error
                ? "Review the required values before starting the first deployment."
                : "Towbar is checking whether this workload can be deployed."}
            </p>
            {readiness.error ? (
              <ButtonLink
                className="mt-3 w-fit"
                href={settingsHref}
                variant="secondary"
              >
                Review secrets
              </ButtonLink>
            ) : null}
          </div>
        ) : readiness.data.ready ? (
          <div className="flex w-full flex-wrap items-center gap-4">
            <span className="bg-success-soft text-success-soft-foreground flex size-10 shrink-0 items-center justify-center rounded-xl">
              <HugeiconsIcon icon={CheckmarkCircle01Icon} className="size-5" />
            </span>
            <div className="min-w-48 flex-1">
              <p className="text-sm font-medium text-foreground">
                All secrets are configured
              </p>
              <p className="text-sm leading-relaxed font-normal text-muted">
                This {label} is ready for its first deployment.
              </p>
            </div>
            {canDeploy ? (
              <ActionButton
                action={() =>
                  api.post<{ deployment: Deployment }>(
                    `/v1/core/${plural}/${deployableId}/actions/deploy`,
                    undefined,
                    { "Idempotency-Key": crypto.randomUUID() },
                  )
                }
                confirm={{
                  title: `Deploy this ${label}?`,
                  description:
                    type === "app"
                      ? "Queue the first service deployment."
                      : "Queue the first datastore deployment. This will create its managed container.",
                  actionLabel: `Deploy ${label}`,
                }}
                onSuccess={(result) =>
                  router.push(deploymentHref(result.deployment))
                }
                pendingLabel="Queueing…"
                success="Deployment queued"
                variant="primary"
              >
                Deploy
              </ActionButton>
            ) : null}
          </div>
        ) : (
          <div className="flex w-full flex-wrap items-center gap-4">
            <span className="bg-warning-soft text-warning-soft-foreground flex size-10 shrink-0 items-center justify-center rounded-xl">
              <HugeiconsIcon icon={AlertCircleIcon} className="size-5" />
            </span>
            <div className="min-w-48 flex-1">
              <p className="text-sm font-medium text-foreground">
                Deployment paused
              </p>
              <p className="text-sm leading-relaxed font-normal text-muted">
                Configure the pending secrets before the first deployment.
              </p>
            </div>
            <ButtonLink href={settingsHref} variant="secondary">
              <HugeiconsIcon
                aria-hidden="true"
                icon={Key01Icon}
                className="size-4"
              />
              Configure secrets
            </ButtonLink>
          </div>
        )}
      </Widget.Content>
    </Widget>
  );
}
