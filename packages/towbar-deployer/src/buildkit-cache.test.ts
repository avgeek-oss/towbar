import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import {
  buildkitCachePython,
  installBuildkitCacheTimerScript,
  maintainBuildkitCacheScript,
} from "./buildkit-cache.js";
import {
  buildRemoteScript,
  builderBuildRemoteScript,
  staticBuildRemoteScript,
} from "./remote-scripts.js";

const execute = promisify(execFile);
async function harness(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "towbar-buildkit-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "docker"),
    `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['CACHE_TEST_DIRECTORY'])
with (root / 'calls.jsonl').open('a') as log: log.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'info': print(root)
elif sys.argv[1:3] == ['buildx', 'prune']:
    if os.environ.get('CACHE_TEST_FAIL'): sys.exit(1)
    print('Total: 2.5GB')
else: sys.exit(9)
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    CACHE_TEST_DIRECTORY: directory,
  };
  return {
    directory,
    env,
    async calls() {
      return (await readFile(path.join(directory, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

for (const [size, budget, headroom] of [
  [50, 5, 10],
  [20, 2, 4],
  [200, 5, 10],
]) {
  void test(`bounds BuildKit cache and headroom on a ${size} GiB filesystem`, async (t) => {
    const h = await harness(t);
    const result = await execute(
      "python3",
      [
        "-c",
        `
import json, shutil, subprocess, types
shutil.disk_usage = lambda root: types.SimpleNamespace(total=${size! * 1024 ** 3})
${buildkitCachePython}
print(json.dumps(prune_buildkit_cache()))
`,
      ],
      { env: h.env },
    );
    const outcome = JSON.parse(result.stdout) as {
      status: string;
      message: string;
    };
    assert.equal(outcome.status, "succeeded");
    assert.match(outcome.message, /2.5GB/);
    assert.deepEqual((await h.calls())[1], [
      "buildx",
      "prune",
      "--builder",
      "default",
      "--all",
      "--force",
      "--filter",
      "inuse=false",
      "--max-used-space",
      String(budget! * 1024 ** 3),
      "--min-free-space",
      String(headroom! * 1024 ** 3),
      "--reserved-space",
      "0",
    ]);
  });
}
void test("cache-maintenance failures do not hide a failed build's exit status", async (t) => {
  const h = await harness(t);
  await assert.rejects(
    execute(
      "bash",
      ["-c", `set -euo pipefail\n${maintainBuildkitCacheScript}\nexit 19`],
      { env: { ...h.env, CACHE_TEST_FAIL: "1" } },
    ),
    (error: unknown) => {
      const result = error as { code: number; stderr: string };
      assert.equal(result.code, 19);
      assert.match(result.stderr, /retry from server Docker cleanup/);
      return true;
    },
  );
  assert.equal(
    (await h.calls()).filter((call) => call[0] === "buildx").length,
    2,
  );
});
void test("all build paths install before/after maintenance without replacing buildpack cleanup", () => {
  for (const script of [
    buildRemoteScript,
    staticBuildRemoteScript,
    builderBuildRemoteScript,
  ]) {
    assert(script.includes(maintainBuildkitCacheScript));
    assert(
      script.indexOf(maintainBuildkitCacheScript) <
        script.indexOf('rm -rf "$remote_dir/context"'),
    );
  }
  assert.match(
    builderBuildRemoteScript,
    /trap 'cleanup_builder_cache; maintain_buildkit_cache' EXIT/,
  );
  assert.match(installBuildkitCacheTimerScript, /OnCalendar=hourly/);
  assert.doesNotMatch(
    installBuildkitCacheTimerScript,
    /restart docker|daemon\.json/,
  );
});
