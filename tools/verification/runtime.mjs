import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { requiredTestCounts } from "./test-output.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const execute = promisify(execFile);

export function testEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env))
    if (/^(?:DATABASE_|TOWBAR_|TEMPORAL_|AWS_|GOOGLE_|GCLOUD_|GCP_)/.test(key))
      delete env[key];
  return { ...env, CI: "1", NODE_ENV: "test" };
}

// Runs independent steps together, waits for all of them so every log is
// complete, then reports every failure.
export async function concurrently(...steps) {
  const failures = (await Promise.allSettled(steps))
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Concurrent verification steps failed");
}

export async function verificationRun(group) {
  const id = randomUUID();
  const directory = path.join(
    repository,
    "tmp",
    "verification",
    `${group}-${id}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const results = [];
  let persisted = Promise.resolve();
  const env = testEnvironment();
  env.TOWBAR_VERIFICATION_RUN_ID = id;
  const capture = async (command, args, extra = {}) => {
    const result = await execute(command, args, {
      cwd: repository,
      env: { ...env, ...extra },
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  };
  const step = async (
    name,
    command,
    args,
    { extra = {}, requiredTests = false, timeoutMs = 1_200_000 } = {},
  ) => {
    controller.signal.throwIfAborted();
    const started = Date.now();
    const log = path.join(directory, `${name}.log`);
    const file = await open(log, "w", 0o600);
    console.log(`[${group}] ${name}`);
    let exitCode;
    let failure;
    let counts;
    try {
      exitCode = await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: repository,
          env: { ...env, ...extra },
          stdio: ["ignore", file.fd, file.fd],
          detached: true,
        });
        let timedOut = false;
        let stopping = false;
        let forceKill;
        const killGroup = (signal) => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            if (error.code !== "ESRCH") reject(error);
          }
        };
        const stop = () => {
          if (stopping) return;
          stopping = true;
          killGroup("SIGTERM");
          forceKill = setTimeout(() => killGroup("SIGKILL"), 5_000);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        controller.signal.addEventListener("abort", stop, { once: true });
        const release = () => {
          clearTimeout(timer);
          clearTimeout(forceKill);
          controller.signal.removeEventListener("abort", stop);
        };
        child.once("error", (error) => {
          release();
          reject(error);
        });
        child.once("exit", (code, signal) => {
          if (stopping) killGroup("SIGKILL");
          release();
          if (timedOut) reject(new Error(`${name} exceeded its time limit`));
          else if (signal) reject(new Error(`${name} ended with ${signal}`));
          else resolve(code);
        });
      });
      if (exitCode !== 0)
        throw new Error(`${name} exited ${exitCode}; see ${log}`);
      if (requiredTests)
        counts = requiredTestCounts(await readFile(log, "utf8"));
      controller.signal.throwIfAborted();
    } catch (error) {
      failure = error;
    } finally {
      await file.close();
      results.push({
        name,
        status: failure ? "failed" : "passed",
        exitCode,
        seconds: Math.round((Date.now() - started) / 1000),
        counts,
        log: path.basename(log),
        error: failure?.message,
      });
      // Steps may run concurrently; queue the writes so a slower write of an
      // older snapshot can never land after, or interleave with, a newer one.
      const snapshot = JSON.stringify({ group, id, results }, null, 2);
      persisted = persisted.then(() =>
        writeFile(path.join(directory, "results.json"), snapshot, {
          mode: 0o600,
        }),
      );
      await persisted;
    }
    if (failure) throw failure;
  };
  return {
    id,
    group,
    directory,
    env,
    capture,
    step,
    finish() {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      console.log(`Verification evidence: ${directory}`);
    },
  };
}
