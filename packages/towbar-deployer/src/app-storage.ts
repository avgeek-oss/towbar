import { runWithSafeLogs } from "./executor-hooks.js";
import { deploymentRuntimeId } from "./deployment-identity.js";
import type { DeploymentExecutionContext, ExecutorHooks } from "./types.js";
import type { SshSession } from "./ssh.js";
import type { NormalizedApp } from "@workspace/towbar-core";

export function appVolumeMounts(app: NormalizedApp, runtimeId: string) {
  return (app.container.volumes ?? []).flatMap((volume) => [
    "--mount",
    `type=volume,src=towbar-${runtimeId}-${volume.name},dst=${volume.mountPath},volume-nocopy`,
  ]);
}

// Initialization runs before hooks and candidate startup. The ready marker is
// written only after Docker has populated the volume; retries cannot mistake a
// partial import or a missing retained volume for an empty new data directory.
export const prepareAppStorageScript = String.raw`
set -euo pipefail
exec python3 - "$@" <<'PYTHON'
import json
import fcntl
import os
import posixpath
from pathlib import Path
import subprocess
import sys
import signal

def cancelled(signum, frame):
    raise SystemExit("Storage initialization cancelled")

for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(signum, cancelled)

runtime_id, deployable_id, source_id, deployment_id, image, previous, volumes_json = sys.argv[1:8]
source_ids = {source_id, *json.loads(sys.argv[8] if len(sys.argv) > 8 else "[]")}
volumes = json.loads(volumes_json)
state = Path("/var/lib/towbar/apps") / runtime_id / "volumes"

def run(*args):
    result = subprocess.run(["docker", *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Docker storage operation failed")
    return result.stdout.strip()

def inspect(kind, name):
    result = subprocess.run(["docker", kind, "inspect", name], capture_output=True, text=True)
    if result.returncode:
        if "no such" in result.stderr.lower():
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout)[0]

def owned(labels):
    return (labels.get("towbar.managed") == "true" and
            labels.get("towbar.deployable") == deployable_id and
            labels.get("towbar.source") in source_ids)

old = inspect("container", previous) if previous else None
if old and (not owned(old.get("Config", {}).get("Labels") or {}) or
            (old.get("Config", {}).get("Labels") or {}).get("towbar.app") != runtime_id):
    raise RuntimeError("Previous container does not belong to this app environment")
if not old and runtime_id != deployable_id:
    # Preview instances always start with independent image data.
    volumes = [{**volume, "initialData": "image"} for volume in volumes]
if volumes:
    subprocess.run(["sudo", "install", "-d", "-m", "0755", "-o", str(os.getuid()), "-g", str(os.getgid()), str(state)], check=True)
    lock = (state / ".initialization.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX)
old_mounts = (old or {}).get("Mounts") or []
old_has_storage = any(m.get("Type") == "volume" for m in old_mounts)

# Validate all volumes before stopping the currently serving container.
for volume in volumes:
    name = "towbar-" + runtime_id + "-" + volume["name"]
    existing = inspect("volume", name)
    ready = state / (volume["name"] + ".ready")
    if existing:
        labels = existing.get("Labels") or {}
        if not owned(labels) or labels.get("towbar.runtime") != runtime_id or labels.get("towbar.storage") != "app":
            raise RuntimeError("Storage ownership mismatch for " + volume["name"])
        if not ready.exists():
            pending = ready.with_suffix(".initializing")
            helper = pending.read_text().strip() if pending.exists() else ""
            if not helper or labels.get("towbar.initializer") != helper:
                raise RuntimeError("Storage initialization is incomplete for " + volume["name"] + "; recover the retained volume before deploying")
            scratch = inspect("container", helper)
            if scratch:
                scratch_labels = (scratch.get("Config") or {}).get("Labels") or {}
                if not owned(scratch_labels) or scratch_labels.get("towbar.initializer") != helper or scratch.get("State", {}).get("Running"):
                    raise RuntimeError("Storage initializer ownership mismatch")
                run("rm", "-v", helper)
            # Docker refuses removal if any other container references the volume.
            run("volume", "rm", name)
            pending.unlink()
            existing = None
    if not existing and ready.exists():
        raise RuntimeError("Persistent volume " + volume["name"] + " is missing; restore its data before deploying")
    elif not existing and old and not volume.get("initialData"):
        raise RuntimeError("New volume " + volume["name"] + ": set initialData to previous-container to import existing files, or image to initialize from the image")
    elif not existing and volume.get("initialData") == "previous-container" and not old:
        raise RuntimeError("No previous container is available to import " + volume["name"])

if old and (volumes or old_has_storage):
    run("stop", previous)
    print("Stopped the previous release before accessing persistent storage", flush=True)
for index, volume in enumerate(volumes):
    name = "towbar-" + runtime_id + "-" + volume["name"]
    ready = state / (volume["name"] + ".ready")
    if ready.exists():
        print("Reusing volume " + volume["name"] + " at " + volume["mountPath"], flush=True)
        continue
    helper = "towbar-storage-" + deployment_id + "-" + str(index)
    pending = ready.with_suffix(".initializing")
    pending.write_text(helper + "\n")
    labels = {"towbar.managed": "true", "towbar.deployable": deployable_id,
              "towbar.source": source_id, "towbar.runtime": runtime_id,
              "towbar.storage": "app", "towbar.volume": volume["name"], "towbar.initializer": helper,
              "towbar.mount-path": volume["mountPath"]}
    args = ["volume", "create"]
    for key, value in labels.items():
        args.extend(["--label", key + "=" + value])
    run(*args, name)
    initialized = False
    try:
        mount = "type=volume,src=" + name + ",dst=" + volume["mountPath"]
        if volume.get("initialData") == "previous-container":
            mount += ",volume-nocopy"
        run("create", "--name", helper, "--label", "towbar.managed=true",
            "--label", "towbar.deployable=" + deployable_id,
            "--label", "towbar.source=" + source_id,
            "--label", "towbar.initializer=" + helper,
            "--mount", mount, image)
        if volume.get("initialData") == "previous-container":
            # Copy the directory itself to preserve its UID/GID and permissions,
            # including for images whose runtime user is not root.
            source = subprocess.Popen(["docker", "cp", "-a", previous + ":" + volume["mountPath"], "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                target = subprocess.run(["docker", "cp", "-a", "-", helper + ":" + posixpath.dirname(volume["mountPath"])], stdin=source.stdout, capture_output=True)
                source.stdout.close()
                error = source.communicate()[1]
                if source.returncode or target.returncode:
                    raise RuntimeError("Could not import " + volume["name"] + ": " + (error + target.stderr).decode(errors="replace"))
            finally:
                if source.poll() is None:
                    source.kill()
                    source.wait()
        run("rm", "-v", helper)
        temporary = ready.with_suffix(".tmp")
        temporary.write_text(name + "\n")
        os.replace(temporary, ready)
        initialized = True
        pending.unlink(missing_ok=True)
        print("Initialized volume " + volume["name"] + " at " + volume["mountPath"], flush=True)
    finally:
        subprocess.run(["docker", "rm", "-f", "-v", helper], capture_output=True)
        if not initialized:
            subprocess.run(["docker", "volume", "rm", name], capture_output=True)
PYTHON
`;

export async function prepareAppStorage(
  input: {
    context: DeploymentExecutionContext;
    hooks: ExecutorHooks;
    sensitiveValues: string[];
    session: SshSession;
    signal?: AbortSignal;
    imageTag: string;
  },
  app: NormalizedApp,
) {
  await runWithSafeLogs({
    hooks: input.hooks,
    sensitiveValues: input.sensitiveValues,
    run: (outputHandlers) =>
      input.session.run(
        prepareAppStorageScript,
        [
          deploymentRuntimeId(input.context),
          input.context.deployableId,
          input.context.sourceId,
          input.context.deploymentId,
          input.imageTag,
          input.context.currentRelease?.containerName ?? "",
          JSON.stringify(app.container.volumes ?? []),
          JSON.stringify(input.context.previousSourceIds ?? []),
        ],
        { ...outputHandlers, signal: input.signal, timeoutMs: 1_800_000 },
      ),
  });
}

export function deploymentVolumeArguments(context: DeploymentExecutionContext) {
  return JSON.stringify(
    appVolumeMounts(context.app as NormalizedApp, deploymentRuntimeId(context)),
  );
}
