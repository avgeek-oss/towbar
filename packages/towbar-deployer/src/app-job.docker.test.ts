import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { appJobRemoteScript } from "./app-job.js";

void test(
  "scheduled jobs use app volumes, preserve non-root permissions, redact output and enforce timeouts",
  {
    skip: process.env.TOWBAR_DOCKER_TESTS !== "true",
    timeout: 120_000,
  },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "towbar-job-test-"));
    const appId = randomUUID(),
      sourceId = randomUUID();
    const image = `towbar-job-test:${appId}`,
      container = `towbar-job-test-${appId}`,
      volume = `towbar-${appId}-data`;
    const docker = (...args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const payload = {
      operationId: randomUUID(),
      appId,
      sourceId,
      previousSourceIds: [] as string[],
      containerName: container,
      imageTag: image,
      job: {
        name: "report",
        command: ["sh", "-c", "echo success"],
        timeoutSeconds: 5,
      },
      runtime: {
        SECRET: "only-in-the-container",
        MULTILINE: "line-one\nline-two",
        LD_PRELOAD: "/no-such-file",
      },
      resources: { cpus: 0.5, memory: "32.5m" },
      mounts: ["--mount", `type=volume,src=${volume},dst=/data,volume-nocopy`],
    };
    function execute(command: string[], extra: Partial<typeof payload> = {}) {
      const input = {
        ...payload,
        ...extra,
        operationId: randomUUID(),
        job: { ...payload.job, command },
      };
      const file = path.join(root, "job.json");
      writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
      return JSON.parse(
        execFileSync("bash", ["-c", appJobRemoteScript, "test", file], {
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ) as {
        logs: string;
        exitCode: number;
        timedOut: boolean;
        truncated: boolean;
      };
    }
    try {
      writeFileSync(
        path.join(root, "Dockerfile"),
        'FROM alpine:3.22\nRUN mkdir /data && chown 1000:1000 /data\nUSER 1000:1000\nCMD ["sleep", "3600"]\n',
      );
      docker("build", "-q", "-t", image, root);
      docker(
        "volume",
        "create",
        "--label",
        "towbar.managed=true",
        "--label",
        `towbar.source=${sourceId}`,
        "--label",
        `towbar.deployable=${appId}`,
        "--label",
        `towbar.runtime=${appId}`,
        "--label",
        "towbar.storage=app",
        volume,
      );
      docker(
        "run",
        "-d",
        "--name",
        container,
        "--label",
        "towbar.managed=true",
        "--label",
        `towbar.source=${sourceId}`,
        "--label",
        `towbar.deployable=${appId}`,
        "--label",
        `towbar.app=${appId}`,
        "--mount",
        `type=volume,src=${volume},dst=/data`,
        image,
      );
      const result = execute([
        "sh",
        "-c",
        'id -u; printf file > /data/result; printf "%s\\n%s\\n" "$SECRET" "$MULTILINE"',
      ]);
      assert.equal(result.exitCode, 0);
      assert.match(result.logs, /1000/);
      assert.equal(result.logs.includes(payload.runtime.SECRET), false);
      assert.equal(result.logs.includes("line-one"), false);
      assert.match(result.logs, /REDACTED/);
      assert.equal(docker("exec", container, "cat", "/data/result"), "file");
      assert.equal(execute(["sh", "-c", "echo failure; exit 7"]).exitCode, 7);
      const timeout = execute(["sleep", "20"]);
      assert.equal(timeout.timedOut, true);
      assert.notEqual(timeout.exitCode, 0);
      const large = execute([
        "sh",
        "-c",
        "head -c 300000 /dev/zero | tr '\\000' x",
      ]);
      assert.equal(large.truncated, true);
      assert.ok(large.logs.length <= 256 * 1024);
      const partial = execute([
        "sh",
        "-c",
        'head -c 262134 /dev/zero | tr "\\000" x; printf "%s" "$SECRET"',
      ]);
      assert.equal(partial.truncated, true);
      assert.equal(partial.logs.includes("only-in-th"), false);
      assert.match(partial.logs, /REDACTED/);
      assert.throws(
        () => execute(["true"], { sourceId: randomUUID() }),
        /failed/,
      );
      assert.equal(
        execute(["sh", "-c", "echo transferred"], {
          sourceId: randomUUID(),
          previousSourceIds: [sourceId],
        }).exitCode,
        0,
      );
      assert.throws(
        () =>
          execute(["true"], {
            mounts: [
              "--mount",
              "type=volume,src=missing-towbar-job-volume,dst=/data,volume-nocopy",
            ],
          }),
        /failed/,
      );
      assert.equal(
        docker(
          "ps",
          "-aq",
          "--filter",
          `label=towbar.job=${payload.job.name}`,
          "--filter",
          `label=towbar.deployable=${appId}`,
        ),
        "",
      );
      assert.equal(
        docker("inspect", "-f", "{{.State.Running}}", container),
        "true",
      );
    } finally {
      try {
        docker("rm", "-f", "-v", container);
      } catch {
        /* Test container may not have been created. */
      }
      try {
        docker("volume", "rm", volume);
      } catch {
        /* Test volume may not have been created. */
      }
      try {
        docker("image", "rm", image);
      } catch {
        /* Test image may not have been built. */
      }
      rmSync(path.join(tmpdir(), `towbar-jobs-${appId}`), {
        force: true,
        recursive: true,
      });
      rmSync(root, { force: true, recursive: true });
    }
  },
);
