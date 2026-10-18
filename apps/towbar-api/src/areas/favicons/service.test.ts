import assert from "node:assert/strict";
import test from "node:test";
import { appIconSource, deploymentIconSource } from "./service.js";

void test("services and historical deployments prefer a direct workload icon URL", () => {
  const config = { iconUrl: "https://cdn.example.com/posted/worker.png?v=2" };
  assert.equal(
    appIconSource(config),
    "https://cdn.example.com/posted/worker.png?v=2",
  );
  assert.equal(appIconSource({}), null);
  assert.equal(
    appIconSource({
      ...config,
      domains: { primary: "api.example.com" },
    }),
    "https://cdn.example.com/posted/worker.png?v=2",
  );
  assert.equal(
    deploymentIconSource({
      environment: "preview",
      hostname: "pr-42.example.com",
      appSnapshot: config,
    }),
    "https://cdn.example.com/posted/worker.png?v=2",
  );
});

void test("deployment icons stay on their recorded or preview hostname", () => {
  const appSnapshot = {
    domains: {
      primary: "production.example.com",
      redirects: [{ host: "redirect.example.com" }],
    },
  };
  assert.equal(
    deploymentIconSource({
      environment: "preview",
      hostname: null,
      appSnapshot,
    }),
    null,
  );
  assert.equal(
    deploymentIconSource({
      environment: "preview",
      hostname: "pr-42.example.com",
      appSnapshot,
    }),
    "pr-42.example.com",
  );
  assert.equal(
    deploymentIconSource({
      environment: "production",
      hostname: "historical.example.com",
      appSnapshot,
    }),
    "historical.example.com",
  );
  assert.equal(
    deploymentIconSource({
      environment: "production",
      hostname: null,
      appSnapshot,
    }),
    "production.example.com",
  );
  assert.equal(
    deploymentIconSource({
      environment: "production",
      hostname: null,
      appSnapshot: {
        domains: { redirects: [{ host: "redirect.example.com" }] },
      },
    }),
    "redirect.example.com",
  );
});
