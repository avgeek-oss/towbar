import type { Deployment } from "@workspace/towbar-web-client";

export function buildDeploymentActivity(
  deployments: Pick<Deployment, "createdAt" | "state">[],
  now = new Date(),
) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (6 - index));
    return {
      date: date.toISOString().slice(0, 10),
      failed: 0,
      succeeded: 0,
      total: 0,
    };
  });
  const byDate = new Map(days.map((day) => [day.date, day] as const));
  for (const deployment of deployments) {
    const day = byDate.get(deployment.createdAt.slice(0, 10));
    if (!day) continue;
    day.total += 1;
    if (["succeeded", "succeeded_with_warnings"].includes(deployment.state))
      day.succeeded += 1;
    if (deployment.state === "failed") day.failed += 1;
  }
  return days;
}

export function deploymentSubtitle(
  item: Pick<Deployment, "deployableKind" | "hostname" | "environment">,
  productionDomain?: string,
) {
  if (item.deployableKind === "compose") return "Docker Compose";
  if (item.deployableKind !== "app")
    return {
      clickhouse: "ClickHouse",
      dragonfly: "Dragonfly",
      image: "Container image",
      keydb: "KeyDB",
      mariadb: "MariaDB",
      mongodb: "MongoDB",
      mysql: "MySQL",
      postgres: "PostgreSQL",
      redis: "Redis",
    }[item.deployableKind];
  return deploymentLogoDomain(item, productionDomain);
}

export function deploymentLogoDomain(
  item: Pick<Deployment, "hostname" | "environment">,
  productionDomain?: string,
) {
  return (
    item.hostname ??
    (item.environment === "production" ? productionDomain : undefined)
  );
}
