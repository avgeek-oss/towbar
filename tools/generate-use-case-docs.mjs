import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { parse, stringify } from "yaml";
import { ossRecipes } from "./oss-use-case-recipes.mjs";
import { ossComposeRecipes } from "./oss-compose-recipes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const docs = path.join(root, "docs/docs/use-cases");
const catalog = JSON.parse(
  await readFile(path.join(root, "tools/use-case-catalog.json"), "utf8"),
);
const check = process.argv.includes("--check");
const server = "192.0.2.10";
const otherServer = "192.0.2.11";
const categories = new Set([
  "oss/ai",
  "oss/analytics",
  "oss/observability",
  "oss/developer-tools",
  "oss/security",
  "oss/content-media",
  "oss/automation",
  "oss/collaboration",
  "oss/files",
  "oss/notifications",
  "oss/utilities",
  "services/build",
  "services/runtime",
  "services/operations",
  "datastores/sql",
  "datastores/document-analytics",
  "datastores/cache",
  "datastores/recovery",
  "stacks/web",
  "stacks/workers",
]);

assert.deepEqual(
  catalog.map(({ id }) => id),
  Array.from({ length: catalog.length }, (_, index) => index + 1),
);
assert.equal(
  new Set(catalog.map(({ category, slug }) => `${category}/${slug}`)).size,
  catalog.length,
);
for (const entry of catalog) {
  assert.ok(categories.has(entry.category));
  if (entry.category.startsWith("oss/"))
    assert.doesNotMatch(
      entry.slug,
      /^\d+-/,
      `Numbered OSS slug: ${entry.slug}`,
    );
  assert.ok(
    entry.title.trim().split(/\s+/).length <= 2,
    `Use-case title is too long: ${entry.title}`,
  );
}

function firstYaml(file) {
  const source = fileCache.get(file);
  assert.ok(source, `Missing source guide: ${file}`);
  const match = source.match(/```yaml[^\n]*\n([\s\S]*?)```/);
  assert.ok(match, `Missing YAML in ${file}`);
  return parse(match[1]);
}

const fileCache = new Map();
for (const file of [
  ...["dockerfile", "static", "railpack", "nixpacks", "buildpack", "image"].map(
    (mode) => `docs/docs/services/modes/${mode}.mdx`,
  ),
  ...[
    "postgresql",
    "mysql",
    "mariadb",
    "mongodb",
    "redis",
    "dragonfly",
    "keydb",
    "clickhouse",
  ].map((engine) => `docs/docs/databases/${engine}.mdx`),
])
  fileCache.set(file, await readFile(path.join(root, file), "utf8"));

const engineGuide = {
  postgres: "postgresql",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongodb",
  redis: "redis",
  dragonfly: "dragonfly",
  keydb: "keydb",
  clickhouse: "clickhouse",
};
const productLogos = {
  1: "umami",
  2: "grafana",
  3: "gitea",
  4: "forgejo",
  5: "vaultwarden",
  6: "uptimekuma",
  7: "metabase",
  8: "paperlessngx",
  9: "meilisearch",
  10: "jellyfin",
  87: "meilisearch",
  89: "metabase",
  90: "umami",
  101: "plausibleanalytics",
  102: "matomo",
  104: "prometheus",
  105: "victoriametrics",
  107: "keycloak",
  108: "authentik",
  109: "ghost",
  110: "wordpress",
  113: "nodered",
  115: "searxng",
  116: "freshrss",
  118: "hedgedoc",
  121: "nextcloud",
  122: "immich",
  123: "bookstack",
  124: "calibreweb",
  125: "photoprism",
  126: "miniflux.png",
  127: "ntfy",
  128: "jenkins",
  129: "vikunja",
  131: "excalidraw",
  135: "actualbudget",
  136: "audiobookshelf",
  140: "ollama",
};

