import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { serverCleanupResultSchema } from "@workspace/towbar-core";
import { cleanupOrphansScript } from "./server-cleanup.js";

const execute = promisify(execFile);

async function harness(t: TestContext, count = 2) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "towbar-route-cleanup-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caddy = path.join(directory, "caddy-config");
  const routes = path.join(caddy, "towbar");
  const data = path.join(directory, "data");
  await mkdir(routes, { recursive: true });
  await writeFile(path.join(caddy, "Caddyfile"), "test configuration");
  await writeFile(path.join(routes, "cloudflare.env"), "TEST_TOKEN=private\n");
  await writeFile(path.join(directory, "docker"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  for (const name of ["caddy", "systemctl"]) {
    await writeFile(
      path.join(directory, name),
      `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
root = Path(os.environ["CLEANUP_TEST_DIRECTORY"])
routes = root / "caddy-config" / "towbar"
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps({"name": name, "args": sys.argv[1:], "routes": sorted(p.name for p in routes.glob("*.caddy"))}) + "\\n")
if name == "systemctl" and sys.argv[1:] != ["reload", "caddy"]: sys.exit(9)
if name == "caddy" and (routes / "cloudflare.env").exists():
    if sys.argv[-2:] != ["--envfile", str(routes / "cloudflare.env")]: sys.exit(8)
if os.environ.get("CLEANUP_TEST_FAIL") == name:
    print("private service credential must not appear in the result", file=sys.stderr)
    sys.exit(1)
`,
      { mode: 0o700 },
    );
  }
  const targets = Array.from({ length: count }, () => {
    const id: string = randomUUID();
    return { deployableId: id, sourceId: "source", runtimeIds: [id] };
  });
  const route = (runtime: string) => path.join(routes, `${runtime}.caddy`);
  const storage = (id: string) => path.join(data, "resources", id);
  for (const target of targets) {
    await writeFile(route(target.deployableId), target.deployableId);
    await mkdir(storage(target.deployableId), { recursive: true });
  }
  const script = cleanupOrphansScript
    .replaceAll("/etc/caddy", caddy)
    .replaceAll("/var/lib/towbar", data)
    .replace("sudo python3", "python3");
  const scriptPath = path.join(directory, "cleanup.sh");
  await writeFile(scriptPath, script);
  return {
    caddy,
    routes,
    data,
    targets,
    route,
    storage,
    async run(fail?: "caddy" | "systemctl") {
      const result = await execute(
        "bash",
        [
          scriptPath,
          "[]",
          JSON.stringify({
            ownedDeployableIds: targets.map((target) => target.deployableId),
            deployableIds: [],
            containerNames: [],
            imageTags: [],
            retiring: targets,
          }),
          "true",
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            CLEANUP_TEST_DIRECTORY: directory,
            CLEANUP_TEST_FAIL: fail ?? "",
          },
          timeout: 15_000,
        },
      );
      return serverCleanupResultSchema.parse(JSON.parse(result.stdout));
    },
    async calls() {
      const log = await readFile(
        path.join(directory, "calls.jsonl"),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return log.trim()
        ? log
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  name: string;
                  args: string[];
                  routes: string[];
                },
            )
        : [];
    },
  };
}

void test("batches all workload and preview routes into one validation and reload", async (t) => {
  const h = await harness(t, 9);
  const first = h.targets[0]!;
  const preview = `${first.deployableId}-preview-abc123`;
  first.runtimeIds.push(preview);
  await writeFile(h.route(preview), "preview");
  await writeFile(h.route("unrelated"), "keep");
  const result = await h.run();
  assert.deepEqual(result.failures, []);
  assert.equal(result.retiredDeployableIds?.length, 9);
  assert.equal(
    result.retiredPaths?.filter((value) => value.endsWith(".caddy")).length,
    10,
  );
  const calls = await h.calls();
  assert.deepEqual(
    calls.map((call) => call.name),
    ["caddy", "systemctl"],
  );
  for (const call of calls) assert.deepEqual(call.routes, ["unrelated.caddy"]);
  assert.deepEqual(calls[1]!.args, ["reload", "caddy"]);
  assert.deepEqual((await readdir(h.routes)).sort(), [
    "cloudflare.env",
    "unrelated.caddy",
  ]);
  assert.equal(await readFile(h.route("unrelated"), "utf8"), "keep");
});

