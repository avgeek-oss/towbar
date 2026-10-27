import { analyticsUrlState } from "./page-query-state";

export type BreadcrumbEntityKind =
  "apps" | "resources" | "servers" | "sources" | "syncs";

const entityRoutes = {
  apps: "services",
  resources: "datastores",
  servers: "servers",
  sources: "repositories",
} as const;

export function breadcrumbEntityHref({
  currentId,
  deploymentEnvironment,
  kind,
  pathname,
  sourceId,
  targetId,
  search = "",
}: {
  currentId: string;
  deploymentEnvironment?: "production" | "preview";
  kind: BreadcrumbEntityKind;
  pathname: string;
  sourceId?: string;
  targetId: string;
  search?: string;
}) {
  const base =
    kind === "syncs"
      ? `/repositories/${sourceId}/syncs`
      : `/${entityRoutes[kind]}`;
  const currentBase = `${base}/${currentId}/`;
  const parts = pathname.startsWith(currentBase)
    ? pathname.slice(currentBase.length).split("/")
    : [];
  let section = parts.slice(0, 2).join("/");
  if (parts[0] === "deployments") section = "deployments";
  if (kind === "sources") {
    if (parts[0] === "syncs") section = "sync-history";
    if (parts[0] === "services" || parts[0] === "datastores")
      section = parts[0];
  }
  const params = new URLSearchParams();
  if (
    section === "deployments" &&
    kind === "apps" &&
    (deploymentEnvironment
      ? deploymentEnvironment === "preview"
      : new URLSearchParams(search).get("type") === "preview")
  ) {
    params.set("type", "preview");
  }
  if (section === "analytics" && kind === "apps") {
    const current = new URLSearchParams(search);
    const state = analyticsUrlState(current);
    if (state.kind !== "pageview") params.set("measure", state.kind);
    if (state.days !== 1) params.set("days", String(state.days));
    if (state.filters.length)
      params.set("filters", JSON.stringify(state.filters));
    if (current.get("compare") === "on") params.set("compare", "on");
    const metric = current.get("metric");
    if (metric && ["count", "errors", "sessions", "visitors"].includes(metric))
      params.set("metric", metric);
  }
  return `${base}/${targetId}/${section || (kind === "sources" ? "environments" : "overview")}${params.size ? `?${params}` : ""}`;
}
