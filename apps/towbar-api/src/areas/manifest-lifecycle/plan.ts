import {
  type NormalizedDeployable,
  isNormalizedResource,
} from "@workspace/towbar-core";

export type ManifestDeclaration = {
  environment: string;
  sourceEnvironmentId: string;
  sourceId: string;
  commitSha: string;
  config: NormalizedDeployable;
};
export type RegisteredWorkload = {
  id: string;
  manifestId: string;
  environment: string;
  sourceId: string;
  config: NormalizedDeployable;
  manifestState: string;
};
export type IdentityPlan = {
  key: string;
  manifestId: string;
  environment: string;
  declarations: ManifestDeclaration[];
  workloads: RegisteredWorkload[];
  state: "active" | "conflict" | "retired";
  reason: string | null;
};
export function identityKey(environment: string, manifestId: string) {
  return `${environment}:${manifestId}`;
}
export function declarationCompatibility(
  current: NormalizedDeployable,
  desired: NormalizedDeployable,
  transferring = false,
) {
  if (current.kind !== desired.kind)
    return "The manifest type differs from the existing workload. Use a different ID for a different workload type.";
  if (isNormalizedResource(current) && isNormalizedResource(desired)) {
    if (current.server !== desired.server)
      return "Move the datastore's data before changing its server.";
    if (transferring && current.image !== desired.image)
      return "A datastore version change requires an explicit datastore upgrade before ownership can move.";
  }
  if (
    !isNormalizedResource(current) &&
    current.kind !== "compose" &&
    current.container.volumes?.length &&
    current.server !== desired.server
  )
    return "Move this service's persistent data before changing its server.";
  if (current.kind === "compose" && current.server !== desired.server)
    return "Move Compose storage before changing its server.";
  return null;
}
export function planManifestIdentities(
  declarations: ManifestDeclaration[],
  workloads: RegisteredWorkload[],
): IdentityPlan[] {
  const groups = new Map<string, IdentityPlan>();
  function group(environment: string, manifestId: string) {
    const key = identityKey(environment, manifestId);
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        key,
        environment,
        manifestId,
        declarations: [],
        workloads: [],
        state: "active",
        reason: null,
      };
      groups.set(key, entry);
    }
    return entry;
  }
  for (const declaration of declarations)
    group(declaration.environment, declaration.config.id).declarations.push(
      declaration,
    );
  for (const workload of workloads)
    if (workload.manifestState !== "removed")
      group(workload.environment, workload.manifestId).workloads.push(workload);
  for (const entry of groups.values()) {
    if (
      entry.declarations.length > 1 ||
      (entry.declarations.length > 0 && entry.workloads.length > 1)
    ) {
      entry.state = "conflict";
      entry.reason =
        entry.workloads.length > 1
          ? "Multiple existing workloads use this ID. All data is preserved; give independent workloads distinct IDs in Git and review their retirements."
          : "This ID is declared by multiple repositories. Keep its declaration in only one repository, then sync the affected repositories.";
    } else if (!entry.declarations.length) {
      entry.state = "retired";
    } else if (entry.workloads[0]?.manifestState === "removing") {
      entry.state = "conflict";
      entry.reason =
        "Permanent removal is in progress. Wait for it to complete before syncing this declaration again.";
    } else if (entry.workloads.length) {
      const reason = declarationCompatibility(
        entry.workloads[0]!.config,
        entry.declarations[0]!.config,
        entry.workloads[0]!.sourceId !== entry.declarations[0]!.sourceId,
      );
      if (reason) {
        entry.state = "conflict";
        entry.reason = reason;
      }
    }
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// Return paths rather than configuration values: manifests can contain sensitive literals.
export function changedConfigurationPaths(
  before: unknown,
  after: unknown,
  path = "",
): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((key) =>
        changedConfigurationPaths(
          a[key],
          b[key],
          path ? `${path}.${key}` : key,
        ),
      );
  }
  return [path || "configuration"];
}