function logoFor(entry) {
  if (productLogos[entry.id])
    return `/assets/use-case-logos/${productLogos[entry.id]}${productLogos[entry.id].endsWith(".png") ? "" : ".svg"}`;
  if (entry.category.startsWith("datastores/")) {
    const engine = engineGuide[datastoreEngine(entry.id)];
    return `/assets/database-logos/${engine}.${["dragonfly", "keydb"].includes(engine) ? "svg" : "webp"}`;
  }
  const stackEngine = {
    81: "postgresql",
    82: "mysql",
    83: "mariadb",
    84: "mongodb",
    85: "redis",
    86: "dragonfly",
    88: "clickhouse",
    91: "redis",
    92: "postgresql",
    93: "redis",
    98: "postgresql",
    99: "postgresql",
    100: "postgresql",
  }[entry.id];
  if (stackEngine)
    return `/assets/database-logos/${stackEngine}.${stackEngine === "dragonfly" ? "svg" : "webp"}`;
  if (entry.id === 33) return "/assets/integration-logos/infisical.webp";
  if (entry.id === 34) return "/assets/integration-logos/doppler.svg";
  if ([11, 12, 95].includes(entry.id))
    return "/assets/integration-logos/docker.webp";
  return null;
}

function service(id = "web", name = "Web Service", mode = "dockerfile") {
  const manifest = firstYaml(`docs/docs/services/modes/${mode}.mdx`);
  manifest.id = id;
  manifest.name = name;
  manifest.environments = { production: { server } };
  delete manifest.domains;
  delete manifest.tls;
  delete manifest.preview;
  if (mode !== "image") {
    manifest.deployment.context = ".";
    delete manifest.deployment.architecture;
    delete manifest.deployment.cache;
    delete manifest.deployment.configFile;
    if (mode === "dockerfile") {
      manifest.deployment.dockerfile = "Dockerfile";
      delete manifest.deployment.target;
    }
    if (mode === "static")
      manifest.deployment.buildCommand = ["npm", "run", "build"];
  }
  return manifest;
}

function datastore(engine, id = engine) {
  const manifest = firstYaml(`docs/docs/databases/${engineGuide[engine]}.mdx`);
  manifest.id = id;
  manifest.name = {
    postgres: "PostgreSQL",
    mysql: "MySQL",
    mariadb: "MariaDB",
    mongodb: "MongoDB",
    redis: "Redis",
    dragonfly: "Dragonfly",
    keydb: "KeyDB",
    clickhouse: "ClickHouse",
  }[engine];
  manifest.environments = { production: { server } };
  manifest.container.network = "application";
  manifest.container.networkAlias = id;
  delete manifest.access;
  delete manifest.backup;
  return manifest;
}

function caseId(entry, role = "") {
  const stem = entry.slug.replace(/^\d+-/, "");
  return role ? `${stem}-${role}` : stem;
}

function compose(id, name, serviceName, port) {
  return {
    id,
    name,
    file: `deploy/${id}/compose.yml`,
    strategy: "maintenance",
    services: {
      [serviceName]: {
        port,
        domains: [`${id}.example.com`],
        ingress: { type: "proxy" },
      },
    },
    environments: { production: { server } },
  };
}

function backup(integration = "aws") {
  return {
    integration,
    schedule: { cron: "0 3 * * *", timezone: "UTC" },
    retention: { keepLast: 14 },
  };
}

function serviceFile(manifest) {
  return [`.towbar/services/${manifest.id}.service.yml`, manifest];
}
function datastoreFile(manifest) {
  return [`.towbar/datastores/${manifest.id}.datastore.yml`, manifest];
}
function composeFile(manifest) {
  return [`.towbar/services/${manifest.id}.compose.yml`, manifest];
}
function rootFile(previews = false) {
  return [
    "towbar.yml",
    {
      version: 2,
      environments: {
        production: previews ? { previews: { enabled: true } } : {},
      },
    },
  ];
}

