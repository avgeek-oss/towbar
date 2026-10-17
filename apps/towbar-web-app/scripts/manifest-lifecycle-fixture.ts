import type { ManifestLifecycleItem } from "@workspace/towbar-contracts";
export function createManifestLifecycleFixture(
  sourceId: string,
  serverId: string,
  workloadId: string,
) {
  const revision = new Date().toISOString();
  const owner = {
    id: workloadId,
    name: "Example Website",
    kind: "app",
    sourceId,
    repository: "example-inc/platform",
    serverId,
    serverIp: "192.0.2.11",
    revision,
    retiredAt: null,
    href: `/services/${workloadId}`,
  };
  const claim = {
    sourceId,
    sourceEnvironmentId: "e1111111-1111-4111-8111-111111111111",
    repository: owner.repository,
    branch: "main",
    commitSha: "a".repeat(40),
    changedPaths: [],
    manifestFiles: [
      { path: ".towbar/services/example-website.service.yml", url: null },
    ],
  };
  const items: ManifestLifecycleItem[] = [
    {
      key: "production:example-website",
      manifestId: "example-website",
      environment: "production",
      state: "conflict",
      reason:
        "This ID is declared in two repositories. Keep it in only one repository, then sync both. Towbar will reuse the existing workload automatically.",
      declarations: [
        claim,
        {
          ...claim,
          sourceEnvironmentId: "e1111111-1111-4111-8111-222222222222",
          sourceId: "11111111-1111-4111-8111-222222222222",
          provider: "gitlab",
          repository: "example-inc/docs/documentation",
          commitSha: "b".repeat(40),
          changedPaths: ["name", "deployment.image"],
        },
      ],
      workloads: [owner],
      operations: [],
    },
    {
      key: "production:application-redis",
      manifestId: "application-redis",
      environment: "production",
      state: "conflict",
      reason:
        "The destination declares a different datastore engine. Use a different ID for a different workload type.",
      declarations: [{ ...claim, changedPaths: ["kind", "image"] }],
      workloads: [
        {
          ...owner,
          id: "41111111-1111-4111-8111-222222222222",
          name: "Application Redis",
          kind: "redis",
          href: "/datastores/41111111-1111-4111-8111-222222222222",
        },
      ],
      operations: [],
    },
    {
      key: "production:background-worker",
      manifestId: "background-worker",
      environment: "production",
      state: "retired",
      reason: null,
      declarations: [],
      workloads: [
        {
          ...owner,
          id: "31111111-1111-4111-8111-aaaaaaaaaaaa",
          name: "Background worker",
          href: "/services/31111111-1111-4111-8111-aaaaaaaaaaaa",
          retiredAt: revision,
        },
      ],
      operations: [],
    },
  ];
  const requests = new Map<string, { operations: { id: string }[] }>();
  return {
    list(query: URLSearchParams) {
      const tab = query.get("tab"),
        search = query.get("search")?.toLowerCase();
      const filtered = items.filter(
        (item) =>
          (!tab ||
            (tab === "conflicts"
              ? item.state === "conflict"
              : item.state !== "conflict")) &&
          (!search || JSON.stringify(item).toLowerCase().includes(search)),
      );
      const offset = Number(query.get("offset") ?? 0),
        limit = Number(query.get("limit") ?? 50);
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        nextOffset: offset + limit < filtered.length ? offset + limit : null,
        counts: {
          conflicts: items.filter((item) => item.state === "conflict").length,
          retirements: items.filter((item) => item.state !== "conflict").length,
        },
      };
    },
    remove(
      id: string,
      input: {
        confirmManifestId: string;
        expectedRevision: string;
        reason: string;
      },
      key: string,
    ) {
      if (!key) return null;
      if (requests.has(key)) return requests.get(key)!;
      const item = items.find((item) =>
        item.workloads.some((workload) => workload.id === id),
      );
      if (
        !item ||
        item.state === "conflict" ||
        item.manifestId !== input.confirmManifestId ||
        item.workloads[0]?.revision !== input.expectedRevision ||
        !input.reason.trim()
      )
        return null;
      item.state = "removing";
      const operation = {
        id: crypto.randomUUID(),
        state: "queued",
        errorMessage: null,
      };
      item.operations.push(operation);
      const result = { operations: [{ id: operation.id }] };
      requests.set(key, result);
      return result;
    },
  };
}
