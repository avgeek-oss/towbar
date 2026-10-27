import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { restoreCandidateScript } from "./resource-restore-scripts.js";

const execute = promisify(execFile);

void test("PostgreSQL restore waits past socket-only initialization and authenticates to the final server", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "towbar-restore-readiness-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = new URL(
    "./test-fixtures/postgres-restore-readiness.py",
    import.meta.url,
  );
  for (const command of [
    "docker",
    "pg_isready",
    "psql",
    "pg_restore",
    "sleep",
  ]) {
    const target = path.join(directory, command);
    await copyFile(fixture, target);
    await chmod(target, 0o755);
  }
  await writeFile(path.join(directory, "phase"), "initializing");
  const runtime = path.join(directory, "runtime");
  await mkdir(runtime);
  const password = "test-only p@ss'with\"quotes";
  for (const [name, value] of Object.entries({
    POSTGRES_USER: "restore_owner",
    POSTGRES_DB: "restore_db",
    POSTGRES_PASSWORD: password,
  }))
    await writeFile(path.join(runtime, name), value);
  const docker = path.join(directory, "docker");
  const python = execFileSync("which", ["python3"], {
    encoding: "utf8",
  }).trim();
  const script = restoreCandidateScript
    .replaceAll("/usr/bin/docker", docker)
    .replaceAll("/usr/bin/python3", python);
  const result = await execute(
    "bash",
    [
      "-c",
      script,
      "restore-test",
      "postgres",
      "candidate",
      "candidate-volume",
      "/var/lib/postgresql/data",
      "/test/database.dump",
      "postgres:test",
      "1",
      "512m",
      runtime,
    ],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        RESTORE_READINESS_TEST_DIRECTORY: directory,
      },
      timeout: 10_000,
    },
  );
  const events = (await readFile(path.join(directory, "events"), "utf8"))
    .trim()
    .split("\n");
  assert.deepEqual(events, [
    "sql-probe:initializing",
    "initialization-finished",
    "sql-probe:ready",
    "restore:ready",
    "sql-probe:ready",
  ]);
  assert.ok(!result.stdout.includes(password));
  assert.ok(!result.stderr.includes(password));
});
