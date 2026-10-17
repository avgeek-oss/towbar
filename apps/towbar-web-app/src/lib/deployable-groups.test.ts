import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupDeployableInstances,
  groupDeployablesByEnvironment,
  groupDeployablesByServer,
} from "./deployable-groups";

void test("inventory groups stable logical identities and preserves instance links", () => {
  const instance = (
    id: string,
    entityId: string | null,
    sourceId: string,
    name: string,
  ) => ({
    id,
    entityId,
    sourceId,
    manifestId: "website",
    environment: { name },
  });
  const staging = instance("staging-id", "entity-one", "source-one", "staging");
  const production = instance(
    "production-id",
    "entity-one",
    "source-one",
    "production",
  );
  const foreign = instance(
    "foreign-id",
    "entity-one",
    "source-two",
    "production",
  );
  const other = instance("other-id", "entity-two", "source-one", "production");
  const input = [staging, foreign, production, other];
  const groups = groupDeployableInstances(input);
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.id)),
    [["production-id", "staging-id"], ["foreign-id"], ["other-id"]],
  );
  assert.equal(groups[0]!.items[1], staging);
  assert.equal(input[0], staging);
  assert.deepEqual(groupDeployableInstances([staging])[0]!.items, [staging]);
  assert.equal(
    groupDeployableInstances([
      instance("unlinked-one", null, "source-one", "production"),
      instance("unlinked-two", null, "source-one", "staging"),
    ]).length,
    2,
  );
  assert.deepEqual(groupDeployableInstances([]), []);
});

test("server grouping combines workloads by host without conflating server names", () => {
  const instance = (id: string, manifestId: string, serverIp: string) => ({
    id,
    manifestId,
    serverIp,
  });
  const servers = [
    { canonicalIp: "10.0.0.1", name: "Platform" },
    { canonicalIp: "10.0.0.2", name: "Platform" },
    { canonicalIp: "10.0.0.3", name: null },
  ];
  const input = [
    instance("web-staging", "website", "10.0.0.1"),
    instance("db", "postgres", "10.0.0.2"),
    instance("web-production", "website", "10.0.0.1"),
    instance("api", "api", "10.0.0.1"),
    instance("unnamed", "redis", "10.0.0.3"),
    instance("unknown", "redis", "10.0.0.4"),
  ];
  const groups = groupDeployablesByServer(input, servers);
  assert.deepEqual(
    groups.map(({ key, name }) => ({ key, name })),
    [
      { key: "10.0.0.3", name: "10.0.0.3" },
      { key: "10.0.0.4", name: "10.0.0.4" },
      { key: "10.0.0.1", name: "Platform" },
      { key: "10.0.0.2", name: "Platform" },
    ],
  );
  assert.deepEqual(
    groups[2]!.items.map((item) => item.id),
    ["api", "web-production", "web-staging"],
  );
  assert.equal(groups[2]!.items[0], input[3]);
  assert.equal(groups.flatMap((group) => group.items).length, input.length);
  assert.equal(input[0]!.id, "web-staging");
  assert.equal(groupDeployablesByServer([input[1]!], servers).length, 1);
  assert.deepEqual(groupDeployablesByServer([], servers), []);
});

test("environment grouping combines repositories while preserving every instance", () => {
  const instance = (
    id: string,
    sourceId: string,
    manifestId: string,
    name: string | null,
  ) => ({
    id,
    sourceId,
    manifestId,
    entityId: "same-entity",
    environment: name === null ? null : { name },
  });
  const input = [
    instance("staging", "one", "api", "staging"),
    instance("prod-web", "one", "website", "production"),
    instance("unassigned", "one", "api", null),
    instance("prod-api", "two", "api", "production"),
    instance("named-unassigned", "two", "api", "No environment"),
  ];
  const groups = groupDeployablesByEnvironment(input);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["No environment", "production", "staging", null],
  );
  assert.deepEqual(
    groups[1]!.items.map((item) => item.id),
    ["prod-api", "prod-web"],
  );
  assert.equal(
    new Set(groups.flatMap((group) => group.items.map((item) => item.id))).size,
    input.length,
  );
  assert.equal(groups[1]!.items[0], input[3]);
  assert.equal(input[0]!.id, "staging");
  assert.deepEqual(groupDeployablesByEnvironment([]), []);
});

test("workload switching prefers the current environment and avoids archived fallbacks", async () => {
  const { preferredDeployableInstance } = await import("./deployable-groups");
  const production = { archivedAt: null, environment: { name: "production" } };
  const staging = { archivedAt: null, environment: { name: "staging" } };
  assert.equal(
    preferredDeployableInstance([production, staging], "staging"),
    staging,
  );
  assert.equal(
    preferredDeployableInstance([production, staging], "review"),
    production,
  );
  assert.equal(
    preferredDeployableInstance(
      [{ ...production, archivedAt: "2026-01-01" }, staging],
      "review",
    ),
    staging,
  );
});
