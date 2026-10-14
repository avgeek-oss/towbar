import { verificationRun } from "./runtime.mjs";
import { disposableInfrastructure } from "./infrastructure.mjs";

const groups = ["api", "docker", "app", "resources", "scanner"];
const group = process.argv[2];
if (!groups.includes(group))
  throw new Error(`Choose a required group: ${groups.join(", ")}`);
const run = await verificationRun(group);
const infrastructure = disposableInfrastructure(run);
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
      "--test-concurrency=2",
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
  if (["api", "docker"].includes(group))
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
    await pnpmTest("api", "towbar-api", ["src/**/*.test.ts"]);
    await run.step(
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
    );
    await pnpmTest("temporal", "towbar-worker", [
      "src/workflows/*.integration.test.ts",
    ]);
  }
  if (group === "docker") {
    await pnpmTest(
      "deployer",
      "@workspace/towbar-deployer",
      ["src/**/*.test.ts"],
      { TOWBAR_DOCKER_TESTS: "true" },
    );
    await lifecycle("oci-runtime", "oci-runtime-lifecycle");
  }
  if (group === "app") {
    await lifecycle("app", "app-lifecycle", {
      TOWBAR_TEST_STORAGE: "1",
      TOWBAR_TEST_PR: "1",
      TOWBAR_TEST_HTTPS: "1",
    });
    await lifecycle("compose", "compose-lifecycle");
    await lifecycle("preview-cleanup", "preview-cleanup-lifecycle");
    await lifecycle("server-cleanup", "server-cleanup-lifecycle");
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
