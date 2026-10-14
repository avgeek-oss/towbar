import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { appVolumeMounts, prepareAppStorageScript } from "./app-storage.js";
import { startRemoteScript } from "./app-runtime-scripts.js";
import {
  containerHealthRemoteScript,
  hookRemoteScript,
  rollbackCandidateScript,
} from "./remote-scripts.js";
import type { NormalizedApp } from "@workspace/towbar-core";

void test(
  "app files survive redeploy, hooks, failed startup, restart and isolated previews",
  {
    skip: process.env.TOWBAR_DOCKER_TESTS !== "true",
    timeout: 180_000,
  },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "towbar-app-storage-"));
    const owner = randomUUID(),
      preview = randomUUID(),
      source = randomUUID();
    const containers: string[] = [],
      volumes: string[] = [];
    const image = `towbar-storage-test:${owner}`;
    const docker = (args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const dockerPath = execFileSync("which", ["docker"], {
      encoding: "utf8",
    }).trim();
    const python = execFileSync("which", ["python3"], {
      encoding: "utf8",
    }).trim();
    const app = {
      container: {
        port: 8080,
        volumes: [{ name: "uploads", mountPath: "/data" }],
      },
    } as NormalizedApp;
    const shell = (script: string, args: string[], runtime = owner) =>
      execFileSync(
        "bash",
        [
          "-c",
          script
            .replaceAll("/var/lib/towbar/apps", path.join(root, "state"))
            .replaceAll('"sudo", "install"', '"install"')
            .replaceAll("sudo python3 -", "python3 -")
            .replaceAll("/etc/caddy/towbar", path.join(root, "routes"))
            .replaceAll("${hook_name,,}", "${hook_name}")
            .replace(
              /\/usr\/bin\/timeout --signal=TERM --kill-after=10s "\$timeout_seconds" \\\n/g,
              "",
            )
            .replaceAll("/usr/bin/docker", dockerPath)
            .replaceAll("/usr/bin/python3", python),
          "test",
          ...args,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            TOWBAR_APP_ID: runtime,
            TOWBAR_DEPLOYABLE_ID: owner,
            TOWBAR_SOURCE_ID: source,
            TOWBAR_DEPLOYMENT_ID: owner,
            TOWBAR_COMMIT_SHA: "test",
            TOWBAR_VOLUME_ARGS_JSON: JSON.stringify(
              appVolumeMounts(app, runtime),
            ),
          },
        },
      );
    const prepare = (previous = "", runtime = owner, initialData?: string) => {
      const volume = `towbar-${runtime}-uploads`;
      if (!volumes.includes(volume)) volumes.push(volume);
      return shell(
        prepareAppStorageScript,
        [
          runtime,
          owner,
          source,
          randomUUID(),
          image,
          previous,
          JSON.stringify([
            {
              ...app.container.volumes![0],
              ...(initialData ? { initialData } : {}),
            },
          ]),
        ],
        runtime,
      );
    };
    const start = (suffix: string, previous = "", runtime = owner) => {
      const name = `towbar-${owner}-${suffix}`;
      containers.push(name);
      const remote = path.join(root, suffix);
      mkdirSync(path.join(remote, "secrets/runtime"), { recursive: true });
      shell(
        startRemoteScript,
        [remote, name, image, "8080", "bridge", "", "", "", previous],
        runtime,
      );
      return name;
    };
    try {
      writeFileSync(
        path.join(root, "Dockerfile"),
        'FROM alpine:3.22\nRUN mkdir /data && chown 1000:1000 /data\nUSER 1000:1000\nCMD ["sh","-c","trap \'exit 0\' TERM; sleep 3600 & wait"]\n',
      );
      docker(["build", "-q", "-t", image, root]);
      prepare();
      const first = start("first");
      docker(["exec", first, "sh", "-c", "printf original > /data/upload.txt"]);
      prepare(first);
      assert.equal(
        docker(["inspect", "-f", "{{.State.Running}}", first]),
        "false",
      );
      const second = start("second", first);
      assert.equal(
        docker(["exec", second, "cat", "/data/upload.txt"]),
        "original",
      );
      docker(["restart", second]);
      assert.equal(
        docker(["exec", second, "cat", "/data/upload.txt"]),
        "original",
      );

      const remote = path.join(root, "hook");
      mkdirSync(path.join(remote, "secrets/hooks/postDeploy"), {
        recursive: true,
      });
      shell(hookRemoteScript, [
        remote,
        "postDeploy",
        second,
        image,
        "bridge",
        "",
        "",
        "20",
        "sh",
        "-c",
        "printf hook > /data/hook.txt",
      ]);
      assert.equal(docker(["exec", second, "cat", "/data/hook.txt"]), "hook");

      prepare(second);
      const failure = start("failure", second);
      assert.throws(() =>
        shell(containerHealthRemoteScript, [failure, "command", "1", "false"]),
      );
      const failedDir = path.join(root, "failed");
      mkdirSync(failedDir);
      shell(rollbackCandidateScript, [
        failedDir,
        owner,
        failure,
        image,
        "false",
        second,
        owner,
      ]);
      assert.equal(
        docker(["exec", second, "cat", "/data/upload.txt"]),
        "original",
      );
      prepare(second);
      docker(["start", first]);
      assert.equal(docker(["exec", first, "cat", "/data/hook.txt"]), "hook");

      prepare("", preview, "previous-container");
      const sibling = start("preview", "", preview);
      assert.throws(() => docker(["exec", sibling, "cat", "/data/upload.txt"]));
      docker([
        "exec",
        sibling,
        "sh",
        "-c",
        "printf preview > /data/upload.txt",
      ]);
      assert.equal(
        docker(["exec", first, "cat", "/data/upload.txt"]),
        "original",
      );
      assert.throws(() => prepare(first, preview), /does not belong/);

      // A newly declared volume must not silently hide an existing container's files.
      const importing = randomUUID();
      const legacy = `towbar-${owner}-legacy`;
      containers.push(legacy);
      docker([
        "run",
        "-d",
        "--name",
        legacy,
        "--label",
        "towbar.managed=true",
        "--label",
        `towbar.app=${importing}`,
        "--label",
        `towbar.deployable=${owner}`,
        "--label",
        `towbar.source=${source}`,
        image,
      ]);
      docker([
        "exec",
        legacy,
        "sh",
        "-c",
        "printf imported > /data/upload.txt",
      ]);
      assert.throws(() => prepare(legacy, importing), /initialData/);
      assert.equal(
        docker(["inspect", "-f", "{{.State.Running}}", legacy]),
        "true",
      );
      prepare(legacy, importing, "previous-container");
      const imported = start("imported", legacy, importing);
      assert.equal(
        docker(["exec", imported, "cat", "/data/upload.txt"]),
        "imported",
      );
      docker([
        "exec",
        imported,
        "sh",
        "-c",
        "printf writable > /data/another.txt",
      ]);
      // Removing a mount must retain its contents for later reattachment.
      shell(
        prepareAppStorageScript,
        [importing, owner, source, randomUUID(), image, imported, "[]"],
        importing,
      );
      assert(docker(["volume", "inspect", `towbar-${importing}-uploads`]));
      prepare(imported, importing);
      docker(["start", imported]);
      assert.equal(
        docker(["exec", imported, "cat", "/data/another.txt"]),
        "writable",
      );

      // A missing initialized volume must not be recreated empty.
      docker(["rm", "-f", sibling]);
      docker(["volume", "rm", `towbar-${preview}-uploads`]);
      assert.throws(() => prepare("", preview), /is missing/);
      assert.throws(() =>
        docker(["volume", "inspect", `towbar-${preview}-uploads`]),
      );

      const resuming = randomUUID();
      const abandonedVolume = `towbar-${resuming}-uploads`;
      const abandonedHelper = `towbar-storage-${randomUUID()}-0`;
      volumes.push(abandonedVolume);
      containers.push(abandonedHelper);
      const labels = [
        "--label",
        "towbar.managed=true",
        "--label",
        `towbar.deployable=${owner}`,
        "--label",
        `towbar.source=${source}`,
        "--label",
        `towbar.runtime=${resuming}`,
        "--label",
        "towbar.storage=app",
        "--label",
        `towbar.initializer=${abandonedHelper}`,
      ];
      docker(["volume", "create", ...labels, abandonedVolume]);
      docker([
        "create",
        "--name",
        abandonedHelper,
        ...labels,
        "--mount",
        `type=volume,src=${abandonedVolume},dst=/data`,
        image,
      ]);
      const abandonedState = path.join(root, "state", resuming, "volumes");
      mkdirSync(abandonedState, { recursive: true });
      writeFileSync(
        path.join(abandonedState, "uploads.initializing"),
        abandonedHelper,
      );
      prepare("", resuming);
      assert.throws(() => docker(["container", "inspect", abandonedHelper]));
      const resumed = start("resumed", "", resuming);
      docker([
        "exec",
        resumed,
        "sh",
        "-c",
        "printf recovered > /data/resumed.txt",
      ]);

      const foreignRuntime = randomUUID();
      volumes.push(`towbar-${foreignRuntime}-uploads`);
      docker(["volume", "create", `towbar-${foreignRuntime}-uploads`]);
      assert.throws(() => prepare("", foreignRuntime), /ownership mismatch/);
      assert(docker(["volume", "inspect", `towbar-${foreignRuntime}-uploads`]));
    } finally {
      for (const name of containers.reverse()) {
        try {
          docker(["rm", "-f", name]);
        } catch {
          /* Already removed by rollback. */
        }
      }
      for (const name of volumes) {
        try {
          docker(["volume", "rm", name]);
        } catch {
          /* A failed initializer may have removed it. */
        }
      }
      try {
        docker(["image", "rm", image]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
