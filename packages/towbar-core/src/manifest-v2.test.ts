import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import {
  entityFileKind,
  parseRepositoryManifest,
  resolveRepositoryEnvironment,
} from "./manifest-v2.js";

const root = stringify({
  version: 2,
  environments: {
    production: {},
    staging: { previews: { enabled: true } },
  },
});
const app = {
  id: "website",
  name: "Website",
  dockerfile: "Dockerfile",
  autoDeploy: true,
  container: { port: 3000, resources: { cpus: 1, memory: "512m" } },
  secrets: { runtime: ["DATABASE_URL", "SESSION_SECRET"] },
  environments: {
    production: {
      server: "192.0.2.10",
      domains: { primary: "app.example.com" },
    },
    staging: {
      server: "192.0.2.11",
      container: { resources: { cpus: 0.5 } },
      domains: { primary: "staging.example.com" },
    },
  },
  tls: { mode: "direct" },
  preview: { enabled: true, domain: "preview.example.com", ttlHours: 72 },
};
function resolve(
  entity: unknown = app,
  environment = "staging",
  resource?: unknown,
) {
  return resolveRepositoryEnvironment({
    root,
    environment,
    branch: environment === "staging" ? "develop" : "main",
    files: [
      {
        path: ".towbar/services/website.service.yml",
        content: stringify(entity),
      },
      ...(resource
        ? [
            {
              path: ".towbar/datastores/database.datastore.yml",
              content: stringify(resource),
            },
          ]
        : []),
    ],
  });
}

void test("workload icon URLs preserve paths and queries and support environment overrides without public routing", () => {
  const privateApp = {
    ...app,
    tls: undefined,
    preview: undefined,
    iconUrl: "https://CDN.Example.com/Posted/worker.png?v=2#preview",
    environments: { production: { server: "192.0.2.10" } },
  };
  const { manifest } = resolve(privateApp, "production");
  assert.equal(
    manifest.apps[0]?.iconUrl,
    "https://cdn.example.com/Posted/worker.png?v=2",
  );
  assert.equal(manifest.apps[0]?.domains, undefined);
  assert.equal(
    resolve(
      {
        ...privateApp,
        environments: {
          production: {
            server: "192.0.2.10",
            iconUrl: "https://Brand.Example.com/staging.svg?theme=dark",
          },
        },
      },
      "production",
    ).manifest.apps[0]?.iconUrl,
    "https://brand.example.com/staging.svg?theme=dark",
  );
});

void test("workload icons reject invalid or non-public HTTPS URLs and the superseded domain setting", () => {
  for (const iconUrl of [
    "example.com/icon.png",
    "/icon.png",
    "http://example.com/icon.png",
    "",
    "https://user:password@example.com/icon.png",
    "https://example.com:8443/icon.png",
    "https://127.0.0.1/icon.png",
    "https://[::1]/icon.png",
    "https://localhost/icon.png",
    "https://host.internal/icon.png",
    "https://host.local/icon.png",
    "data:image/png;base64,AAAA",
    "file:///tmp/icon.png",
    "https://example.com/" + "x".repeat(2048),
  ])
    assert.throws(() => resolve({ ...app, iconUrl }, "production"), iconUrl);
  assert.throws(() =>
    resolve({ ...app, faviconDomain: "example.com" }, "production"),
  );
});

void test("resolves PostgreSQL 18 as a managed datastore with initialization files", () => {
  const image = `postgres:18-alpine@sha256:${"a".repeat(64)}`;
  const { manifest } = resolve(app, "production", {
    id: "database",
    name: "PostgreSQL 18",
    type: "postgres",
    image,
    container: {
      network: "platform",
      networkAlias: "database",
      configFiles: [
        {
          source: ".towbar/config/init.sh",
          mountPath: "/docker-entrypoint-initdb.d/init.sh",
        },
      ],
    },
    secrets: { runtime: ["POSTGRES_DB", "POSTGRES_PASSWORD"] },
    environments: { production: { server: "192.0.2.10" } },
  });
  const database = manifest.resources?.[0];
  assert.equal(database?.kind, "postgres");
  assert.equal(database?.image, image);
  assert.deepEqual(database?.container.volumes, [
    { name: "data", mountPath: "/var/lib/postgresql" },
  ]);
  assert.equal(
    database?.container.configFiles?.[0]?.mountPath,
    "/docker-entrypoint-initdb.d/init.sh",
  );
  assert.deepEqual(manifest.requiredSecrets["resource:database"]?.runtime, [
    "POSTGRES_DB",
    "POSTGRES_PASSWORD",
  ]);
});

