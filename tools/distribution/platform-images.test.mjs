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
  const { build, "merge-images": merge, manifest, publish } = workflow.jobs;
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
  assert.deepEqual(merge.needs, ["prepare", "build"]);
  assert.deepEqual(manifest.needs, ["prepare", "merge-images"]);
  assert(publish.needs.includes("local-installation-smoke"));
});
