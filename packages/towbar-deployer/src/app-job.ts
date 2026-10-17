import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appJobResultSchema,
  isNormalizedCompose,
  isNormalizedResource,
} from "@workspace/towbar-core";
import { appVolumeMounts } from "./app-storage.js";
import { redactSensitiveValues } from "./secrets.js";
import type { SshSession } from "./ssh.js";
import type {
  ResourceOperationExecutionContext,
  ResourceOperationSecrets,
} from "./types.js";

export const appJobRemoteScript = String.raw`
set -euo pipefail
exec python3 - "$@" <<'PYTHON'
import json, os, signal, subprocess, sys, time, selectors, socket, http.client, fcntl, tempfile
from urllib.parse import unquote, urlencode
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
job = payload["job"]
name = "towbar-job-" + payload["operationId"]
created = False

def run(*args):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Docker job operation failed")
    return result.stdout

def owned(labels):
    return (labels.get("towbar.managed") == "true" and
            labels.get("towbar.deployable") == payload["appId"] and
            labels.get("towbar.source") in {payload["sourceId"], *payload.get("previousSourceIds", [])})

def cancelled(signum, frame):
    raise SystemExit("Job execution interrupted")

for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(signum, cancelled)

lock_directory = Path(tempfile.gettempdir()) / ("towbar-jobs-" + payload["appId"])
lock_directory.mkdir(mode=0o700, exist_ok=True)
if lock_directory.is_symlink() or lock_directory.stat().st_uid != os.getuid():
    raise RuntimeError("Job lock directory ownership mismatch")
lock = os.open(str(lock_directory / (job["name"] + ".lock")), os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

release = json.loads(run("inspect", payload["containerName"]))[0]
if not owned(release.get("Config", {}).get("Labels") or {}) or not release.get("State", {}).get("Running"):
    raise RuntimeError("The app must be running and owned by this environment")
if (release.get("Config", {}).get("Labels") or {}).get("towbar.app") != payload["appId"]:
    raise RuntimeError("The current release does not belong to this app environment")
active = run("ps", "-q", "--filter", "label=towbar.deployable=" + payload["appId"],
             "--filter", "label=towbar.job=" + job["name"])
if active.strip():
    raise RuntimeError("A previous execution of this job is still running on the server")
for mount in payload["mounts"][1::2]:
    volume_name = next(part[4:] for part in mount.split(",") if part.startswith("src="))
    volume = json.loads(run("volume", "inspect", volume_name))[0]
    labels = volume.get("Labels") or {}
    if not owned(labels) or labels.get("towbar.runtime") != payload["appId"] or labels.get("towbar.storage") != "app":
        raise RuntimeError("Persistent volume ownership changed before job execution")

# Send environment values in the local Engine API request body. They never
# become host process environment variables or command-line arguments.
endpoint = json.loads(run("context", "inspect"))[0]["Endpoints"]["docker"]["Host"]
if not endpoint.startswith("unix://"):
    raise RuntimeError("Scheduled jobs require the server's local Docker socket")
class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect(unquote(endpoint[7:]))

config = json.loads(run("image", "inspect", payload["imageTag"]))[0]["Config"]
environment = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
environment.update(payload["runtime"])
for value in release.get("Config", {}).get("Env", []):
    key, _, content = value.partition("=")
    if key in ("SOURCE_COMMIT", "TOWBAR_COMMIT_SHA", "TOWBAR_DEPLOYMENT_ID"):
        environment[key] = content
environment.update({"TOWBAR_APP_ID": payload["appId"], "TOWBAR_JOB": job["name"], "TOWBAR_JOB_RUN_ID": payload["operationId"]})
mounts = []
for value in payload["mounts"][1::2]:
    parts = dict(part.split("=", 1) for part in value.split(",") if "=" in part)
    mounts.append({"Type": "volume", "Source": parts["src"], "Target": parts["dst"], "VolumeOptions": {"NoCopy": True}})
config.update({"Image": payload["imageTag"], "Cmd": job["command"], "Env": [k + "=" + v for k, v in environment.items()],
               "Labels": {"towbar.managed": "true", "towbar.source": payload["sourceId"], "towbar.deployable": payload["appId"],
                          "towbar.job": job["name"], "towbar.operation": payload["operationId"]},
               "HostConfig": {"RestartPolicy": {"Name": "no"}, "Mounts": mounts,
                              "LogConfig": {"Type": "json-file", "Config": {"max-size": "5m", "max-file": "1"}},
                              "ExtraHosts": ["host.docker.internal:host-gateway"]}})
config.pop("Healthcheck", None)
if payload.get("network"):
    config["HostConfig"]["NetworkMode"] = payload["network"]
if payload.get("resources"):
    config["HostConfig"]["NanoCpus"] = int(payload["resources"]["cpus"] * 1_000_000_000)
    # Docker accepts memory strings at its CLI. Parse them without a shell.
    import re
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([bkmg])", payload["resources"]["memory"].lower())
    if not match:
        raise RuntimeError("Invalid memory limit")
    config["HostConfig"]["Memory"] = int(float(match[1]) * {"b": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[match[2]])
try:
    engine = DockerConnection("localhost")
    version = run("version", "--format", "{{.Server.APIVersion}}").strip()
    engine.request("POST", "/v" + version + "/containers/create?" + urlencode({"name": name}), json.dumps(config), {"Content-Type": "application/json"})
    response = engine.getresponse()
    body = response.read()
    engine.close()
    if response.status != 201:
        raise RuntimeError("Unable to create job container: " + str(response.status))
    created = True
    child = subprocess.Popen(["docker", "start", "-a", name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    output = bytearray()
    limit = 256 * 1024
    truncated = False
    timed_out = False
    deadline = time.monotonic() + job["timeoutSeconds"]
    while selector.get_map():
        if time.monotonic() >= deadline:
            if timed_out:
                raise RuntimeError("Unable to collect output after the job time limit")
            timed_out = True
            subprocess.run(["docker", "kill", name], capture_output=True, timeout=15)
            deadline = time.monotonic() + 30
        for key, _ in selector.select(0.2):
            content = os.read(key.fileobj.fileno(), 65536)
            if not content:
                selector.unregister(key.fileobj)
            else:
                remaining = limit - len(output)
                output.extend(content[:remaining])
                truncated = truncated or len(content) > remaining
    child.wait(timeout=10)
    state = json.loads(run("inspect", name))[0]["State"]
    text = output.decode("utf-8", errors="ignore")
    # Truncated output can end part-way through a credential. Remove matching
    # prefixes before redacting complete values, including multiline secrets.
    secrets = sorted([v for v in payload["runtime"].values() if v], key=len, reverse=True)
    if truncated:
        for secret in secrets:
            candidate = secret + "\0" + text[-len(secret):]
            prefixes = [0] * len(candidate)
            for index in range(1, len(candidate)):
                matched = prefixes[index - 1]
                while matched and candidate[index] != candidate[matched]:
                    matched = prefixes[matched - 1]
                if candidate[index] == candidate[matched]:
                    matched += 1
                prefixes[index] = matched
            length = prefixes[-1]
            if length:
                text = text[:-length] + "[REDACTED]"
    for secret in secrets:
        text = text.replace(secret, "[REDACTED]")
    print(json.dumps({"jobName": job["name"], "exitCode": state["ExitCode"], "timedOut": timed_out,
                      "logs": text[:limit], "truncated": truncated or len(text) > limit}))
finally:
    if created:
        subprocess.run(["docker", "rm", "-f", "-v", name], capture_output=True, timeout=30)
PYTHON
`;

