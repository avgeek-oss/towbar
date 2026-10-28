import type { ManifestLifecycleItem } from "@workspace/towbar-contracts";
export function createManifestLifecycleFixture(
  sourceId: string,
  serverId: string,
  workloadId: string,
  now: () => number = Date.now,
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
    sourceEnvironmentId: `c${sourceId.slice(1)}`,
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
          sourceEnvironmentId: "c1111111-1111-4111-8111-222222222222",
          sourceId: "11111111-1111-4111-8111-222222222222",
          provider: "github",
          repository: "example-inc/documentation",
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
  const acceptedAt = new Map<string, number>();
  const completed = new Set<string>();
  return {
    withdrawal(source: string, environmentId?: string) {
      return items
        .filter((item) => !completed.has(item.key))
        .filter(
          (item) =>
            item.declarations.some(
              (d) =>
                d.sourceId === source &&
                (!environmentId || d.sourceEnvironmentId === environmentId),
            ) ||
            item.workloads.some(
              (w) =>
                w.sourceId === source &&
                (!environmentId ||
                  item.declarations.some(
                    (d) => d.sourceEnvironmentId === environmentId,
                  )),
            ),
        )
        .map((item) => {
          const remaining = item.declarations.filter(
            (d) =>
              d.sourceId !== source ||
              Boolean(environmentId && d.sourceEnvironmentId !== environmentId),
          );
          const incompatible = item.reason?.includes("different datastore");
          const outcome =
            remaining.length > 1 || (remaining.length === 1 && incompatible)
              ? ("conflict" as const)
              : remaining.length === 0
                ? ("retire" as const)
                : item.workloads[0]?.sourceId === remaining[0]!.sourceId
                  ? ("unchanged" as const)
                  : ("transfer" as const);
          return {
            key: item.key,
            manifestId: item.manifestId,
            environment: item.environment,
            name: item.workloads[0]?.name ?? item.manifestId,
            outcome,
            destination: remaining[0]?.repository ?? null,
            reason: outcome === "conflict" ? item.reason : null,
            changedPaths: remaining[0]?.changedPaths ?? [],
          };
        });
    },
    withdraw(source: string, environmentId?: string) {
      for (const item of items) {
        const relevant = item.declarations.some(
          (d) =>
            d.sourceId === source &&
            (!environmentId || d.sourceEnvironmentId === environmentId),
        );
        if (!relevant) continue;
        item.declarations = item.declarations.filter(
          (d) =>
            d.sourceId !== source ||
            Boolean(environmentId && d.sourceEnvironmentId !== environmentId),
        );
        if (!item.declarations.length) {
          item.state = "retired";
          item.reason = null;
        } else if (
          item.declarations.length === 1 &&
          !item.reason?.includes("different datastore")
        ) {
          const target = item.declarations[0]!;
          for (const workload of item.workloads) {
            workload.sourceId = target.sourceId;
            workload.repository = target.repository;
          }
          completed.add(item.key);
        }
      }
    },
    list(query: URLSearchParams) {
      for (const item of items) {
        const accepted = acceptedAt.get(item.key);
        if (accepted === undefined) continue;
        const elapsed = now() - accepted;
        if (elapsed >= 9_000) completed.add(item.key);
        else if (elapsed >= 2_000)
          for (const operation of item.operations) operation.state = "running";
      }
      const tab = query.get("tab"),
        search = query.get("search")?.toLowerCase();
      const visible = items.filter((item) => !completed.has(item.key));
      const filtered = visible.filter(
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
          conflicts: visible.filter((item) => item.state === "conflict").length,
          retirements: visible.filter((item) => item.state !== "conflict")
            .length,
          removing: visible.filter((item) => item.state === "removing").length,
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
      acceptedAt.set(item.key, now());
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
