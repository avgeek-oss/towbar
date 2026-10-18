import assert from "node:assert/strict";
import test from "node:test";
import { appIconDomain, deploymentIconDomain } from "./service.js";

void test("services can share a public branding domain without public routing", () => {
  const config = { faviconDomain: "posted.example.com" };
  assert.equal(appIconDomain(config), "posted.example.com");
  assert.equal(appIconDomain({}), null);
  assert.equal(
    appIconDomain({
      ...config,
      domains: { primary: "api.example.com" },
    }),
    "posted.example.com",
  );
  assert.equal(
    deploymentIconDomain({
      environment: "preview",
      hostname: "pr-42.example.com",
      appSnapshot: config,
    }),
    "posted.example.com",
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
    deploymentIconDomain({
      environment: "preview",
      hostname: null,
      appSnapshot,
    }),
    null,
  );
  assert.equal(
    deploymentIconDomain({
      environment: "preview",
      hostname: "pr-42.example.com",
      appSnapshot,
    }),
    "pr-42.example.com",
  );
  assert.equal(
    deploymentIconDomain({
      environment: "production",
      hostname: "historical.example.com",
      appSnapshot,
    }),
    "historical.example.com",
  );
  assert.equal(
    deploymentIconDomain({
      environment: "production",
      hostname: null,
      appSnapshot,
    }),
    "production.example.com",
  );
  assert.equal(
    deploymentIconDomain({
      environment: "production",
      hostname: null,
      appSnapshot: {
        domains: { redirects: [{ host: "redirect.example.com" }] },
      },
    }),
    "redirect.example.com",
  );
});