export async function executeAppJob(input: {
  context: ResourceOperationExecutionContext;
  secrets: ResourceOperationSecrets;
  session: SshSession;
  localDirectory: string;
  remoteDirectory: string;
  signal?: AbortSignal;
}) {
  const { context } = input;
  if (
    context.request.type !== "run_job" ||
    !context.deployable ||
    isNormalizedResource(context.deployable) ||
    isNormalizedCompose(context.deployable) ||
    !context.currentRelease ||
    !context.deployableId ||
    !context.sourceId
  )
    throw new Error("A deployed app is required to execute a job");
  const payload = {
    job: context.request.job,
    operationId: context.operationId,
    appId: context.deployableId,
    sourceId: context.sourceId,
    previousSourceIds: context.previousSourceIds ?? [],
    containerName: context.currentRelease.containerName,
    imageTag: context.currentRelease.imageTag,
    mounts: appVolumeMounts(context.deployable, context.deployableId),
    network: context.deployable.container.network,
    resources: context.deployable.container.resources,
    runtime: input.secrets.runtime,
  };
  const localPath = path.join(input.localDirectory, "job.json");
  await writeFile(localPath, JSON.stringify(payload), { mode: 0o600 });
  await input.session.run('install -d -m 700 "$1"', [input.remoteDirectory], {
    signal: input.signal,
  });
  await input.session.upload(localPath, `${input.remoteDirectory}/job.json`, {
    signal: input.signal,
  });
  const { stdout } = await input.session.run(
    appJobRemoteScript,
    [`${input.remoteDirectory}/job.json`],
    {
      signal: input.signal,
      timeoutMs: (context.request.job.timeoutSeconds + 60) * 1_000,
    },
  );
  const result = appJobResultSchema.parse(JSON.parse(stdout));
  result.logs = redactSensitiveValues(
    result.logs,
    input.secrets.sensitiveValues,
  );
  if (result.exitCode !== 0 || result.timedOut) {
    throw Object.assign(
      new Error(
        result.timedOut
          ? "Job exceeded its time limit"
          : `Job exited with code ${result.exitCode}`,
      ),
      { jobResult: result },
    );
  }
  return result;
}