function ossFiles(entry) {
  const composeRecipe = ossComposeRecipes[entry.id];
  if (composeRecipe) {
    const manifest = compose(
      caseId(entry),
      entry.title,
      composeRecipe.routedService,
      composeRecipe.port,
    );
    if (composeRecipe.private)
      manifest.services = { [composeRecipe.routedService]: {} };
    for (const name of composeRecipe.internalServices ?? []) {
      manifest.services ??= {};
      manifest.services[name] = {};
    }
    if (composeRecipe.values)
      manifest.secrets = { runtime: Object.keys(composeRecipe.values) };
    return [composeFile(manifest)];
  }
  const recipe = ossRecipes[entry.id];
  if (recipe) {
    const id = caseId(entry);
    const app = service(id, entry.title, "image");
    app.deployment.image = recipe.image;
    delete app.deployment.platform;
    app.container.port = recipe.port;
    if (recipe.resources) app.container.resources = recipe.resources;
    delete app.health;
    const files = [];
    for (const engine of recipe.datastores ?? []) {
      const database = datastore(engine, `${id}-${engine}`);
      database.name = `${entry.title} ${database.name}`;
      files.push(datastoreFile(database));
    }
    if (recipe.datastores?.length || recipe.public === false)
      app.container.network = "application";
    if (recipe.networkAlias) app.container.networkAlias = id;
    if (recipe.volumes?.length) {
      app.container.volumes = recipe.volumes.map((mountPath) => ({
        name: mountPath
          .split("/")
          .at(-1)
          .toLowerCase()
          .replace(/^[^a-z0-9]+/, ""),
        mountPath,
        initialData: "image",
      }));
      app.rollout = {
        type: "recreate",
        maintenanceMode: true,
        reason: "Persistent application data uses a single writer",
      };
    }
    if (Object.keys(recipe.values ?? {}).length)
      app.secrets = { runtime: Object.keys(recipe.values) };
    if (recipe.public !== false) {
      app.domains = { primary: `${id}.example.com` };
      app.tls = { mode: "direct" };
    }
    files.push(serviceFile(app));
    return files;
  }
  throw new Error(`Missing OSS deployment recipe: ${entry.slug}`);
}

function serviceFiles(entry) {
  const { id } = entry;
  const mode =
    {
      15: "static",
      16: "static",
      17: "railpack",
      18: "nixpacks",
      19: "buildpack",
      20: "image",
    }[id] ?? "dockerfile";
  const app = service(caseId(entry), entry.title, mode);
  const files = [];
  if (id === 12) app.deployment.target = "runtime";
  if (id === 13 || id === 32) app.secrets = { build: ["PACKAGE_TOKEN"] };
  if (id === 14) app.buildServer = { ip: otherServer };
  if (id === 15) delete app.deployment.spaFallback;
  if (id === 16) app.deployment.spaFallback = true;
  if (id === 22) app.health.timeoutSeconds = 90;
  if (id === 23) app.container.resources = { cpus: 2, memory: "2g" };
  if ([24, 25, 26].includes(id)) app.container.network = "application";
  if (id === 25) {
    app.secrets = { runtime: ["DATABASE_URL"] };
    files.push(datastoreFile(datastore("postgres", caseId(entry, "postgres"))));
  }
  if (id === 26) {
    app.secrets = { runtime: ["REDIS_URL"] };
    files.push(datastoreFile(datastore("redis", caseId(entry, "redis"))));
  }
  if (id === 27 || id === 30) {
    app.container.volumes = [
      { name: "uploads", mountPath: "/app/uploads", initialData: "image" },
    ];
    app.rollout = {
      type: "recreate",
      maintenanceMode: true,
      reason: "Single-writer uploaded files",
    };
  }
  if (id === 28) {
    app.domains = { primary: "app.example.com" };
    app.tls = { mode: "direct" };
  }
  if (id === 29) {
    app.domains = {
      primary: "app.example.com",
      redirects: [{ host: "www.example.com", status: 301 }],
    };
    app.tls = { mode: "direct" };
  }
  if (id === 31) app.secrets = { runtime: ["API_TOKEN"] };
  if (id === 33) {
    app.externalSecrets = {
      integration: "infisical",
      project: "11111111-1111-4111-8111-111111111111",
      environmentSlug: "prod",
      secretPath: "application",
    };
    app.secrets = { runtime: ["API_TOKEN"] };
  }
  if (id === 34) {
    app.externalSecrets = {
      integration: "doppler",
      project: "example-api",
      config: "prd",
    };
    app.secrets = { runtime: ["API_TOKEN"] };
  }
  if (id === 35)
    app.autoDeploy = {
      inputs: ["package.json", "pnpm-lock.yaml", "apps/api/**"],
    };
  if (id === 36) {
    app.domains = { primary: "app.example.com" };
    app.tls = { mode: "direct" };
    app.preview = {
      enabled: true,
      domain: "preview.example.com",
      ttlHours: 72,
    };
    files.push(rootFile(true));
  }
  if (id === 37)
    app.jobs = [
      {
        name: "daily-report",
        command: ["node", "scripts/report.js"],
        schedule: { cron: "0 2 * * *", timezone: "UTC" },
        timeoutSeconds: 300,
        enabled: true,
      },
    ];
  if (id === 38)
    app.hooks = {
      preDeploy: {
        command: ["node", "scripts/migrate.js"],
        timeoutSeconds: 300,
      },
    };
  if (id === 39)
    app.notifications = {
      email: [
        {
          address: "ops@example.com",
          deployments: false,
          deploymentFailures: true,
          backupsAndRestores: false,
          alertsAndIncidents: true,
        },
      ],
    };
  if (id === 40) app.vulnerabilityScanning = true;
  files.push(serviceFile(app));
  return files;
}