void test("root rejects Git branch mappings and configurable entity directories", () => {
  assert.throws(() =>
    parseRepositoryManifest(
      "version: 2\nenvironments:\n  production:\n    branch: main",
    ),
  );
  assert.throws(() => parseRepositoryManifest(`${root}\nentities: .towbar`));
});

void test("resolves only selected environment with deep object overrides and required secrets", () => {
  const { manifest } = resolve();
  assert.equal(manifest.version, 2);
  assert.equal(manifest.apps[0]?.server, "192.0.2.11");
  assert.equal(manifest.apps[0]?.sourceBranch, "develop");
  assert.deepEqual(manifest.apps[0]?.container.resources, {
    cpus: 0.5,
    memory: "512m",
  });
  assert.deepEqual(manifest.requiredSecrets["app:website"]?.runtime, [
    "DATABASE_URL",
    "SESSION_SECRET",
  ]);
  assert.equal(manifest.apps[0]?.preview?.enabled, true);
  assert.equal(resolve(app, "production").manifest.apps[0]?.preview, undefined);
});

void test("production-only edits do not change staging digest", () => {
  const changed = structuredClone(app);
  changed.environments.production.domains.primary = "other.example.com";
  assert.equal(resolve().digest, resolve(changed).digest);
  assert.notEqual(
    resolve(app, "production").digest,
    resolve(changed, "production").digest,
  );
});

void test("replaces lists instead of concatenating them", () => {
  const entity = {
    ...app,
    domains: {
      primary: "base.example.com",
      redirects: [{ host: "old.example.com" }],
    },
    environments: {
      staging: { server: "192.0.2.11", domains: { redirects: [] } },
    },
  };
  assert.deepEqual(resolve(entity).manifest.apps[0]?.domains?.redirects, []);
});

void test("explicit environment membership controls instances", () => {
  const entity = {
    ...app,
    environments: { production: app.environments.production },
  };
  assert.equal(resolve(entity).manifest.apps.length, 0);
  assert.deepEqual(Object.keys(resolve(entity).manifest.requiredSecrets), []);
});

void test("logical app and resource may share an id", () => {
  const result = resolve(app, "staging", {
    id: "website",
    name: "Database",
    type: "postgres",
    environments: { staging: { server: "192.0.2.11" } },
  });
  assert.equal(result.manifest.apps[0]?.id, result.manifest.resources?.[0]?.id);
});

void test("resources declare runtime secrets only", () => {
  const resource = {
    id: "database",
    name: "Database",
    type: "postgres",
    secrets: { runtime: ["POSTGRES_PASSWORD"] },
    environments: { staging: { server: "192.0.2.11" } },
  };
  assert.deepEqual(
    resolve(app, "staging", resource).manifest.requiredSecrets[
      "resource:database"
    ],
    {
      build: [],
      runtime: ["POSTGRES_PASSWORD"],
      preDeploy: [],
      postDeploy: [],
    },
  );
  for (const stage of ["build", "preDeploy", "postDeploy"]) {
    assert.throws(() =>
      resolve(app, "staging", {
        ...resource,
        secrets: { ...resource.secrets, [stage]: ["TOKEN"] },
      }),
    );
  }
});

void test("External secret source supports optional scope and provider project names", () => {
  const source = {
    integration: "infisical",
    project: "6354f023-12c7-4ce1-b860-750b38e1a3ef",
    environmentSlug: "prod",
  };
  const result = resolve({ ...app, externalSecrets: source });
  assert.deepEqual(result.manifest.apps[0]?.externalSecrets, {
    ...source,
  });
  const resource = {
    id: "database",
    name: "Database",
    type: "postgres",
    externalSecrets: { ...source, secretPath: "infisical-postgres" },
    environments: { staging: { server: "192.0.2.11" } },
  };
  assert.deepEqual(
    resolve(app, "staging", resource).manifest.resources?.[0]?.externalSecrets,
    { ...source, secretPath: "infisical-postgres" },
  );
  assert.throws(() =>
    resolve({
      ...app,
      externalSecrets: { ...source, secretPath: "../private" },
    }),
  );
  const doppler = { integration: "doppler", project: "example-api" };
  assert.deepEqual(
    resolve({ ...app, externalSecrets: doppler }).manifest.apps[0]
      ?.externalSecrets,
    doppler,
  );
  assert.deepEqual(
    resolve({ ...app, externalSecrets: { ...doppler, config: "prd" } }).manifest
      .apps[0]?.externalSecrets,
    { ...doppler, config: "prd" },
  );
  assert.throws(() =>
    resolve({
      ...app,
      externalSecrets: { ...source, environment: "Production" },
    }),
  );
  assert.throws(() =>
    resolve({ ...app, externalSecrets: { ...source, secretPath: "." } }),
  );
  assert.throws(() =>
    resolve({ ...app, externalSecrets: { ...source, config: "prd" } }),
  );
  assert.throws(() =>
    resolve({ ...app, externalSecrets: { ...doppler, secretPath: "folder" } }),
  );
  assert.throws(() =>
    resolve({
      ...app,
      externalSecrets: {
        API_TOKEN: {
          integration: "doppler",
          secret: "example-api/prd/API_TOKEN",
          use: "runtime",
        },
      },
    }),
  );
});

