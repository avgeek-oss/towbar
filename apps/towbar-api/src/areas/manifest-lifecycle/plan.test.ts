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
