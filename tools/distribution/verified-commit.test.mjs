import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PENDING, verifyState } from "./verified-commit.mjs";

const commit = "a".repeat(40);
const run = (overrides) => ({
  id: 1,
  name: "verify",
  head_sha: commit,
  app: { slug: "github-actions" },
  status: "completed",
  conclusion: "success",
  started_at: "2026-10-28T06:00:00Z",
  ...overrides,
});
const state = (...checks) =>
  verifyState([{ check_runs: checks }], commit).state;

void test("a successful latest verify run passes", () => {
  assert.equal(state(run()), "success");
});

void test("missing or unfinished verify runs are pending", () => {
  assert.equal(state(), "pending");
  assert.equal(
    state(run({ status: "in_progress", conclusion: null })),
    "pending",
  );
  assert.equal(
    state(run(), run({ id: 2, status: "queued", conclusion: null })),
    "pending",
  );
});

void test("a failed latest run fails at once, even after an older success", () => {
  assert.equal(state(run({ conclusion: "failure" })), "failure");
  assert.equal(
    state(
      run(),
      run({
        id: 2,
        conclusion: "cancelled",
        started_at: "2026-10-28T07:00:00Z",
      }),
    ),
    "failure",
  );
  assert.equal(
    state(
      run({ conclusion: "failure" }),
      run({ id: 2, started_at: "2026-10-28T07:00:00Z" }),
    ),
    "success",
  );
});

void test("other commits, other checks and other apps are ignored", () => {
  assert.equal(
    state(
      run({ head_sha: "b".repeat(40), conclusion: "failure" }),
      run({ name: "checks", conclusion: "failure" }),
      run({ app: { slug: "other-app" }, conclusion: "failure" }),
    ),
    "pending",
  );
});

void test("the command line maps states to exit codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verified-commit-"));
  const exit = async (checks) => {
    const file = join(directory, "checks.json");
    await writeFile(file, JSON.stringify([{ check_runs: checks }]));
    try {
      await promisify(execFile)(process.execPath, [
        new URL("./verified-commit.mjs", import.meta.url).pathname,
        "--commit",
        commit,
        "--checks",
        file,
      ]);
      return 0;
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(await exit([run()]), 0);
  assert.equal(await exit([]), PENDING);
  assert.equal(await exit([run({ conclusion: "failure" })]), 1);
});
