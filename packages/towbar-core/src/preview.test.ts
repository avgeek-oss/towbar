import assert from "node:assert/strict";
import test from "node:test";

import {
  createPreviewAppSnapshot,
  previewHostname,
  previewRef,
  previewRuntimeId,
} from "./preview.js";

import type { NormalizedApp } from "./manifest.js";

const app: NormalizedApp = {
  autoDeploy: true,
  vulnerabilityScanning: true,
  container: { port: 3000 },
  context: ".",
  deploymentInputs: ["apps/example/**"],
  dockerfile: "apps/example/Dockerfile",
  domains: { primary: "example.com", redirects: [] },
  health: { path: "/health", timeoutSeconds: 60 },
  hooks: {
    postDeploy: {
      command: ["node", "post-deploy.js"],

      timeoutSeconds: 60,
    },
    preDeploy: {
      command: ["node", "migrate.js"],

      timeoutSeconds: 300,
    },
  },
  id: "example",
  name: "Example",
  preview: {
    domain: "preview.example.com",
    enabled: true,

    ttlHours: 72,
  },

  server: "203.0.113.10",

  sourceBranch: "main",
  tls: { mode: "cloudflare-dns" },
};

void test("creates a stable pull request hostname and isolated runtime identity", () => {
  const input = {
    appId: app.id,
    domain: app.preview!.domain,
    pullRequestNumber: 42,
    sourceId: "018f47a0-64e7-7b44-8500-2e4cb0c8f9aa",
  };
  const hostname = previewHostname(input);
  assert.equal(hostname, previewHostname(input));
  assert.match(hostname, /^example-pr-42-[a-f0-9]{8}\.preview\.example\.com$/u);
  assert.equal(previewRef(input.pullRequestNumber), "refs/pull/42/head");
  assert.notEqual(previewRuntimeId(input), app.id);
  assert.ok(hostname.split(".")[0]!.length <= 63);
});

void test("keeps Preview DNS labels valid for maximum-length app IDs", () => {
  const hostname = previewHostname({
    appId: "a".repeat(63),
    domain: "preview.example.com",
    pullRequestNumber: 123_456,
    sourceId: "018f47a0-64e7-7b44-8500-2e4cb0c8f9aa",
  });
  assert.ok(hostname.split(".")[0]!.length <= 63);
  assert.match(hostname, /-[a-f0-9]{8}\.preview\.example\.com$/u);
});

void test("builds Preview snapshots without production or shared secrets", () => {
  const snapshot = createPreviewAppSnapshot(app, {
    branch: "feature/tw-4",
    hostname: "example-feature-tw-4.preview.example.com",
  });
  assert.equal(snapshot.preview, undefined);
  assert.equal(snapshot.vulnerabilityScanning, true);
  assert.equal(snapshot.sourceBranch, "feature/tw-4");
  assert.deepEqual(snapshot.domains, {
    primary: "example-feature-tw-4.preview.example.com",
    redirects: [],
  });
  assert.equal("secrets" in snapshot, false);
  assert.equal("sharedSecrets" in snapshot, false);
  assert.deepEqual(snapshot.hooks.postDeploy?.command, [
    "node",
    "post-deploy.js",
  ]);
});

void test("Preview snapshots retain the service's DNS-only policy", () => {
  const snapshot = createPreviewAppSnapshot(
    { ...app, tls: { mode: "cloudflare-dns", proxied: false } },
    {
      branch: "feature/dns-only",
      hostname: "example-pr-42.preview.example.com",
    },
  );
  assert.deepEqual(snapshot.tls, { mode: "cloudflare-dns", proxied: false });
});
