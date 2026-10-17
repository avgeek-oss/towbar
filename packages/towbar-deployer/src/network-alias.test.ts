import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  access,
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
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import {
  startRemoteScript,
  startResourceRemoteScript,
} from "./remote-scripts.js";

const execute = promisify(execFile);
async function harness(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "towbar-alias-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = path.join(directory, "state");
  await mkdir(state);
  const docker = path.join(directory, "docker");
  await copyFile(
    new URL("./test-fixtures/network-alias-docker.py", import.meta.url),
    docker,
  );
  await chmod(docker, 0o755);
  const python = execFileSync("which", ["python3"], {
    encoding: "utf8",
  }).trim();
  for (const [kind, script] of [
    ["app", startRemoteScript],
    ["resource", startResourceRemoteScript],
  ]) {
    await writeFile(
      path.join(directory, `${kind}.sh`),
      script!
        .replaceAll("/var/lib/towbar/locks", path.join(directory, "locks"))
        .replaceAll("sudo install", "install")
        .replaceAll("/usr/bin/python3", python)
        .replaceAll("/usr/bin/docker", docker),
    );
  }
  return {
    state,
    async start(
      name: string,
      options: {
        kind?: "app" | "resource";
        previous?: string;
        owner?: string;
        source?: string;
        previousSourceIds?: string[];
        pause?: boolean;
        fail?: boolean;
      } = {},
    ) {
      const remote = path.join(directory, name);
      await mkdir(path.join(remote, "secrets/runtime"), { recursive: true });
      const owner = options.owner ?? name;
      const kind = options.kind ?? "app";
      const args =
        kind === "app"
          ? [
              remote,
              name,
              "test-image",
              "8080",
              "test-network",
              "",
              "",
              "api",
              options.previous ?? "",
            ]
          : [
              remote,
              name,
              "test-image",
              "8080",
              "test-network",
              "api",
              "",
              "",
              "",
              options.previous ?? "",
              owner,
              "0",
            ];
      return execute("bash", [path.join(directory, `${kind}.sh`), ...args], {
        env: {
          ...process.env,

          PATH: `${directory}:${process.env.PATH}`,
          ALIAS_TEST_STATE: state,
          ALIAS_TEST_PAUSE: options.pause ? "1" : "",
          ALIAS_TEST_FAIL: options.fail ? "1" : "",
          TOWBAR_APP_ID: owner,
          TOWBAR_CLEANUP_ID: owner,
          TOWBAR_DEPLOYABLE_ID: owner,
          TOWBAR_SOURCE_ID: options.source ?? "source",
          TOWBAR_PREVIOUS_SOURCE_IDS_JSON: JSON.stringify(
            options.previousSourceIds ?? [],
          ),
          TOWBAR_DEPLOYMENT_ID: name,
          TOWBAR_COMMIT_SHA: "test",
        },
        timeout: 15_000,
      });
    },
  };
}
async function waitFor(file: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

for (const kind of ["app", "resource"] as const) {
  void test(`serializes an App alias claim against a concurrent ${kind}`, async (t) => {
    const h = await harness(t);
    const first = h.start("first", { pause: true });
    await waitFor(path.join(h.state, "first.starting"));
    const second = h.start("second", { kind, source: "other-source" });
    const rejected = assert.rejects(second, /already used/);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await writeFile(path.join(h.state, "continue"), "");
    await first;
    await rejected;
    await assert.rejects(access(path.join(h.state, "second.json")));
  });
}

void test("reclaims deferred cleanup without removing the current release or volumes", async (t) => {
  const h = await harness(t);
  await h.start("a", { owner: "app" });
  await h.start("b", { owner: "app", previous: "a" });
  await h.start("c", { owner: "app", previous: "b" });
  await assert.rejects(access(path.join(h.state, "a.json")));
  const previous = JSON.parse(
    await readFile(path.join(h.state, "b.json"), "utf8"),
  ) as { State: { Running: boolean } };
  assert.equal(previous.State.Running, false);
  await access(path.join(h.state, "c.json"));
});

void test("preserves stopped alias owners from other sources and deployables", async (t) => {
  const h = await harness(t);
  await h.start("a", { owner: "app" });
  const file = path.join(h.state, "a.json");
  const data = JSON.parse(await readFile(file, "utf8")) as {
    State: { Running: boolean; Status: string };
  };
  data.State = { Running: false, Status: "exited" };
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(
    h.start("b", { owner: "app", source: "another-source" }),
    /already used/,
  );
  await assert.rejects(h.start("c", { owner: "another-app" }), /already used/);
  await access(file);
});

void test("reclaims a stopped alias after a verified repository transfer", async (t) => {
  const h = await harness(t);
  await h.start("a", { owner: "app", source: "old-source" });
  await h.start("b", { owner: "app", source: "old-source", previous: "a" });
  await h.start("c", {
    owner: "app",
    source: "destination",
    previous: "b",
    previousSourceIds: ["old-source"],
  });
  await assert.rejects(access(path.join(h.state, "a.json")));
  await access(path.join(h.state, "b.json"));
  await access(path.join(h.state, "c.json"));
});

void test("releases the alias lock when Docker startup fails", async (t) => {
  const h = await harness(t);
  await assert.rejects(
    h.start("failed", { fail: true }),
    /Simulated Docker startup failure/,
  );
  await h.start("next", { kind: "resource" });
});
