import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { verificationRun } from "./runtime.mjs";
import { disposableInfrastructure } from "./infrastructure.mjs";
import { verifyProductionImages } from "./production-images.mjs";

async function availablePorts(count) {
  const listeners = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      listeners.push(server);
    }
    return listeners.map((server) => server.address().port);
  } finally {
    await Promise.all(
      listeners.map((server) => promisify(server.close.bind(server))()),
    );
  }
}

const run = await verificationRun("production");
const infrastructure = disposableInfrastructure(run);
const project = `towbar-verify-${run.id}`;
const compose = [
  "compose",
  "--env-file",
  "/dev/null",
  "--project-name",
  project,
  "--file",
  "docker-compose.yml",
];
let configured = false;
try {
  await run.step("docker-required", "docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  if (!run.env.NODE_AUTH_TOKEN) {
    try {
      run.env.NODE_AUTH_TOKEN = await run.capture("gh", ["auth", "token"]);
    } catch {
      throw new Error(
        "Production image verification needs NODE_AUTH_TOKEN or an authenticated gh CLI for GitHub Packages",
      );
    }
  }
  if (!run.env.NODE_AUTH_TOKEN)
    throw new Error("GitHub Packages authentication token is empty");
  const [towbarPort, apiPort, temporalPort, temporalApiPort] =
    await availablePorts(4);
  const override = path.join(run.directory, "test-ports.json");
  await writeFile(
    override,
    JSON.stringify({
      services: { temporal: { ports: [`127.0.0.1:${temporalApiPort}:7233`] } },
    }),
    { mode: 0o600 },
  );
  compose.push("--file", override);
  Object.assign(run.env, {
    COMPOSE_PROFILES: "local",
    TOWBAR_IMAGE_TAG: project,
    TOWBAR_NETWORK_NAME: `${project}-platform`,
    TOWBAR_BIND_ADDRESS: "127.0.0.1",
    TOWBAR_PORT: String(towbarPort),
    TOWBAR_API_PORT: String(apiPort),
    TOWBAR_TEMPORAL_UI_PORT: String(temporalPort),
    TOWBAR_APP_BASE_URL: `http://127.0.0.1:${towbarPort}`,
    TOWBAR_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    TOWBAR_POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
    TOWBAR_DATABASE_RUNTIME_PASSWORD: randomBytes(32).toString("hex"),
    TOWBAR_INTERNAL_HMAC_SECRET: randomBytes(32).toString("hex"),
    TOWBAR_CREDENTIALS_KEY: randomBytes(32).toString("base64"),
    TOWBAR_PASSWORD_BREACH_CHECK: "false",
    SOURCE_COMMIT: await run.capture("git", ["rev-parse", "HEAD"]),
  });
  run.env.VERIFY_SETUP_SECRET = createHmac(
    "sha256",
    run.env.TOWBAR_INTERNAL_HMAC_SECRET,
  )
    .update("towbar:installation-setup:v1")
    .digest("base64url");
  configured = true;
  await run.step("compose-config", "docker", [...compose, "config", "--quiet"]);
  await run.step("compose-build", "docker", [...compose, "build"], {
    timeoutMs: 1_800_000,
  });
  await run.step("test-dependencies", "pnpm", [
    "exec",
    "turbo",
    "build",
    "--filter=towbar-api",
  ]);
  await run.step(
    "compose-start",
    "docker",
    [...compose, "up", "--detach", "--wait", "--wait-timeout", "300"],
    { timeoutMs: 360_000 },
  );
  await run.step(
    "onboarding",
    "node",
    ["tools/verification/production-smoke.mjs"],
    {
      extra: {
        VERIFY_API_URL: run.env.TOWBAR_API_BASE_URL,
        VERIFY_APP_URL: run.env.TOWBAR_APP_BASE_URL,
      },
      timeoutMs: 120_000,
    },
  );
  await run.step("api-outage", "docker", [...compose, "stop", "api"]);
  try {
    await run.step(
      "dashboard-during-api-outage",
      "node",
      [
        "--input-type=module",
        "--eval",
        `import assert from "node:assert/strict";
         const app = process.env.VERIFY_APP_URL;
         const [health, page] = await Promise.all([
           fetch(new URL("/health", app), { signal: AbortSignal.timeout(15_000) }),
           fetch(new URL("/setup", app), { signal: AbortSignal.timeout(15_000) }),
         ]);
         assert.equal(health.status, 200);
         assert.equal(page.status, 200);
         assert.match(await page.text(), /Towbar/);
         console.log("Dashboard remains available during API outage");`,
      ],
      { extra: { VERIFY_APP_URL: run.env.TOWBAR_APP_BASE_URL } },
    );
  } finally {
    await run.step(
      "api-recovery",
      "docker",
      [...compose, "up", "--detach", "--wait", "--wait-timeout", "120", "api"],
      { timeoutMs: 150_000 },
    );
  }
  await run.step("compose-state", "docker", [...compose, "ps", "--all"]);
  await run.step(
    "temporal-recovery",
    "node",
    ["tools/verification/production-temporal.mjs"],
    {
      extra: {
        VERIFY_COMPOSE_ARGS: JSON.stringify(compose),
        VERIFY_COMPOSE_PROJECT: project,
        TOWBAR_TEST_TEMPORAL_ADDRESS: `127.0.0.1:${temporalApiPort}`,
      },
      timeoutMs: 420_000,
    },
  );
  await verifyProductionImages(
    run,
    Object.fromEntries(
      ["api", "worker", "web-app"].map((service) => [
        service,
        `towbar/${service}:${project}`,
      ]),
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  if (configured) {
    try {
      let diagnostics = await run.capture("docker", [
        ...compose,
        "logs",
        "--no-color",
        "--tail",
        "120",
        "postgres",
        "temporal-schema",
        "temporal",
        "temporal-namespace",
      ]);
      for (const [name, value] of Object.entries(run.env)) {
        if (/PASSWORD|SECRET|TOKEN|CREDENTIALS_KEY/.test(name) && value)
          diagnostics = diagnostics.replaceAll(value, "[redacted]");
      }
      await writeFile(
        path.join(run.directory, "infrastructure-diagnostics.log"),
        diagnostics,
        { mode: 0o600 },
      );
    } catch (diagnosticError) {
      console.error(
        "Could not collect infrastructure diagnostics:",
        diagnosticError.message,
      );
    }
  }
} finally {
  const cleanupErrors = [];
  const cleanup = [
    () => infrastructure.close(),
    async () => {
      if (configured) {
        // The project and network names are freshly generated, never inherited.
        // Keep diagnostics to state and health output; do not collect application logs.
        await run.capture("docker", [
          ...compose,
          "down",
          "--volumes",
          "--remove-orphans",
          "--timeout",
          "20",
        ]);
        for (const image of ["api", "worker", "web-app"]) {
          const tag = `towbar/${image}:${project}`;
          const exists = await run.capture("docker", [
            "image",
            "ls",
            "--quiet",
            tag,
          ]);
          if (exists) await run.capture("docker", ["image", "rm", tag]);
        }
      }
    },
  ];
  for (const action of cleanup) {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  run.finish();
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      "Production verification cleanup failed",
    );
}
