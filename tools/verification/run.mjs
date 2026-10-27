import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { concurrently, verificationRun } from "./runtime.mjs";
import { disposableInfrastructure } from "./infrastructure.mjs";

const groups = ["api", "docker", "app", "resources", "scanner"];
const group = process.argv[2];
if (!groups.includes(group))
  throw new Error(`Choose a required group: ${groups.join(", ")}`);
const repository = fileURLToPath(new URL("../../", import.meta.url));
// Test files run in parallel per group, one per runner vCPU.
const testConcurrency = 4;
const run = await verificationRun(group);
const infrastructure = disposableInfrastructure(run);

// The verify job's `pnpm test` already runs every unit test file; files that
// need this group's infrastructure skip there. A group therefore runs only
// the files that need it: those named *.integration.test.ts or
// *.docker.test.ts, and any other file that reads an infrastructure variable.
// Files declaring the longest timeouts start first so that slow files do not
// run alone at the end.
function infrastructureTests(directory, marker) {
  const timeout = (source) =>
    Math.max(
      0,
      ...[...source.matchAll(/timeout:\s*([\d_]+)/g)].map((match) =>
        Number(match[1].replaceAll("_", "")),
      ),
    );
  const files = globSync("src/**/*.test.ts", {
    cwd: path.join(repository, directory),
  })
    .map((file) => ({
      file,
      source: readFileSync(path.join(repository, directory, file), "utf8"),
    }))
    .filter(
      ({ file, source }) =>
        /\.(?:integration|docker)\.test\.ts$/.test(file) || marker.test(source),
    )
    .map(({ file, source }) => ({ file, timeout: timeout(source) }))
    .sort((a, b) => b.timeout - a.timeout || a.file.localeCompare(b.file))
    .map(({ file }) => file);
  if (!files.length)
    throw new Error(`No infrastructure tests found in ${directory}`);
  console.log(
    `[${group}] ${directory}: ${files.length} infrastructure test files`,
  );
  return files;
}
const apiInfrastructure =
  /TOWBAR_[A-Z_]*TEST_(?:DATABASE_URL|TEMPORAL_ADDRESS|CLICKHOUSE_URL|LOG_COLLECTOR)/;
const dockerInfrastructure = /TOWBAR_DOCKER_TESTS/;

const pnpmTest = (name, pkg, files, extra = {}) =>
  run.step(
    name,
    "pnpm",
    [
      "--filter",
      pkg,
      "exec",
      "tsx",
      "--test",
      "--test-reporter=tap",
      `--test-concurrency=${testConcurrency}`,
      ...files,
    ],
    { extra, requiredTests: true },
  );
const lifecycle = (name, file, extra = {}) =>
  run.step(name, "node", [`tools/e2e/${file}.mjs`], { extra });
try {
  await run.step("docker-required", "docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  await run.step("build", "pnpm", [
    "exec",
    "turbo",
    "build",
    "--filter=towbar-api",
    "--filter=towbar-worker",
  ]);
  // Lifecycle scripts build this target image themselves; building it once
  // here keeps concurrent scripts from building it side by side.
  if (["api", "docker", "app"].includes(group))
    await run.step("build-e2e-target", "docker", [
      "build",
      "--tag",
      "towbar-v2-e2e-target:local",
      "--file",
      "tools/e2e/target.Dockerfile",
      ".",
    ]);
  if (["api", "app", "resources"].includes(group))
    await infrastructure.provision({ logs: group === "api" });
  if (group === "api") {
    // Independent: the database suite creates and drops its own randomly
    // named databases, the Temporal suite uses random task queues, and the
    // log collector lifecycle uses only its own SSH target.
    await concurrently(
      pnpmTest(
        "api",
        "towbar-api",
        infrastructureTests("apps/towbar-api", apiInfrastructure),
      ),
      lifecycle("logs", "log-collector-lifecycle"),
      run.step(
        "database",
        "pnpm",
        [
          "--filter",
          "@workspace/towbar-database",
          "exec",
          "node",
          "--test",
          "--test-reporter=tap",
          "test/*.test.mjs",
        ],
        { requiredTests: true },
      ),
      pnpmTest("temporal", "towbar-worker", [
        "src/workflows/*.integration.test.ts",
      ]),
    );
  }
  if (group === "docker") {
    // Independent: the Docker tests use randomly named host containers,
    // volumes and images, and the OCI lifecycle runs inside its own target.
    await concurrently(
      pnpmTest(
        "deployer",
        "@workspace/towbar-deployer",
        infrastructureTests("packages/towbar-deployer", dockerInfrastructure),
        { TOWBAR_DOCKER_TESTS: "true" },
      ),
      lifecycle("oci-runtime", "oci-runtime-lifecycle"),
    );
  }
  if (group === "app") {
    // Independent: each script uses its own SSH target with a private Docker
    // daemon, random host ports and its own temporary directory; only the app
    // lifecycle binds host port 443 or uses the database and Temporal.
    await concurrently(
      lifecycle("app", "app-lifecycle", {
        TOWBAR_TEST_STORAGE: "1",
        TOWBAR_TEST_PR: "1",
        TOWBAR_TEST_HTTPS: "1",
      }),
      lifecycle("compose", "compose-lifecycle"),
      lifecycle("preview-cleanup", "preview-cleanup-lifecycle"),
      lifecycle("server-cleanup", "server-cleanup-lifecycle"),
    );
  }
  if (group === "resources") {
    await lifecycle("resource", "resource-lifecycle");
    // This harness exercises storage directly and explicitly rejects API/Temporal mode.
    delete run.env.TOWBAR_TEST_DATABASE_URL;
    delete run.env.TOWBAR_TEST_TEMPORAL_ADDRESS;
    await lifecycle("redis-backup", "resource-lifecycle", {
      TOWBAR_TEST_BACKUP: "1",
    });
  }
  if (group === "scanner") await lifecycle("scanner", "trivy-lifecycle");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await infrastructure.close();
  } finally {
    run.finish();
  }
}