void test("sync resolves per-entity notification destinations without credentials", () => {
  const notifications = {
    email: [
      {
        address: "Ops@Example.com",
        deployments: true,
        backupsAndRestores: false,
        alertsAndIncidents: true,
      },
    ],
    slack: [
      {
        channelId: "C12345678",
        deployments: false,
        backupsAndRestores: true,
        alertsAndIncidents: false,
      },
    ],
    discord: [
      {
        webhookId: "123456789",
        deployments: true,
        backupsAndRestores: false,
        alertsAndIncidents: false,
      },
    ],
    telegram: [
      {
        chatId: "-1001234567890",
        messageThreadId: 42,
        deployments: false,
        backupsAndRestores: false,
        alertsAndIncidents: true,
      },
    ],
  };
  const resource = {
    id: "database",
    name: "Database",
    type: "postgres",
    notifications,
    environments: { staging: { server: "192.0.2.11" } },
  };
  const result = resolve({ ...app, notifications }, "staging", resource);
  assert.equal(
    result.manifest.apps[0]?.notifications?.email?.[0]?.address,
    "ops@example.com",
  );
  assert.deepEqual(
    result.manifest.resources?.[0]?.notifications,
    result.manifest.apps[0]?.notifications,
  );
  assert.notEqual(result.digest, resolve().digest);
  assert.throws(() =>
    resolve({
      ...app,
      notifications: {
        discord: [{ ...notifications.discord[0], webhookToken: "secret" }],
      },
    }),
  );
  assert.throws(() =>
    resolve({
      ...app,
      notifications: { webhook: [{ url: "https://hooks.example.com" }] },
    }),
  );
});

void test("rejects unknown environments and identity overrides", () => {
  assert.throws(
    () => resolve({ ...app, environments: { typo: { server: "192.0.2.11" } } }),
    /invalid/,
  );
  assert.throws(() =>
    resolve({
      ...app,
      environments: { staging: { id: "other", server: "192.0.2.11" } },
    }),
  );
  assert.throws(() => resolve(app, "missing"));
});

void test("rejects duplicate keys, aliases, invalid secrets and non-IP server references", () => {
  assert.throws(() =>
    parseRepositoryManifest("version: 2\nversion: 2\nenvironments: {}"),
  );
  assert.throws(() =>
    parseRepositoryManifest(
      "version: 2\nenvironments:\n  production: &prod {}\n  staging: *prod",
    ),
  );
  assert.throws(() => resolve({ ...app, secrets: { runtime: ["A", "A"] } }));
  assert.throws(() => resolve({ ...app, secrets: { runtime: ["__proto__"] } }));
  assert.throws(() =>
    resolve({
      ...app,
      environments: { staging: { server: "staging-server" } },
    }),
  );
});

void test("discovers reserved paths recursively and rejects escaping paths", () => {
  assert.equal(
    entityFileKind(".towbar/services/team/website.service.yml"),
    "app",
  );
  assert.equal(
    entityFileKind(".towbar/datastores/db.datastore.yml"),
    "resource",
  );
  assert.equal(
    entityFileKind(".towbar/services/storefront.compose.yml"),
    "compose",
  );
  assert.equal(entityFileKind(".towbar/services/db.datastore.yml"), undefined);
  assert.throws(() => entityFileKind(".towbar/apps/web.app.yml"));
  assert.throws(() => entityFileKind(".towbar/resources/db.resource.yml"));
  assert.throws(() =>
    entityFileKind(".towbar/services/../website.service.yml"),
  );
});

void test("same-kind duplicate ids fail even in different files", () => {
  assert.throws(() =>
    resolveRepositoryEnvironment({
      root,
      environment: "staging",
      branch: "develop",
      files: [
        { path: ".towbar/services/a.service.yml", content: stringify(app) },
        { path: ".towbar/services/b.service.yml", content: stringify(app) },
      ],
    }),
  );
});

void test("renaming an entity file preserves resolved identity and digest", () => {
  const renamed = resolveRepositoryEnvironment({
    root,
    environment: "staging",
    branch: "develop",
    files: [
      { path: ".towbar/services/renamed.service.yml", content: stringify(app) },
    ],
  });
  assert.equal(renamed.digest, resolve().digest);
});