function datastoreEngine(id) {
  if (id <= 44) return "postgres";
  if (id <= 47) return "mysql";
  if (id <= 50) return "mariadb";
  if (id <= 55) return "mongodb";
  if (id <= 60) return "clickhouse";
  if (id <= 64) return "redis";
  if (id <= 67) return "dragonfly";
  if (id <= 70) return "keydb";
  return "postgres";
}

function datastoreFiles(entry) {
  const { id } = entry;
  const engine = datastoreEngine(id);
  const db = datastore(engine, caseId(entry));
  db.name = entry.title;
  const files = [];
  if ([41, 45, 48].includes(id)) {
    db.secrets.runtime =
      engine === "postgres" ? ["POSTGRES_PASSWORD"] : ["MYSQL_ROOT_PASSWORD"];
  }
  if ([43, 50, 54, 63].includes(id))
    db.access = { sshTunnel: { hostPort: 15000 + id } };
  if ([44, 47, 55, 60, 64, 67, 70, 71, 72, 73, 77, 80].includes(id))
    db.backup = backup();
  if (id === 71) db.backup = { integration: "aws" };
  if (id === 58 && !db.secrets.runtime.includes("CLICKHOUSE_DB"))
    db.secrets.runtime.push("CLICKHOUSE_DB");
  if (id === 59) db.container.resources = { cpus: 2, memory: "4g" };
  if (id === 62) {
    for (const name of ["producer", "worker"]) {
      const app = service(caseId(entry, name), `${entry.title} ${name}`);
      app.container.network = "application";
      app.secrets = { runtime: ["QUEUE_URL"] };
      files.push(serviceFile(app));
    }
  }
  if (id === 74) db.backup = backup("s3");
  if (id === 75) db.backup = backup("gcs");
  if (id === 76)
    db.backup = {
      schedule: { cron: "0 3 * * *", timezone: "UTC" },
      retention: { keepLast: 14 },
      s3: { bucket: "example-production-backups", region: "ap-south-1" },
      gcs: { bucket: "example-recovery-backups", region: "asia-south1" },
      restoreFrom: "s3",
    };
  if (id === 78) db.environments.staging = { server: otherServer };
  files.unshift(datastoreFile(db));
  return files;
}

