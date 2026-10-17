import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedApp, NormalizedResource } from "@workspace/towbar-core";
import {
  type ManifestDeclaration,
  type RegisteredWorkload,
  changedConfigurationPaths,
  planManifestIdentities,
} from "./plan.js";
const config: NormalizedApp = {
  kind: "app",
  autoDeploy: false,
  vulnerabilityScanning: false,
  id: "posted",
  name: "Posted",
  server: "192.0.2.10",
  sourceBranch: "main",
  dockerfile: "Dockerfile",
  context: ".",
  deploymentInputs: [],
  container: { port: 3000 },
  health: { path: "/health", timeoutSeconds: 60 },
  hooks: {},
};
const resource: NormalizedResource = {
  kind: "postgres",
  id: config.id,
  name: "Database",
  image: "postgres:17-alpine",
  server: config.server,
  sourceBranch: "main",
  autoDeploy: false,
  container: {
    command: [],
    resources: { cpus: 1, memory: "1g" },
    volumes: [],
  },
  health: { type: "command", command: ["pg_isready"], timeoutSeconds: 60 },
};
const declaration: ManifestDeclaration = {
  config,
  sourceId: "first",
  sourceEnvironmentId: "first-production",
  environment: "production",
  commitSha: "a".repeat(40),
};
const workload: RegisteredWorkload = {
  id: "preserved-id",
  sourceId: "first",
  environment: "production",
  manifestId: config.id,
  config,
  manifestState: "active",
};
void test("IDs are unique across repositories and types, scoped by environment", () => {
  const sameEnvironment = planManifestIdentities(
    [declaration, { ...declaration, sourceId: "second" }],
    [workload],
  );
  assert.equal(sameEnvironment[0]?.state, "conflict");
  const environments = planManifestIdentities(
    [
      declaration,
      { ...declaration, sourceId: "second", environment: "staging" },
    ],
    [workload],
  );
  assert(environments.every((plan) => plan.state === "active"));
  assert.equal(
    planManifestIdentities(
      [{ ...declaration, config: resource }],
      [workload],
    )[0]?.state,
    "conflict",
  );
});
void test("missing declarations preserve retirements and removed records never resurrect", () => {
  assert.equal(planManifestIdentities([], [workload])[0]?.state, "retired");
  assert.equal(
    planManifestIdentities(
      [declaration],
      [{ ...workload, manifestState: "removed" }],
    )[0]?.workloads.length,
    0,
  );
  const legacy = planManifestIdentities(
    [],
    [workload, { ...workload, id: "other", sourceId: "second" }],
  );
  assert.equal(legacy[0]?.state, "retired");
});
void test("configuration diff paths never expose secret literals", () => {
  assert.deepEqual(
    changedConfigurationPaths(
      { env: { TOKEN: "private-before" }, image: "v1" },
      { env: { TOKEN: "private-after" }, image: "v2" },
    ),
    ["env.TOKEN", "image"],
  );
});

void test("a proven legacy archive retires separately from its current declaration's owner", () => {
  const owner = {
    ...workload,
    sourceEnvironmentId: declaration.sourceEnvironmentId,
  };
  const legacy = {
    ...workload,
    id: "legacy-id",
    manifestState: "conflict",
    legacyArchivedAt: new Date("2026-10-10T14:51:33Z"),
  };
  const plans = planManifestIdentities([declaration], [legacy, owner]);
  assert.equal(plans.length, 2);
  assert.equal(
    plans.find((plan) => plan.workloads[0]?.id === owner.id)?.state,
    "active",
  );
  const retired = plans.find((plan) => plan.workloads[0]?.id === legacy.id);
  assert.equal(retired?.state, "retired");
  assert.deepEqual(retired?.declarations, []);
  assert.equal(new Set(plans.map((plan) => plan.key)).size, 2);
  assert.equal(
    planManifestIdentities(
      [declaration],
      [legacy, { ...owner, legacyArchivedAt: new Date() }],
    )[0]?.state,
    "conflict",
    "two archived candidates do not authorize choosing an owner",
  );
});
void test("unproven duplicates and competing declarations remain conflicts", () => {
  const owner = {
    ...workload,
    sourceEnvironmentId: declaration.sourceEnvironmentId,
  };
  assert.equal(
    planManifestIdentities([declaration], [owner, { ...owner, id: "other" }])[0]
      ?.state,
    "conflict",
  );
  const legacy = { ...owner, id: "legacy", legacyArchivedAt: new Date() };
  assert.equal(
    planManifestIdentities(
      [declaration, { ...declaration, sourceId: "other" }],
      [legacy, owner],
    )[0]?.state,
    "conflict",
  );
  assert.equal(
    planManifestIdentities(
      [declaration],
      [legacy, { ...owner, sourceEnvironmentId: "other" }],
    )[0]?.state,
    "conflict",
  );
  assert.equal(
    planManifestIdentities(
      [declaration],
      [legacy, { ...owner, manifestState: "removing" }],
    )[0]?.state,
    "conflict",
  );
});
void test("a sole legacy archive still requires compatible adoption", () => {
  const legacy = {
    ...workload,
    legacyArchivedAt: new Date(),
    manifestState: "retired",
  };
  assert.equal(
    planManifestIdentities([declaration], [legacy])[0]?.state,
    "active",
  );
  assert.equal(
    planManifestIdentities(
      [
        {
          ...declaration,
          config: resource,
        },
      ],
      [legacy],
    )[0]?.state,
    "conflict",
  );
});
