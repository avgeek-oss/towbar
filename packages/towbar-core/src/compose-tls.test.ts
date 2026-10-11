import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import {
  deploymentCloudflareDnsDomains,
  deploymentCloudflareDnsProxy,
} from "./cloudflare-dns.js";
import { normalizeDeploymentManifest } from "./manifest.js";
import type { DeploymentManifestInput } from "./manifest.js";
import { resolveRepositoryEnvironment } from "./manifest-v2.js";

const compose = {
  id: "stack",
  name: "Stack",
  server: "192.0.2.10",
  file: "compose.yml",
  services: {
    api: {
      port: 3000,
      domains: ["API.Example.COM"],
      ingress: { type: "proxy" },
      tls: { mode: "cloudflare-dns" },
    },
    web: { port: 8080, domains: ["web.example.com"], tls: { mode: "direct" } },
    cache: {},
  },
} satisfies NonNullable<DeploymentManifestInput["compose"]>[number];

void test("Compose preserves route TLS modes and normalizes domains", () => {
  const app = normalizeDeploymentManifest({ version: 2, compose: [compose] })
    .compose![0]!;
  assert.equal(app.services.api?.tls?.mode, "cloudflare-dns");
  assert.equal(app.services.web?.tls?.mode, "direct");
  assert.deepEqual(app.services.api?.domains, ["api.example.com"]);
  assert.deepEqual(deploymentCloudflareDnsDomains(app), ["api.example.com"]);
  assert.equal(app.tls, undefined);
  const legacy = normalizeDeploymentManifest({
    version: 2,
    compose: [
      {
        ...compose,
        services: { web: { port: 8080, domains: ["web.example.com"] } },
      },
    ],
  }).compose![0]!;
  assert.equal(legacy.services.web?.tls, undefined);
  assert.deepEqual(deploymentCloudflareDnsDomains(legacy), []);
});

void test("Compose TLS supports deep environment overrides without changing sibling routes", () => {
  const { server: _server, ...defaults } = compose;
  const { manifest } = resolveRepositoryEnvironment({
    root: stringify({ version: 2, environments: { production: {} } }),
    branch: "main",
    environment: "production",
    files: [
      {
        path: ".towbar/services/stack.compose.yml",
        content: stringify({
          ...defaults,
          environments: {
            production: {
              server: compose.server,
              services: { web: { tls: { mode: "cloudflare-dns" } } },
            },
          },
        }),
      },
    ],
  });
  assert.deepEqual(deploymentCloudflareDnsDomains(manifest.compose![0]!), [
    "api.example.com",
    "web.example.com",
  ]);
});

void test("Compose rejects TLS without domains and explicit TLS on a Tunnel route", () => {
  for (const policy of [
    { tls: { mode: "cloudflare-dns" } },
    { tls: { mode: "direct" }, domains: [] },
    {
      port: 8080,
      domains: ["web.example.com"],
      ingress: { type: "cloudflare-tunnel", integration: "cloudflare" },
      tls: { mode: "cloudflare-dns" },
    },
    {
      port: 8080,
      domains: ["web.example.com"],
      ingress: { type: "cloudflare-tunnel", integration: "cloudflare" },
      tls: { mode: "direct" },
    },
  ] satisfies NonNullable<
    NonNullable<DeploymentManifestInput["compose"]>[number]["services"]
  >[string][])
    assert.throws(() =>
      normalizeDeploymentManifest({
        version: 2,
        compose: [{ ...compose, services: { web: policy } }],
      }),
    );
});

void test("Compose DNS routes retain domain ownership checks across services and workloads", () => {
  assert.throws(
    () =>
      normalizeDeploymentManifest({
        version: 2,
        compose: [
          {
            ...compose,
            services: {
              api: compose.services.api,
              web: { ...compose.services.web, domains: ["api.example.com"] },
            },
          },
        ],
      }),
    /already claimed/,
  );
  assert.throws(
    () =>
      normalizeDeploymentManifest({
        version: 2,
        compose: [compose],
        apps: [
          {
            id: "other",
            name: "Other",
            server: "192.0.2.10",
            dockerfile: "Dockerfile",
            container: { port: 3000 },
            domains: { primary: "api.example.com" },
          },
        ],
      }),
    /already claimed/,
  );
  assert.throws(() =>
    normalizeDeploymentManifest({
      version: 2,
      compose: [
        {
          ...compose,
          services: {
            api: {
              ...compose.services.api,
              domains: ["https://api.example.com"],
            },
          },
        },
      ],
    }),
  );
});

void test("Compose DNS-only overrides preserve TLS mode and proxied siblings", () => {
  const { server: _server, ...defaults } = compose;
  const { manifest } = resolveRepositoryEnvironment({
    root: stringify({ version: 2, environments: { production: {} } }),
    branch: "main",
    environment: "production",
    files: [
      {
        path: ".towbar/services/stack.compose.yml",
        content: stringify({
          ...defaults,
          services: {
            ...defaults.services,
            web: { ...defaults.services.web, tls: { mode: "cloudflare-dns" } },
          },
          environments: {
            production: {
              server: compose.server,
              services: { api: { tls: { proxied: false } } },
            },
          },
        }),
      },
    ],
  });
  const app = manifest.compose![0]!;
  assert.deepEqual(app.services.api?.tls, {
    mode: "cloudflare-dns",
    proxied: false,
  });
  assert.deepEqual(deploymentCloudflareDnsProxy(app), {
    "api.example.com": false,
    "web.example.com": true,
  });
});

void test("services and datastores preserve DNS-only policy for primary and redirect domains", () => {
  const route = {
    server: "192.0.2.10",
    container: { port: 8080 },
    health: { type: "http", path: "/" },
    domains: {
      primary: "app.example.com",
      redirects: [{ host: "www.app.example.com" }],
    },
    tls: { mode: "cloudflare-dns", proxied: false },
  } satisfies Pick<
    NonNullable<DeploymentManifestInput["apps"]>[number],
    "server" | "container" | "health" | "domains" | "tls"
  >;
  const manifest = normalizeDeploymentManifest({
    version: 2,
    apps: [{ ...route, id: "app", name: "App", dockerfile: "Dockerfile" }],
    resources: [
      {
        ...route,
        id: "store",
        name: "Store",
        type: "clickhouse",
        domains: { primary: "store.example.com" },
      },
    ],
  });
  assert.deepEqual(deploymentCloudflareDnsProxy(manifest.apps[0]!), {
    "app.example.com": false,
    "www.app.example.com": false,
  });
  assert.deepEqual(deploymentCloudflareDnsProxy(manifest.resources![0]!), {
    "store.example.com": false,
  });
  assert.throws(
    () =>
      normalizeDeploymentManifest({
        version: 2,
        apps: [
          {
            ...route,
            id: "app",
            name: "App",
            dockerfile: "Dockerfile",
            tls: { mode: "direct", proxied: false },
          },
        ],
      }),
    /only supported with cloudflare-dns/,
  );
  assert.throws(
    () =>
      normalizeDeploymentManifest({
        version: 2,
        compose: [
          {
            ...compose,
            services: {
              api: {
                ...compose.services.api,
                tls: { mode: "direct", proxied: true },
              },
            },
          },
        ],
      }),
    /only supported with cloudflare-dns/,
  );
});