for (const configured of [true, false]) {
  void test(`no route changes skip Caddy even when configuration is ${configured ? "present" : "absent"}`, async (t) => {
    const h = await harness(t);
    for (const target of h.targets) await rm(h.route(target.deployableId));
    if (!configured) await rm(path.join(h.caddy, "Caddyfile"));
    const result = await h.run("systemctl");
    assert.deepEqual(result.failures, []);
    assert.equal(result.retiredDeployableIds?.length, 2);
    assert.deepEqual(await h.calls(), []);
    assert(!result.retiredPaths?.some((value) => value.endsWith(".caddy")));
  });
}

for (const [command, message] of [
  ["caddy", "Unable to validate Caddy route cleanup"],
  ["systemctl", "Unable to apply Caddy route cleanup"],
] as const) {
  void test(`${command} failure restores every route and permits an idempotent retry`, async (t) => {
    const h = await harness(t, 3);
    const noRoute = h.targets[2]!;
    await rm(h.route(noRoute.deployableId));
    const result = await h.run(command);
    assert.equal(result.failures?.length, 2);
    assert.deepEqual(result.retiredDeployableIds, [noRoute.deployableId]);
    assert(!result.retiredPaths?.some((value) => value.endsWith(".caddy")));
    for (const failure of result.failures ?? []) {
      assert(failure.reason.startsWith(message));
      assert(!failure.reason.includes("private service credential"));
      assert(!failure.reason.includes("inspect cleanup state"));
    }
    for (const target of h.targets.slice(0, 2)) {
      assert.equal(
        await readFile(h.route(target.deployableId), "utf8"),
        target.deployableId,
      );
      await access(h.storage(target.deployableId));
    }
    await assert.rejects(access(h.storage(noRoute.deployableId)));
    const retry = await h.run();
    assert.deepEqual(retry.failures, []);
    assert.equal(retry.retiredDeployableIds?.length, 3);
    const calls = await h.calls();
    const repeated = await h.run();
    assert.deepEqual(repeated.failures, []);
    assert.deepEqual(
      await h.calls(),
      calls,
      "completed cleanup does not reload again",
    );
  });
}

void test("an interrupted staged removal reloads before recording retirement", async (t) => {
  const h = await harness(t, 1);
  const file = h.route(h.targets[0]!.deployableId);
  await rename(file, `${file}.retiring`);
  const result = await h.run();
  assert.deepEqual(result.failures, []);
  assert.equal(result.retiredDeployableIds?.length, 1);
  assert.deepEqual(
    (await h.calls()).map((call) => call.name),
    ["caddy", "systemctl"],
  );
  await assert.rejects(access(`${file}.retiring`));
});

void test("conflicting retirement files preserve both versions and restore earlier staged routes", async (t) => {
  const h = await harness(t);
  const file = h.route(h.targets[1]!.deployableId);
  await writeFile(`${file}.retiring`, "previous route");
  const result = await h.run();
  assert.equal(result.failures?.length, 2);
  assert.deepEqual(result.retiredDeployableIds, []);
  assert.deepEqual(await h.calls(), []);
  assert.equal(await readFile(`${file}.retiring`, "utf8"), "previous route");
  for (const target of h.targets) {
    assert.equal(
      await readFile(h.route(target.deployableId), "utf8"),
      target.deployableId,
    );
  }
});

void test("unsafe workload paths do not stage that workload's routes", async (t) => {
  const h = await harness(t);
  const unsafe = h.targets[0]!;
  await rm(h.storage(unsafe.deployableId), { recursive: true });
  await symlink(
    h.storage(h.targets[1]!.deployableId),
    h.storage(unsafe.deployableId),
  );
  const result = await h.run();
  assert.equal(result.failures?.length, 1);
  assert.deepEqual(result.retiredDeployableIds, [h.targets[1]!.deployableId]);
  assert.equal(
    await readFile(h.route(unsafe.deployableId), "utf8"),
    unsafe.deployableId,
  );
  for (const call of await h.calls())
    assert.deepEqual(call.routes, [`${unsafe.deployableId}.caddy`]);
});
