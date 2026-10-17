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
  kind,
  pathname,
  sourceId,
  targetId,
}: {
  currentId: string;
  kind: BreadcrumbEntityKind;
  pathname: string;
  sourceId?: string;
  targetId: string;
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
  return `${base}/${targetId}/${section || (kind === "sources" ? "environments" : "overview")}`;
}