function stackFiles(entry) {
  const { id } = entry;
  if (id === 100) {
    const files = [];
    for (const [scope, target] of [
      ["orders", server],
      ["billing", otherServer],
    ]) {
      const name = `${scope[0].toUpperCase()}${scope.slice(1)}`;
      const db = datastore("postgres", `${scope}-postgres`);
      db.name = `${name} PostgreSQL`;
      db.environments.production.server = target;
      const app = service(`${scope}-api`, `${name} API`);
      app.environments.production.server = target;
      app.container.network = "application";
      app.secrets = { runtime: ["DATABASE_URL"] };
      files.push(datastoreFile(db), serviceFile(app));
    }
    return files;
  }
  const engine = {
    81: "postgres",
    82: "mysql",
    83: "mariadb",
    84: "mongodb",
    85: "redis",
    86: "dragonfly",
    88: "clickhouse",
    89: "postgres",
    90: "postgres",
    91: "redis",
    92: "postgres",
    93: "redis",
    98: "postgres",
    99: "postgres",
  }[id];
  const files = [];
  if (engine) {
    const db = datastore(engine, caseId(entry, engine));
    db.name = `${entry.title} ${db.name}`;
    files.push(datastoreFile(db));
  }
  if (id === 87) {
    const app = service(caseId(entry, "api"), "Search API");
    app.secrets = { runtime: ["SEARCH_URL", "SEARCH_KEY"] };
    files.push(serviceFile(app));
    return files;
  }
  if ([89, 90].includes(id)) {
    const product = id === 89 ? "metabase" : "umami";
    if (id === 90) return ossFiles(catalog.find((item) => item.id === 1));
    files.length = 0;
    const app = compose(product, entry.title, product, 3000);
    files.push(composeFile(app));
    return files;
  }
  if (id === 95) {
    files.push(
      composeFile(compose("web-worker", "Web and worker", "web", 3000)),
    );
    return files;
  }
  if (id === 94) {
    const frontend = service(
      caseId(entry, "frontend"),
      "Static frontend",
      "static",
    );
    frontend.domains = { primary: "app.example.com" };
    frontend.tls = { mode: "direct" };
    const api = service(caseId(entry, "api"), "API");
    api.domains = { primary: "api.example.com" };
    api.tls = { mode: "direct" };
    files.push(serviceFile(frontend), serviceFile(api));
    return files;
  }
  const app = service(caseId(entry, "api"), entry.title);
  app.container.network = "application";
  if (engine)
    app.secrets = {
      runtime: [
        engine === "redis" || engine === "dragonfly"
          ? "CACHE_URL"
          : "DATABASE_URL",
      ],
    };
  if (id === 92)
    app.jobs = [
      {
        name: "daily-report",
        command: ["node", "scripts/report.js"],
        schedule: { cron: "0 2 * * *", timezone: "UTC" },
        timeoutSeconds: 300,
        enabled: true,
      },
    ];
  if (id === 93) {
    app.domains = { primary: "webhooks.example.com" };
    app.tls = { mode: "direct" };
  }
  if (id === 96) {
    app.domains = { primary: "app.example.com" };
    app.tls = { mode: "direct" };
    app.preview = {
      enabled: true,
      domain: "preview.example.com",
      ttlHours: 72,
    };
    files.push(rootFile(true));
  }
  if (id === 97) app.environments.staging = { server: otherServer };
  if (id === 98) {
    app.container.volumes = [
      { name: "uploads", mountPath: "/app/uploads", initialData: "image" },
    ];
    app.rollout = {
      type: "recreate",
      maintenanceMode: true,
      reason: "Single-writer uploads",
    };
  }
  files.push(serviceFile(app));
  if ([86, 91, 93, 99].includes(id)) {
    const worker = service(caseId(entry, "worker"), "Worker");
    worker.container.network = "application";
    worker.secrets = {
      runtime: [engine === "postgres" ? "DATABASE_URL" : "QUEUE_URL"],
    };
    files.push(serviceFile(worker));
  }
  return files;
}

function filesFor(entry) {
  if (entry.category.startsWith("oss/")) return ossFiles(entry);
  if (entry.category.startsWith("services/")) return serviceFiles(entry);
  if (entry.category.startsWith("datastores/")) return datastoreFiles(entry);
  return stackFiles(entry);
}

function yamlBlock([file, manifest], label = file) {
  const pathComment = label === file ? "" : `# ${file}\n`;
  return `\`\`\`yaml title="${label}"\n${pathComment}${stringify(manifest).trimEnd()}\n\`\`\``;
}

function manifestBlocks(entry, files) {
  const prefix = entry.slug.replace(/^\d+-/, "");
  const blocks = files
    .map(([file, manifest]) => {
      if (files.length <= 2) return yamlBlock([file, manifest]);
      let label = manifest.id;
      if (manifest.id.startsWith(`${prefix}-`))
        label = manifest.id.slice(prefix.length + 1);
      else if (manifest.id === prefix)
        label = file.includes("/datastores/") ? "datastore" : "service";
      return yamlBlock([file, manifest], label);
    })
    .join("\n\n");
  if (files.length === 1) return blocks;
  return `<CodeGroup>\n\n${blocks}\n\n</CodeGroup>`;
}

