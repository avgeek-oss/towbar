import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const postgresImage =
  "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const temporalImage =
  "temporalio/temporal:1.7.2@sha256:a715f1978c4d7d9b36fe6ef6e8aa414428f018a35f8e0f2b0c40c3cff9a9e634";
const clickhouseImage =
  "clickhouse/clickhouse-server:25.12.5@sha256:cacf32d6884291dc2ff5e0156a97f46fc53ff7c929a7906d114e268a929dfd3a";
const databases = {
  TOWBAR_OAUTH_TEST_DATABASE_URL: "oauth",
  TOWBAR_TEST_DATABASE_URL: "regression",
  TOWBAR_TEAM_TEST_DATABASE_URL: "team",
  TOWBAR_SETTINGS_TEST_DATABASE_URL: "settings",
  TOWBAR_RECOVERY_TEST_DATABASE_URL: "recovery",
  TOWBAR_TERMINAL_TEST_DATABASE_URL: "terminal",
  TOWBAR_HISTORY_TEST_DATABASE_URL: "history",
};

export function disposableInfrastructure(run) {
  const containers = [];
  const label = `towbar.verification.run=${run.id}`;
  async function start(kind, image, port, options, command = [], extra = {}) {
    const name = `towbar-verify-${kind}-${run.id}`;
    containers.push(name);
    await run.step(
      `start-${kind}`,
      "docker",
      [
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        label,
        "--publish",
        `127.0.0.1::${port}`,
        ...options,
        image,
        ...command,
      ],
      { extra },
    );
    return name;
  }
  async function wait(name, command) {
    const deadline = Date.now() + 90_000;
    let last;
    while (Date.now() < deadline) {
      try {
        await run.capture("docker", ["exec", name, ...command]);
        return;
      } catch (error) {
        last = error;
      }
      await delay(500);
    }
    throw new Error(`${name} did not become ready`, { cause: last });
  }
  async function hostPort(name, port) {
    const output = await run.capture("docker", ["port", name, String(port)]);
    if (!/^127\.0\.0\.1:\d+$/.test(output))
      throw new Error(`Unexpected ${name} port binding`);
    return output.split(":").at(-1);
  }
  return {
    async provision({ logs = false } = {}) {
      const password = randomBytes(24).toString("hex");
      const postgres = await start(
        "postgres",
        postgresImage,
        5432,
        ["--tmpfs", "/var/lib/postgresql/data", "--env", "POSTGRES_PASSWORD"],
        [],
        { POSTGRES_PASSWORD: password },
      );
      // The initialization server accepts Unix sockets before the final server boots.
      await wait(postgres, ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      const port = await hostPort(postgres, 5432);
      for (const [key, suffix] of Object.entries(databases)) {
        const database = `towbar_${suffix}_test`;
        await run.capture("docker", [
          "exec",
          postgres,
          "createdb",
          "-U",
          "postgres",
          database,
        ]);
        run.env[key] =
          `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
        await run.step(
          `migrate-${suffix}`,
          "pnpm",
          ["--filter", "@workspace/towbar-database", "db:migrate"],
          {
            extra: {
              DATABASE_TOWBAR_URL: run.env[key],
              DATABASE_TOWBAR_MIGRATOR_URL: run.env[key],
            },
          },
        );
      }
      if (logs) {
        const clickhouse = await start("clickhouse", clickhouseImage, 8123, [
          "--memory",
          "1536m",
          "--cpus",
          "2",
          "--env",
          "CLICKHOUSE_DB=towbar_logs_test",
          "--env",
          "CLICKHOUSE_USER=logs_test",
          "--env",
          "CLICKHOUSE_PASSWORD=logs_test",
          "--env",
          "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
        ]);
        await wait(clickhouse, [
          "clickhouse-client",
          "--user",
          "logs_test",
          "--password",
          "logs_test",
          "--query",
          "SELECT 1",
        ]);
        run.env.TOWBAR_TEST_CLICKHOUSE_URL = `http://127.0.0.1:${await hostPort(clickhouse, 8123)}`;
        run.env.TOWBAR_TEST_LOG_COLLECTOR = "true";
      }
      const temporal = await start(
        "temporal",
        temporalImage,
        7233,
        [],
        ["server", "start-dev", "--ip", "0.0.0.0", "--headless"],
      );
      await wait(temporal, [
        "temporal",
        "operator",
        "cluster",
        "health",
        "--address",
        "127.0.0.1:7233",
      ]);
      run.env.TOWBAR_TEST_TEMPORAL_ADDRESS = `127.0.0.1:${await hostPort(temporal, 7233)}`;
    },
    async close() {
      const failures = [];
      try {
        const owned = await run.capture("docker", [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=${label}`,
        ]);
        containers.push(...owned.split(/\s+/).filter(Boolean));
      } catch (error) {
        failures.push(error);
      }
      for (const name of new Set(containers.reverse())) {
        let labels;
        try {
          labels = JSON.parse(
            await run.capture("docker", [
              "inspect",
              "--format",
              "{{json .Config.Labels}}",
              name,
            ]),
          );
        } catch (error) {
          if (/No such (?:object|container)/i.test(error.stderr ?? ""))
            continue;
          failures.push(error);
          continue;
        }
        if (labels?.["towbar.verification.run"] !== run.id) {
          failures.push(
            new Error(`Refusing to remove unowned container ${name}`),
          );
          continue;
        }
        try {
          await run.capture("docker", ["rm", "--force", "--volumes", name]);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Verification infrastructure cleanup failed",
        );
    },
  };
}
