import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import {
  platformImageInputs,
  platformIndexDigest,
} from "./platform-images.mjs";

const image = "ghcr.io/avgeek-oss/towbar-api";
const records = ["amd64", "arm64"].map((platform, index) => ({
  service: "api",
  platform,
  image: `${image}@sha256:${String(index).repeat(64)}`,
}));

test("release image assembly requires both native platforms from the expected service and registry", () => {
  assert.deepEqual(
    platformImageInputs([...records].reverse(), "api", image),
    records.map((record) => record.image),
  );
  for (const invalid of [
    records.slice(0, 1),
    [records[0], records[0]],
    [records[0], { ...records[1], platform: "armv7" }],
    [records[0], { ...records[1], service: "worker" }],
    [records[0], { ...records[1], image: `${image}:latest` }],
    [
      records[0],
      { ...records[1], image: `ghcr.io/other/api@sha256:${"a".repeat(64)}` },
    ],
  ])
    assert.throws(
      () => platformImageInputs(invalid, "api", image),
      /immutable image/,
    );
});

test("the published index is rejected if either supported architecture is missing", () => {
  const index = {
    digest: `sha256:${"a".repeat(64)}`,
    manifests: [
      ...["amd64", "arm64"].map((architecture) => ({
        platform: { os: "linux", architecture },
      })),
      { platform: { os: "unknown", architecture: "unknown" } },
    ],
  };
  assert.equal(platformIndexDigest(index), index.digest);
  for (const manifests of [
    [],
    index.manifests.slice(0, 1),
    [index.manifests[0], index.manifests[0]],
  ])
    assert.throws(
      () => platformIndexDigest({ ...index, manifests }),
      /both release platforms/,
    );
});

test("release builds use matching native runners and publish only after platform assembly and installation", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/release-images.yml", import.meta.url),
      "utf8",
    ),
  );
  const {
    build,
    manifest,
    "local-installation-smoke": installation,
  } = workflow.jobs;
  assert.deepEqual(build.strategy.matrix.platform, ["amd64", "arm64"]);
  assert.equal(
    build.strategy.matrix.include.find((entry) => entry.platform === "arm64")
      .runner,
    "ubuntu-24.04-arm",
  );
  assert.equal(
    build.strategy.matrix.include.find((entry) => entry.platform === "amd64")
      .runner,
    "ubuntu-24.04",
  );
  assert(!build.steps.some((step) => step.uses?.includes("setup-qemu")));
  assert.deepEqual(manifest.needs, ["prepare", "build"]);
  assert.deepEqual(installation.needs, ["prepare", "manifest"]);
  const step = (name) =>
    installation.steps.findIndex((candidate) => candidate.name === name);
  const promote = step("Publish the verified GitHub release");
  assert(step("Install the candidate release locally") >= 0);
  assert(promote > step("Install the candidate release locally"));
  assert(promote > step("Prove restart reuses the running images"));
  assert.equal(installation.steps[promote].if, undefined);
});

test("release rehearsals cannot publish and real releases keep every gate", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/release-images.yml", import.meta.url),
      "utf8",
    ),
  );
  const { rehearsal, ...real } = workflow.jobs;
  assert.deepEqual(Object.keys(real).sort(), [
    "build",
    "local-installation-smoke",
    "manifest",
    "prepare",
  ]);
  // Every publishing job is limited to real dispatches.
  for (const job of Object.values(real))
    assert.equal(
      job.if,
      "github.event_name == 'workflow_dispatch' && !inputs.dry_run",
    );
  assert.equal(
    rehearsal.if,
    "github.event_name == 'pull_request' || inputs.dry_run",
  );
  // The rehearsal holds no write permission, credentials or publishing step.
  assert.deepEqual(rehearsal.permissions, { contents: "read" });
  const text = JSON.stringify(rehearsal);
  assert.doesNotMatch(
    text,
    /login-action|packages|id-token|gh release|imagetools|push=true|GH_TOKEN|github\.token|ghcr\.io/,
  );
  const bake = rehearsal.steps.find((step) =>
    step.run?.includes("docker buildx bake"),
  );
  for (const target of ["api", "worker", "web-app"])
    assert.match(
      bake.run,
      new RegExp(`--set "${target}\\.output=type=oci,dest=`),
    );
  assert.equal(rehearsal.env.REHEARSAL_REGISTRY, "localhost:5000");
  // Native runners for both platforms, as in the real build.
  assert.deepEqual(rehearsal.strategy.matrix.platform, ["amd64", "arm64"]);
  assert(!rehearsal.steps.some((step) => step.uses?.includes("setup-qemu")));
  // Rehearsals never join, or replace a pending run in, the real release queue.
  assert.match(workflow.concurrency.group, /'towbar-release-publication'/);
  assert.match(workflow.concurrency.group, /towbar-release-rehearsal-/);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, false);
  for (const path of [
    ".github/workflows/release-images.yml",
    "docker-bake.hcl",
    "apps/towbar-api/Dockerfile",
    "apps/towbar-worker/Dockerfile",
    "apps/towbar-web-app/Dockerfile",
    "tools/distribution/**",
  ])
    assert(workflow.on.pull_request.paths.includes(path), path);
});