function configure(entry, files) {
  const composeRecipe = ossComposeRecipes[entry.id];
  if (composeRecipe) {
    const steps = [
      `Prepare the example server, connect the repository, and map \`production\` to the branch containing these files. Replace the example server IP${composeRecipe.private ? "" : " and domain"}.`,
      `Commit the Towbar manifest under \`.towbar/services/\` and the Compose files under \`deploy/${caseId(entry)}/\`, using the paths shown above.`,
      "Sync the repository and inspect the resolved Compose project. Save the runtime values below if this example declares any.",
      ...(composeRecipe.steps ?? []),
      "Deploy it manually and run the verification below before enabling auto-deploy.",
    ];
    return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  }
  const recipe = ossRecipes[entry.id];
  if (recipe) {
    const steps = [
      `Prepare the example server, connect the repository, and map \`production\` to the branch containing these manifests. Replace the example server IP${recipe.public === false ? "" : " and domain"}. Commit the manifests, then sync the repository and inspect the resolved configuration.`,
    ];
    if (recipe.datastores?.length)
      steps.push(
        `Save the initialization values in the table below for ${recipe.datastores.map((engine) => `the ${engine} Datastore`).join(" and ")} under **Datastore → Settings → Secrets**. Deploy ${recipe.datastores.length === 1 ? "it" : "them"} first and wait for readiness. These values create the database and user only on an empty volume.`,
      );
    if (Object.keys(recipe.values ?? {}).length)
      steps.push(
        "Set the Service's declared runtime values under **Service → Settings → Secrets** using the table below. Replace descriptions and placeholders with actual values; do not commit passwords or keys.",
      );
    if (recipe.volumes?.length)
      steps.push(
        "Keep the Service's named volumes attached across deployments. Towbar's Datastore backup policy does not back up Service volumes, so include them in your own recovery plan.",
      );
    if (recipe.public === false)
      steps.push(
        "This manifest has no public domain. Use a trusted connection to the server for the first check. Add a public route only after configuring the product's authentication or an access gateway.",
      );
    steps.push(
      "Deploy the Service, then perform the checks below before enabling auto-deploy.",
    );
    steps.push(...(recipe.steps ?? []));
    return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  }
  const steps = [
    "Register and prepare the example server or servers, connect the repository, and map `production` to the branch containing these files.",
  ];
  if (files.some(([, manifest]) => manifest.environments?.staging))
    steps.push(
      "Map `staging` to its repository branch, register its target server, and save staging credentials separately from production.",
    );
  if (entry.setup) steps.push(...entry.setup);
  for (const [, manifest] of files.filter(([file]) =>
    file.endsWith(".compose.yml"),
  ))
    steps.push(
      `Commit a Compose file at \`${manifest.file}\` with the declared service name and port. Adapt it to [Towbar's Compose restrictions](/docs/services/modes/compose) before syncing.`,
    );
  if (files.some(([file]) => file.endsWith(".datastore.yml")))
    steps.push(
      "Save each Datastore credential value under **Datastore → Settings → Secrets**, deploy it first, and verify engine readiness before starting a dependent Service.",
    );
  if (files.some(([, manifest]) => manifest.backup))
    steps.push(
      "Enable the selected backup integration and configure its runtime storage credentials and destination before creating a recovery point. A manifest policy alone does not provide storage access.",
    );
  if (
    files.some(([, manifest]) => manifest.preview) ||
    files.some(([file]) => file === "towbar.yml")
  )
    steps.push(
      "Configure preview DNS and isolated preview secrets, then verify a pull request creates a separate preview workload.",
    );
  if (
    files.some(
      ([file, manifest]) =>
        file.endsWith(".service.yml") &&
        (manifest.secrets || manifest.externalSecrets),
    )
  )
    steps.push(
      "Save the Service's declared keys in its selected environment, or enable and authorize the selected [external-secret provider](/docs/secrets/external). Do not commit the values.",
    );
  const databases = files.filter(([file]) => file.endsWith(".datastore.yml"));
  const services = files.filter(([file]) => file.endsWith(".service.yml"));
  if (
    databases.length === 1 &&
    services.length > 0 &&
    ![1, 90].includes(entry.id)
  )
    steps.push(
      `Point each Service connection secret at \`${databases[0][1].container.networkAlias}\` on the database engine's private port. The server and network must match; credentials are saved separately for each Service.`,
    );
  if (entry.id === 100)
    steps.push(
      "Set `orders-api`'s `DATABASE_URL` to the `orders-postgres` alias and `billing-api`'s URL to `billing-postgres`. Save each value on its own Service; the two Docker networks are local to their servers.",
    );
  if (entry.id === 90)
    steps.push(
      "Set the Service's `DATABASE_URL` to `postgresql://<user>:<password>@umami-postgres:5432/<database>`, using the user, name, and password you configured on the Datastore. A Docker network does not copy those values. Change Umami's default administrator password after first login.",
    );
  if (entry.id === 89)
    steps.push(
      "Use the upstream PostgreSQL Compose configuration in the same project and set Metabase's application-database variables there. The Towbar Compose manifest does not create or connect a separate managed Datastore.",
    );
  if (entry.id === 39)
    steps.push(
      "Configure SMTP and test delivery to `ops@example.com`. This manifest subscribes that address to this workload; the provider credentials belong in Towbar configuration.",
    );
  if ([45, 53, 81, 82, 83, 84, 88, 99].includes(entry.id))
    steps.push(
      "Create an application-specific user with only the required privileges after the database is ready. Save its connection URL on the consuming Service instead of reusing the Datastore's administrator credentials.",
    );
  steps.push(
    "Sync the repository, inspect the resolved configuration, deploy manually, and perform the verification below before enabling automation.",
  );
  return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

function datastoreValues(entry, recipe) {
  if (!recipe?.datastores?.length) return "";
  const name = caseId(entry).replaceAll("-", "_");
  const rows = recipe.datastores.flatMap((engine) => {
    const label = `${entry.title} ${engine}`;
    if (engine === "postgres")
      return [
        [label, "POSTGRES_DB", name],
        [label, "POSTGRES_USER", name],
        [
          label,
          "POSTGRES_PASSWORD",
          "Run `openssl rand -hex 32`; save its output and reuse it in the Service connection value.",
        ],
      ];
    if (engine === "mysql" || engine === "mariadb")
      return [
        [label, "MYSQL_DATABASE", name],
        [label, "MYSQL_USER", name],
        [
          label,
          "MYSQL_PASSWORD",
          "Run `openssl rand -hex 32`; save its output and reuse it in the Service connection value.",
        ],
        [
          label,
          "MYSQL_ROOT_PASSWORD",
          "Run `openssl rand -hex 32` again for a separate root password.",
        ],
      ];
    if (engine === "redis")
      return [
        [
          label,
          "REDIS_PASSWORD",
          "Run `openssl rand -hex 32`; save its output and use it in the Service broker URL.",
        ],
      ];
    throw new Error(`Missing Datastore secret guidance for ${engine}`);
  });
  return `\n## Datastore values\n\nSave these in each Datastore's **Settings → Secrets** before deploying it. Use the suggested names or choose your own, then use the same names and passwords in the Service connection values below.\n\n| Datastore | Key | Suggested value |\n| --- | --- | --- |\n${rows.map(([label, key, value]) => `| ${label} | \`${key}\` | ${value} |`).join("\n")}\n`;
}

function renderCase(entry) {
  const files = filesFor(entry);
  const ossRecipe = ossRecipes[entry.id];
  const ossComposeRecipe = ossComposeRecipes[entry.id];
  const logo = logoFor(entry);
  const logoHeader = logo ? `icon: ${JSON.stringify(logo)}\n` : "";
  const logoElement = logo
    ? `<img className="towbar-doc-brand-logo" src="${logo}" alt="${entry.title} logo" aria-hidden="true" />\n\n`
    : "";
  const source = entry.upstream
    ? `\n**Upstream source:** [Current installation guide](${entry.upstream}).\n`
    : "";
  const related = [...entry.approach.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .filter(([, , href]) => href !== entry.upstream)
    .map(([, label, href]) => `[${label}](${href})`);
  const relatedNote = related.length
    ? `\n**Related reading:** ${related.join(", ")}.\n`
    : "";
  const composeNote =
    !ossRecipe &&
    !ossComposeRecipe &&
    files.some(([file]) => file.endsWith(".compose.yml"))
      ? "\nThe Compose file itself must be committed at the path in the manifest. This page shows Towbar's declaration, not an invented upstream Compose specification. Match the actual service name and internal port when adapting the upstream file.\n"
      : "";
  const stackNote =
    entry.category.startsWith("stacks/") && files.length > 1
      ? "\nThese are separate files in one repository. A shared Docker network works only when the workloads run on the same server; Towbar does not automatically order their deployments or copy secret values between them.\n"
      : "";
  const deployment = files.find(([file]) => file.endsWith(".service.yml"))?.[1]
    .deployment;
  const modeNote = entry.category.startsWith("services/")
    ? deployment?.type === "image"
      ? "\nUse the image's actual listening port and health endpoint. Towbar does not build this image from the repository.\n"
      : deployment?.type === "static"
        ? "\n`context: .` means the repository root. The build command must produce the declared output directory; adapt it to the actual project.\n"
        : "\n`context: .` means the repository root. The source project, start command, and health endpoint must match the selected build mode.\n"
    : "";
  const guideLinks = [];
  if (files.some(([file]) => file.endsWith(".service.yml")))
    guideLinks.push("[Service manifest](/docs/services/manifest)");
  if (files.some(([file]) => file.endsWith(".datastore.yml")))
    guideLinks.push("[Datastore manifest](/docs/datastores/manifest)");
  if (files.some(([file]) => file.endsWith(".compose.yml")))
    guideLinks.push("[Compose guide](/docs/services/modes/compose)");
  const values = ossRecipe?.values ?? ossComposeRecipe?.values;
  const runtimeValues = values
    ? `\n## Runtime values\n\nSave these values on the ${ossComposeRecipe ? "Compose project" : "Service"} after the repository sync. The manifest declares required keys, not their values.\n\n| Key | Value to save |\n| --- | --- |\n${Object.entries(
        values,
      )
        .map(([key, value]) => `| \`${key}\` | ${value} |`)
        .join("\n")}\n`
    : "";
  const databaseValues = datastoreValues(entry, ossRecipe);
  const introduction =
    ossRecipe || ossComposeRecipe
      ? `\n${(ossRecipe ?? ossComposeRecipe).why}\n`
      : "";
  const verification =
    ossRecipe?.check ?? ossComposeRecipe?.check ?? entry.verify;
  const composeFiles = ossComposeRecipe
    ? `\n## Compose project\n\n${ossComposeRecipe.files.length > 1 ? "<CodeGroup>\n\n" : ""}${ossComposeRecipe.files.map((file) => yamlBlock(file)).join("\n\n")}${ossComposeRecipe.files.length > 1 ? "\n\n</CodeGroup>" : ""}\n`
    : "";
  if (entry.category.startsWith("oss/"))
    assert.ok(entry.description, `Missing OSS description: ${entry.slug}`);
  const description = (
    entry.description ??
    ossRecipe?.why ??
    ossComposeRecipe?.why ??
    entry.approach
  )
    .replace(/\s*\[[^\]]+\]\([^)]+\)/g, "")
    .replaceAll("`", "")
    .trim();
  return `---\ntitle: ${JSON.stringify(entry.title)}\ndescription: ${JSON.stringify(
    description,
  )}\n${logoHeader}---\n\nimport { UseCaseNavigation } from '/snippets/use-case-navigation.jsx';\n\n<UseCaseNavigation />\n\n${logoElement}${source}${relatedNote}${introduction}${composeNote}${stackNote}${modeNote}\n## Towbar manifest${files.length > 1 ? "s" : ""}\n\n${manifestBlocks(entry, files)}\n${composeFiles}\n## Configure\n\n${configure(entry, files)}\n${databaseValues}${runtimeValues}\n## Verify\n\n${verification}\n\nFor field constraints, see ${guideLinks.join(" and ")}.\n`;
}

const expected = new Map();
async function addPage(file, content) {
  expected.set(
    file,
    await format(content, { ...(await resolveConfig(file)), filepath: file }),
  );
}
for (const entry of catalog)
  await addPage(
    path.join(docs, entry.category, `${entry.slug}.mdx`),
    renderCase(entry),
  );

for (const [file, content] of expected) {
  if (check) {
    const actual = await readFile(file, "utf8").catch(() => null);
    assert.equal(
      actual,
      content,
      `Use-case page is stale: ${path.relative(root, file)}`,
    );
  } else {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
for (const category of categories) {
  const directory = path.join(docs, category);
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".mdx")) continue;
    const file = path.join(directory, name);
    if (!expected.has(file))
      throw new Error(`Unexpected use-case page: ${path.relative(root, file)}`);
  }
}
console.log(
  `${check ? "Checked" : "Generated"} ${catalog.length} use-case pages.`,
);
