import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  parseTrivyScanResult,
  trivyScanScript,
} from "../../apps/towbar-worker/dist/vulnerability-scanners/trivy.js";
import { startTestTarget } from "./target.mjs";
import {
  trivyFallbackDbRepository,
  trivyScanner,
} from "../verification/trivy-db.mjs";

const target = await startTestTarget();
try {
  assert.notEqual(target.ssh("id -u"), "0");
  assert.equal(target.ssh("uname -s"), "Linux");
  const image = "alpine:3.22";
  const scanner = trivyScanner;
  target.ssh(`docker pull ${image}`);
  const digest = target.ssh(`docker image inspect --format '{{.Id}}' ${image}`);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  target.ssh("mkdir -m 700 /home/deploy/scan-test");
  // The production script keeps its database in the target's
  // towbar-trivy-cache volume. Back that volume with a directory seeded from
  // the CI cache (TOWBAR_TRIVY_CACHE_DIR) and fetch the database here, with a
  // GHCR retry, so the script's own update check finds it current.
  const cacheDirectory = process.env.TOWBAR_TRIVY_CACHE_DIR;
  const databaseDirectory = "/var/lib/towbar-trivy-cache";
  const host = (...args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  host("exec", target.container, "mkdir", "-p", databaseDirectory);
  if (cacheDirectory && existsSync(path.join(cacheDirectory, "db", "trivy.db")))
    host(
      "cp",
      path.join(cacheDirectory, "db"),
      `${target.container}:${databaseDirectory}/db`,
    );
  host("exec", target.container, "chown", "-R", "0:0", databaseDirectory);
  target.ssh(
    `docker volume create --driver local --opt type=none --opt o=bind --opt device=${databaseDirectory} towbar-trivy-cache >/dev/null`,
  );
  const download = (repository = "") =>
    target.ssh(
      `docker run --rm --cap-drop ALL --security-opt no-new-privileges --volume towbar-trivy-cache:/root/.cache/trivy ${scanner} image --download-db-only --quiet ${repository}`,
    );
  try {
    download();
  } catch (error) {
    console.log(
      `Database download failed (${String(error.stderr ?? error.message)
        .trim()
        .split("\n")
        .at(-1)}); retrying ${trivyFallbackDbRepository}.`,
    );
    download(`--db-repository ${trivyFallbackDbRepository}`);
  }
  const run = (script, imageDigest = digest) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "ssh",
        [
          "-i",
          target.key,
          "-p",
          String(target.port),
          "-o",
          "BatchMode=yes",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${target.directory}/known_hosts`,
          "deploy@127.0.0.1",
          `TMPDIR=/home/deploy/scan-test bash -s -- ${scanner} ${imageDigest}`,
        ],
        { timeout: 540_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") reject(error);
          else resolve({ status: error?.code ?? 0, stdout, stderr });
        },
      );
      child.stdin.end(script);
    });
  const success = await run(trivyScanScript);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(parseTrivyScanResult(success.stdout).scannerName, "trivy");
  assert.equal(
    target.ssh("find /home/deploy/scan-test -mindepth 1 -print"),
    "",
  );
  console.log("Production scan succeeded with a non-root private archive.");
  const inaccessible = await run(
    trivyScanScript.replace(
      '--volume "$image_file:/scan/image.tar:ro"',
      '--volume "$work_dir:/scan:ro"',
    ),
  );
  assert.notEqual(inaccessible.status, 0);
  assert.match(inaccessible.stderr, /permission denied/iu);
  assert.equal(
    target.ssh("find /home/deploy/scan-test -mindepth 1 -print"),
    "",
  );
  const failure = await run(trivyScanScript, `sha256:${"0".repeat(64)}`);
  assert.notEqual(failure.status, 0);
  assert.equal(
    target.ssh("find /home/deploy/scan-test -mindepth 1 -print"),
    "",
  );
  console.log(
    "Linux permission negative control and temporary archive cleanup verified.",
  );
  if (cacheDirectory)
    host("cp", `${target.container}:${databaseDirectory}/db`, cacheDirectory);
} finally {
  target.close();
}
