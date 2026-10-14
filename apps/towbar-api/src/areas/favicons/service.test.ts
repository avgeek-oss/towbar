import assert from "node:assert/strict";
import test from "node:test";
import { deploymentIconDomain } from "./service.js";

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
