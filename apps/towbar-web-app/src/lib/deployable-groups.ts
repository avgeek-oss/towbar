import type { App, Resource, Server } from "@workspace/towbar-web-client";

type Deployable = Pick<
  App | Resource,
  "id" | "entityId" | "sourceId" | "manifestId"
> & { environment: { name: string } | null };

export function preferredDeployableInstance<
  T extends { archivedAt: string | null; environment: { name: string } | null },
>(items: T[], environment?: string) {
  return (
    items.find(
      (item) =>
        !item.archivedAt &&
        environment &&
        item.environment?.name === environment,
    ) ??
    items.find(
      (item) =>
        !item.archivedAt &&
        item.environment?.name.toLowerCase() === "production",
    ) ??
    items.find((item) => !item.archivedAt) ??
    items[0]!
  );
}

export function groupDeployableInstances<T extends Deployable>(items: T[]) {
  const groups = new Map<
    string,
    { key: string; manifestId: string; items: T[] }
  >();
  for (const item of items) {
    const key = `${item.sourceId}:${item.entityId ?? item.id}`;
    const group = groups.get(key) ?? {
      key,
      manifestId: item.manifestId,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.items.sort(
      (a, b) =>
        (a.environment?.name ?? "").localeCompare(b.environment?.name ?? "") ||
        a.id.localeCompare(b.id),
    );
  }
  return [...groups.values()];
}

export function groupDeployablesByEnvironment<T extends Deployable>(
  items: T[],
) {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const name = item.environment?.name ?? null;
    const group = groups.get(name) ?? [];
    group.push(item);
    groups.set(name, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    })
    .map(([name, group]) => ({
      key: JSON.stringify(name),
      name,
      items: group.sort(
        (a, b) =>
          a.manifestId.localeCompare(b.manifestId) || a.id.localeCompare(b.id),
      ),
    }));
}

export function groupDeployablesByServer<
  T extends Pick<App | Resource, "id" | "manifestId" | "serverIp">,
>(items: T[], servers: Pick<Server, "canonicalIp" | "name">[]) {
  const serversByIp = new Map(
    servers.map((server) => [server.canonicalIp, server]),
  );
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.serverIp) ?? [];
    group.push(item);
    groups.set(item.serverIp, group);
  }
  return [...groups.entries()]
    .map(([ip, group]) => ({
      key: ip,
      name: serversByIp.get(ip)?.name ?? ip,
      items: group.sort(
        (a, b) =>
          a.manifestId.localeCompare(b.manifestId) || a.id.localeCompare(b.id),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
