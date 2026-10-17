export type ManifestRepositoryClaim = {
  sourceId: string;
  sourceEnvironmentId: string;
  repository: string;
  provider?: "github" | "gitlab";
  branch: string;
  commitSha: string;
  changedPaths: string[];
  manifestFiles?: { path: string; url: string | null }[];
};
export type ManifestLifecycleItem = {
  key: string;
  manifestId: string;
  environment: string;
  state: "conflict" | "retired" | "removing";
  reason: string | null;
  declarations: ManifestRepositoryClaim[];
  workloads: {
    id: string;
    name: string;
    kind: string;
    sourceId: string;
    repository: string;
    provider?: "github" | "gitlab";
    serverId: string;
    serverIp: string;
    revision: string;
    retiredAt: string | null;
    href: string;
  }[];
  operations: { id: string; state: string; errorMessage: string | null }[];
};
export type ManifestLifecycleResponse = {
  items: ManifestLifecycleItem[];
  counts: { conflicts: number; retirements: number; removing: number };
  total: number;
  nextOffset: number | null;
};
