"use client";

import { Rocket01Icon } from "@hugeicons/core-free-icons";
import { useParams } from "next/navigation";
import { useRouter } from "@/hooks/use-guarded-router";
import { useEffect, useRef } from "react";
import type { Deployment } from "@workspace/towbar-web-client";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";

import { useApiQuery } from "@/hooks/use-api-query";
import { deploymentHref } from "@/lib/deployment-route";
import { DashboardPage } from "./page-parts";

export function DeploymentRouteRedirect({ section }: { section?: string }) {
  const { deploymentId } = useParams<{ deploymentId: string }>();
  const router = useRouter();
  const query = useApiQuery<{ deployment: Deployment }>(
    `/v1/core/deployments/${deploymentId}`,
  );
  const destination = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!query.data) return;
    const href = deploymentHref(query.data.deployment, section);
    if (destination.current === href) return;
    destination.current = href;
    router.replace(href);
  }, [query.data, router, section]);

  if (query.error)
    return (
      <DashboardPage icon={Rocket01Icon} title="Deployment">
        <QueryError message={query.error} />
      </DashboardPage>
    );
  return <QueryLoading variant="detail" />;
}
