import { readOnlyHostLogVolumePython } from "./host-log-collection.js";

export const logDiscoveryScript = String.raw`#!/usr/bin/python3
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request

STATE = Path("/var/lib/towbar-logs")
CONFIG = Path("/etc/towbar-logs/config.json")
NAME = "towbar-log-collector"

${readOnlyHostLogVolumePython}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None

def docker(*arguments):
    result = subprocess.run(["/usr/bin/docker", *arguments], capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError("Docker log discovery operation failed")
    return result.stdout.strip()

def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, separators=(",", ":"), sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)

def discover():
    data_root = Path(docker("info", "--format", "{{.DockerRootDir}}")).resolve(strict=True)
    if data_root == Path("/") or any(character in str(data_root) for character in (",", "\n", "\r")):
        raise RuntimeError("Unsafe Docker data-root")
    directories = data_root / "containers"
    if directories.is_symlink() or not directories.is_dir():
        raise RuntimeError("Docker log directory is unavailable")
    ids = docker("ps", "--all", "--filter", "label=towbar.managed=true", "--format", "{{.ID}}").splitlines()
    containers = json.loads(docker("inspect", *ids[:512])) if ids else []
    sources = []
    unsupported = max(0, len(ids) - 512)
    for container in containers[:512]:
        labels = container.get("Config", {}).get("Labels") or {}
        identifier = container["Id"]
        workload = labels.get("towbar.deployable", "")
        if not re.fullmatch(r"[a-f0-9]{64}", identifier) or not re.fullmatch(r"[a-f0-9-]{36}", workload):
            continue
        expected = directories / identifier / (identifier + "-json.log")
        log_path = Path(container.get("LogPath") or "/nonexistent")
        driver = container.get("HostConfig", {}).get("LogConfig", {}).get("Type")
        if driver != "json-file" or log_path != expected or log_path.is_symlink():
            unsupported += 1
            continue
        if not log_path.exists():
            continue
        sources.append({"containerId": identifier, "workloadId": workload,
            "deploymentId": labels.get("towbar.deployment") or None,
            "previewId": labels.get("towbar.preview") or None,
            "service": labels.get("towbar.compose.service", "")})
    return directories, sorted(sources, key=lambda item: item["containerId"]), unsupported

def stop():
    names = docker("ps", "--all", "--filter", "name=^/" + NAME + "$", "--format", "{{.Names}}")
    if names == NAME:
        labels = json.loads(docker("inspect", "--format", "{{json .Config.Labels}}", NAME)) or {}
        if labels.get("towbar.component") != "log-collector" or labels.get("towbar.managed") != "true":
            raise RuntimeError("Collector name belongs to an unrelated container")
        docker("stop", "--time", "20", NAME)
        docker("rm", NAME)

def run_collector(settings, directory, configuration):
    path = STATE / "collector.json"
    serialized = json.dumps(configuration, separators=(",", ":"), sort_keys=True)
    digest = hashlib.sha256((str(directory) + "\n" + serialized).encode()).hexdigest()
    previous = (STATE / "configuration.sha256").read_text() if (STATE / "configuration.sha256").exists() else ""
    running = docker("ps", "--filter", "name=^/" + NAME + "$", "--format", "{{.Names}}")
    if digest == previous and running == NAME:
        return
    stop()
    log_volume = "towbar-log-collector-source"
    ensure_read_only_host_log_volume(log_volume, directory, {"towbar.managed": "true", "towbar.storage": "host-logs", "towbar.component": "log-collector", "towbar.server": settings["serverId"]})
    atomic_json(path, configuration)
    docker("run", "--detach", "--name", NAME, "--restart", "unless-stopped",
        "--label", "towbar.managed=true", "--label", "towbar.component=log-collector",
        "--user", "0:0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--read-only", "--memory", "256m", "--cpus", "0.25", "--pids-limit", "64",
        "--log-driver", "local", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
        "--mount", "type=volume,src=" + log_volume + ",dst=/var/lib/docker/containers,readonly,volume-nocopy",
        "--mount", "type=bind,src=" + str(STATE) + ",dst=/var/lib/towbar-logs",
        "--mount", "type=bind,src=" + str(path) + ",dst=/etc/towbar-collector.json,readonly",
        settings["image"], "--config=/etc/towbar-collector.json")
    (STATE / "configuration.sha256").write_text(digest)

def main():
    settings = json.loads(CONFIG.read_text())
    opener = urllib.request.build_opener(NoRedirect())
    seen_path = STATE / "seen.json"
    seen = set(json.loads(seen_path.read_text())) if seen_path.exists() else None
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if STATE.is_symlink() or STATE.stat().st_uid != 0 or STATE.stat().st_mode & 0o022:
        raise RuntimeError("Collector state must be a root-owned private directory")
    while True:
        try:
            directory, sources, unsupported = discover()
            for source in sources:
                source["startAt"] = "end" if seen is None or source["containerId"] in seen else "beginning"
            queue_bytes = sum(path.stat().st_size for path in (STATE / "queue").rglob("*") if path.is_file()) if (STATE / "queue").exists() else 0
            report = {"sources": sources, "unsupportedContainers": unsupported, "queueBytes": min(queue_bytes, 1073741824),
                "droppedRecords": 0, "version": settings["version"]}
            request = urllib.request.Request(settings["endpoint"] + "/sources", data=json.dumps(report).encode(),
                headers={"Authorization": "Bearer " + settings["token"], "X-Towbar-Server": settings["serverId"], "Content-Type": "application/json"})
            with opener.open(request, timeout=20) as response:
                data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise RuntimeError("Collector configuration exceeded its limit")
            result = json.loads(data)
            configuration = result["configuration"]
            if queue_bytes > 536870912:
                configuration["receivers"] = {"filelog/idle": {"include": ["/var/lib/docker/containers/__towbar_no_sources__.log"], "storage": "file_storage/checkpoints"}}
                configuration["service"]["pipelines"]["logs"]["receivers"] = ["filelog/idle"]
            run_collector(settings, directory, configuration)
            seen = set(result["allowedContainerIds"])
            atomic_json(seen_path, sorted(seen))
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                stop()
                raise SystemExit(77)
            print("Log collection control plane is unavailable", flush=True)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            print("Log discovery needs attention", flush=True)
        time.sleep(15)

if __name__ == "__main__":
    main()
`;
