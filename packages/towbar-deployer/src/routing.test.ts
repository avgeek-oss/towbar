import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderCaddyFragment } from "./routing.js";

import type { DeploymentExecutionContext } from "./types.js";

function context(
  tlsMode: "cloudflare-dns" | "direct" = "cloudflare-dns",
): DeploymentExecutionContext {
  return {
    app: {
      autoDeploy: false,
      container: { port: 3_000 },
      context: ".",
      deploymentInputs: [],
      dockerfile: "Dockerfile",
      domains: {
        primary: "example.com",
        redirects: [{ host: "www.example.com", status: 301 }],
      },
      health: { path: "/health", timeoutSeconds: 60 },
      hooks: {},
      id: "example",
      name: "Example",

      server: "192.0.2.1",
      sourceBranch: "main",
      tls: { mode: tlsMode },
      vulnerabilityScanning: false,
    },
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    currentRelease: null,
    deploymentId: "00000000-0000-4000-8000-000000000000",
    deployableId: "00000000-0000-4000-8000-000000000001",
    environmentName: "production",
    sourceCredential: {
      apiUrl: "https://api.github.com",
      provider: "github",
      token: "token",
    },
    kind: "deploy",
    repositoryName: "repository",
    repositoryOwner: "owner",
    sourceId: "00000000-0000-4000-8000-000000000002",
    rollbackRelease: null,
    serverId: "00000000-0000-4000-8000-000000000003",
    server: {
      buildConcurrency: 1,
      ip: "192.0.2.1",

      ssh: { host: "192.0.2.1", port: 22, username: "deploy" },
    },
    trustedHostKeys: [],
    workspaceId: "00000000-0000-4000-8000-000000000004",
  };
}

void describe("renderCaddyFragment", () => {
  void it("renders Cloudflare DNS TLS for both the primary and redirect hosts", () => {
    const fragment = renderCaddyFragment(context(), 32_768);
    assert.match(fragment, /example\.com \{/u);
    assert.match(fragment, /reverse_proxy 127\.0\.0\.1:32768/u);
    assert.match(fragment, /redir https:\/\/example\.com\{uri\} 301/u);
    assert.equal(
      fragment.match(/dns cloudflare \{env\.CLOUDFLARE_API_TOKEN\}/gu)?.length,
      2,
    );
    assert.equal(
      fragment.match(/header \?Strict-Transport-Security "max-age=15552000"/gu)
        ?.length,
      2,
    );
  });

  void it("keeps DNS certificate validation for DNS-only primary and redirect hosts", () => {
    const deployment = context();
    deployment.app.tls = { mode: "cloudflare-dns", proxied: false };
    assert.equal(
      renderCaddyFragment(deployment, 32_768),
      renderCaddyFragment(context(), 32_768),
    );
  });

  void it("lets Caddy use its normal certificate flow in direct mode", () => {
    const fragment = renderCaddyFragment(context("direct"), 32_768);
    assert.doesNotMatch(fragment, /cloudflare/u);
  });
});
