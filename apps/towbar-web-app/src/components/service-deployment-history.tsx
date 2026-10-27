"use client";

import type { App, Deployment } from "@workspace/towbar-web-client";
import { QueryError, QueryLoading } from "@workspace/towbar-web-ui/query-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { usePageQuery } from "@/hooks/use-page-query";
import { DeploymentTable } from "./deployment-table";
import { ScoutSelect } from "./scout-controls";

export function servicePreviewsEnabled(app: App) {
  return (
    app.config.preview?.enabled === true &&
    app.environment?.previewsEnabled === true
  );
}

export function DeploymentTypeSelect({ app }: { app: App }) {
  const { search, update } = usePageQuery();
  if (!servicePreviewsEnabled(app)) return null;
  return (
    <div className="w-48 max-w-full">
      <ScoutSelect
        label="Deployment type"
        hideLabel
        value={search.get("type") === "preview" ? "preview" : "production"}
        options={[
          { id: "production", label: app.environment?.name ?? "production" },
          { id: "preview", label: "Previews" },
        ]}
        onChange={(value) =>
          update({ type: value === "preview" ? value : null })
        }
      />
    </div>
  );
}

export function ServiceDeploymentHistory({
  app,
  deployments,
}: {
  app: App;
  deployments: Deployment[];
}) {
  const { search } = usePageQuery();
  const previews = useApiQuery<{ deployments: Deployment[] }>(
    servicePreviewsEnabled(app)
      ? `/v1/core/apps/${app.id}/deployments?environment=preview`
      : null,
    5_000,
  );
  const showPreviews =
    servicePreviewsEnabled(app) && search.get("type") === "preview";
  if (showPreviews && previews.error)
    return <QueryError message={previews.error} />;
  const history = showPreviews ? previews.data?.deployments : deployments;
  if (!history) return <QueryLoading variant="list" />;
  return (
    <DeploymentTable
      deployableName={app.name}
      deployments={history}
      emptyDescription={
        showPreviews
          ? "Open a pull request targeting this environment’s branch to create a Preview deployment."
          : "Use Deploy when this service is ready."
      }
    />
  );
}
