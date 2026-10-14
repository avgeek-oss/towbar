import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RuntimeExpectation } from "@workspace/towbar-core";
import type { SshSession } from "./ssh.js";
import { describe, it } from "node:test";
import { resourceOperationScripts } from "./resource-operations.js";

import {
  inspectServerRuntime,
  parseRuntimeInspectionOutput,
  runtimeInspectionScript,
} from "./runtime-inspection.js";

void describe("runtime inspection", () => {
  void it("parses bounded runtime and orphan results", () => {
    assert.deepEqual(
      parseRuntimeInspectionOutput(
        JSON.stringify({
          orphans: [
            {
              kind: "image",
              name: "towbar/deployable-old:release",
              reason: "Not retained",
            },
          ],
          runtime: [
            {
              cpuPercent: 4.2,
              deployableId: "10000000-0000-4000-8000-000000000001",
              driftReasons: [],
              driftStatus: "in_sync",
              healthStatus: "healthy",
              ingressContainerName: null,
              ingressImage: null,
              ingressRestartCount: null,
              ingressStatus: "disabled",
              memoryLimitBytes: 1073741824,
              memoryUsageBytes: 268435456,
              observedContainerName: "towbar-api-release",
              observedImage: "towbar/deployable-api:release",
              observedState: "running",
              restartCount: 1,
              startedAt: "2026-08-28T10:00:00.000Z",
            },
          ],
        }),
      ).runtime[0]?.driftStatus,
      "in_sync",
    );
  });

  void it("rejects malformed worker output", () => {
    assert.throws(() =>
      parseRuntimeInspectionOutput(
        JSON.stringify({ orphans: [], runtime: [{ deployableId: "nope" }] }),
      ),
    );
  });

  void it("discovers only Source-labeled managed objects", () => {
    assert.match(runtimeInspectionScript, /label=towbar\.managed=true/);
    assert.match(runtimeInspectionScript, /towbar\.source/);
    assert.match(runtimeInspectionScript, /expected_containers/);
    assert.match(runtimeInspectionScript, /expected\["containerNames"\]/);
    assert.match(runtimeInspectionScript, /expected_images/);
    assert.doesNotMatch(runtimeInspectionScript, /system prune/);
  });

  void it("checks stable private aliases and loopback-only host ports", () => {
    assert.match(runtimeInspectionScript, /configured Docker network/);
    assert.match(runtimeInspectionScript, /configured Docker network alias/);
    assert.match(runtimeInspectionScript, /configured loopback host port/);
    assert.match(runtimeInspectionScript, /NetworkSettings/);
    assert.match(runtimeInspectionScript, /HostIp/);
    assert.match(runtimeInspectionScript, /127\.0\.0\.1/);
  });

  void it("runs manifest-defined HTTP and command health checks", () => {
    assert.match(runtimeInspectionScript, /health_type == "http"/);
    assert.match(runtimeInspectionScript, /urllib\.request\.urlopen/);
    assert.match(runtimeInspectionScript, /health_type == "command"/);
    assert.match(runtimeInspectionScript, /"docker", "exec"/);
    assert.match(runtimeInspectionScript, /timeout=timeout/);
  });

  void it("collects bounded container capacity signals", () => {
    assert.match(runtimeInspectionScript, /docker", "stats", "--no-stream"/);
    assert.match(runtimeInspectionScript, /collect_runtime_stats/);
    assert.match(runtimeInspectionScript, /runtime_metrics\(container_name/);
    assert.match(runtimeInspectionScript, /metrics = \[runtime_metrics\(/);
    assert.match(runtimeInspectionScript, /stats_by_name/);
    assert.match(runtimeInspectionScript, /RestartCount/);
    assert.match(runtimeInspectionScript, /memoryUsageBytes/);
    assert.match(runtimeInspectionScript, /cpuPercent/);
  });
});

void it("inspects multiple sources on one server without adopting foreign objects", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "towbar-runtime-test-"));
  try {
    const deployables: RuntimeExpectation[] = ["a", "b"].map((name, index) => ({
      connectivity: null,
      deployableId: `10000000-0000-4000-8000-00000000000${index + 1}`,
      sourceId: `source-${name}`,
      desiredState: "running",
      health: { timeoutSeconds: 5, type: "container" },
      ingress: null,
      release: { containerName: name, imageTag: `towbar/${name}:current` },
    }));
    const objects: Record<string, unknown> = {};
    for (const item of deployables) {
      const name = item.release!.containerName;
      const labels = {
        "towbar.managed": "true",
        "towbar.source": item.sourceId,
        "towbar.deployable": item.deployableId,
      };
      objects[`container:${name}`] = {
        Name: `/${name}`,
        Config: { Labels: labels, Image: item.release!.imageTag },
        State: { Running: true, Health: { Status: "healthy" } },
      };
      objects[`container:${name}-previous`] = {
        Name: `/${name}-previous`,
        Config: { Labels: labels },
      };
      objects[`container:${name}-old`] = {
        Name: `/${name}-old`,
        Config: { Labels: labels },
      };
      objects[`image:towbar/${name}:current`] = {
        Id: `${name}:current`,
        Config: { Labels: labels },
      };
      objects[`image:towbar/${name}:previous`] = {
        Id: `${name}:previous`,
        Config: { Labels: labels },
      };
      objects[`image:towbar/${name}:old`] = {
        Id: `${name}:old`,
        Config: { Labels: labels },
      };
      objects[`volume:${name}-data`] = { Labels: labels };
      objects[`volume:${name}-removed`] = {
        Labels: { ...labels, "towbar.deployable": "removed" },
      };
    }
    const foreign = {
      "towbar.managed": "true",
      "towbar.source": "unrelated-source",
      "towbar.deployable": "unrelated-app",
    };
    objects["container:foreign"] = {
      Name: "/foreign",
      Config: { Labels: foreign },
    };
    objects["image:towbar/foreign:old"] = { Config: { Labels: foreign } };
    objects["volume:foreign"] = { Labels: foreign };
    await writeFile(
      path.join(directory, "objects.json"),
      JSON.stringify(objects),
    );
    await writeFile(
      path.join(directory, "docker"),
      `#!${process.execPath}
const objects = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(path.join(directory, "objects.json"))}, 'utf8'));
const args = process.argv.slice(2);
if (args[1] === 'inspect') {
  const object = objects[args[0] + ':' + args[2]];
  if (!object) process.exit(1);
  console.log(JSON.stringify([object]));
} else if (args[0] === 'ps' && args.some(arg => arg.startsWith('volume='))) {
  const volume = args.find(arg => arg.startsWith('volume=')).slice(7);
  console.log(Object.entries(objects).filter(([key, value]) => key.startsWith('container:') && (value.Mounts || []).some(mount => mount.Name === volume)).map(([key]) => key.slice(10)).join('\\n'));
} else if (args[0] !== 'stats') {
  const kind = args[0] === 'ps' ? 'container' : args[0];
  console.log(Object.keys(objects).filter(key => key.startsWith(kind + ':')).map(key => key.slice(kind.length + 1)).join('\\n'));
}
`,
      { mode: 0o700 },
    );
    const session = {
      run: (script: string, args: string[]) =>
        Promise.resolve({
          stderr: "",
          stdout: execFileSync(
            "bash",
            [
              "-c",
              `export PATH="$1:$PATH"; shift\n${script}`,
              "runtime-test",
              directory,
              ...args,
            ],
            {
              encoding: "utf8",
            },
          ),
        }),
    } as unknown as SshSession;
    const input = {
      containerNames: ["a", "a-previous", "b", "b-previous"],
      deployables,
      imageTags: [
        "towbar/a:current",
        "towbar/a:previous",
        "towbar/b:current",
        "towbar/b:previous",
      ],
      ownedDeployableIds: [
        ...deployables.map((item) => item.deployableId),
        "removed",
      ],
      session,
    };
    const result = await inspectServerRuntime(input);
    assert.deepEqual(
      result.runtime.map((item) => item.driftStatus),
      ["in_sync", "in_sync"],
    );
    assert.deepEqual(
      result.runtime.map((item) => item.healthStatus),
      ["healthy", "healthy"],
    );
    assert.deepEqual(
      result.orphans.map((item) => `${item.kind}:${item.name}`),
      [
        "container:a-old",
        "container:b-old",
        "image:towbar/a:old",
        "image:towbar/b:old",
        "volume:a-removed",
        "volume:b-removed",
      ],
    );
    const disconnected = await inspectServerRuntime({
      ...input,
      deployables: [],
      containerNames: [],
      imageTags: [],
    });
    assert.equal(disconnected.runtime.length, 0);
    assert.equal(disconnected.orphans.length, 16);
    assert(!disconnected.orphans.some((item) => item.name.includes("foreign")));
    assert(
      disconnected.orphans.some(
        (item) => item.kind === "container" && item.name === "a",
      ),
    );
    assert(
      disconnected.orphans.some(
        (item) => item.kind === "volume" && item.name === "a-data",
      ),
    );
    // No retained ownership means no adoption, even with Towbar-like names/labels.
    assert.deepEqual(
      (
        await inspectServerRuntime({
          ...input,
          deployables: [],
          ownedDeployableIds: [],
        })
      ).orphans,
      [],
    );
    const cleanup = await session.run(resourceOperationScripts.cleanupOrphans, [
      JSON.stringify([
        ...disconnected.orphans,
        { kind: "container", name: "foreign", reason: "Untrusted" },
      ]),
      JSON.stringify({
        ownedDeployableIds: input.ownedDeployableIds,
        containerNames: ["a"],
        imageTags: ["towbar/a:current"],
        deployableIds: [deployables[0]!.deployableId],
      }),
    ]);
    const cleaned = JSON.parse(cleanup.stdout) as {
      cleaned: Array<{ name: string }>;
      skipped: Array<{ name: string }>;
    };
    assert(cleaned.skipped.some((item) => item.name === "a"));
    assert(cleaned.skipped.some((item) => item.name === "towbar/a:current"));
    assert(cleaned.skipped.some((item) => item.name === "a-data"));
    assert(cleaned.skipped.some((item) => item.name === "foreign"));
    assert(cleaned.cleaned.some((item) => item.name === "b"));
    assert(cleaned.cleaned.some((item) => item.name === "b-data"));
    objects["container:b"] = {
      Name: "/b",
      Config: { Labels: foreign, Image: "towbar/b:current" },
      State: { Running: true },
    };
    await writeFile(
      path.join(directory, "objects.json"),
      JSON.stringify(objects),
    );
    assert.equal(
      (await inspectServerRuntime(input)).runtime[1]?.driftStatus,
      "drifted",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
