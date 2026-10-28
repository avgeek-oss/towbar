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
    "release-assets": assets,
    "local-installation-smoke": installation,
    withdraw,
    publish,
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
  assert.deepEqual(assets.needs, ["prepare", "manifest"]);
  assert.deepEqual(installation.needs, ["prepare", "release-assets"]);
  const step = (job, name) =>
    job.steps.findIndex((candidate) => candidate.name === name);
  assert(step(installation, "Install the candidate release locally") >= 0);
  assert(step(installation, "Prove restart reuses the running images") >= 0);
  // Promotion is a separate job that runs only when the installation passed.
  assert.deepEqual(publish.needs, ["prepare", "local-installation-smoke"]);
  assert.equal(publish.if, undefined);
  assert(step(publish, "Publish the verified GitHub release") >= 0);
  assert.equal(
    withdraw.if,
    "always() && needs.local-installation-smoke.result == 'failure'",
  );
  // Write scopes stay out of the jobs that run third-party code.
  assert.deepEqual(installation.permissions, { contents: "read" });
  assert.deepEqual(manifest.permissions, {
    contents: "read",
    packages: "write",
  });
  assert.deepEqual(assets.permissions, { contents: "write" });
});
