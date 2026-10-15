export const logDrainScript = String.raw`#!/usr/bin/python3
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONFIG = Path("/etc/towbar-logs/config.json")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None

def docker(*args):
    result = subprocess.run(["/usr/bin/docker", *args], check=True, capture_output=True, text=True, timeout=4)
    return result.stdout.strip()

def record_identity(identifier, line, offset):
    record = json.loads(line)
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)", record["time"])
    if not match or record.get("stream") not in ("stdout", "stderr"):
        raise ValueError("Unsupported Docker timestamp or stream")
    seconds = int(datetime.datetime.fromisoformat(match[1] + match[3].replace("Z", "+00:00")).timestamp())
    timestamp = str(seconds * 1000000000 + int((match[2] or "").ljust(9, "0")))
    return hashlib.sha256(json.dumps([identifier, timestamp, record["stream"], str(offset)], separators=(",", ":")).encode()).hexdigest()

def final_record(name):
    values = json.loads(docker("inspect", name))
    if not values: return None
    container = values[0]
    labels = container.get("Config", {}).get("Labels") or {}
    if labels.get("towbar.managed") != "true" or not labels.get("towbar.deployable"):
        return None
    if container.get("HostConfig", {}).get("LogConfig", {}).get("Type") != "json-file":
        return None
    identifier = container["Id"]
    if not re.fullmatch(r"[a-f0-9]{64}", identifier): raise ValueError("Invalid container identity")
    root = Path(docker("info", "--format", "{{.DockerRootDir}}")).resolve(strict=True)
    directory = root / "containers" / identifier
    log = directory / (identifier + "-json.log")
    if root == Path("/") or directory.is_symlink() or log.is_symlink() or str(log) != container.get("LogPath"):
        raise ValueError("Unsupported Docker log path")
    if container.get("State", {}).get("Running"):
        docker("stop", "--time", "2", name)
    with log.open("rb") as source:
        size = source.seek(0, 2)
        start = max(0, size - 1048576)
        source.seek(start)
        lines = source.read(1048576).splitlines(keepends=True)
    while lines and not lines[-1].strip(): lines.pop()
    if not lines: return None
    offset = start + sum(len(line) for line in lines[:-1])
    return record_identity(identifier, lines[-1], offset)

def main(names):
    if not CONFIG.is_file(): return 0
    settings = json.loads(CONFIG.read_text())
    deadline = time.monotonic() + 6
    wanted = {value for name in names[:128] if (value := final_record(name))}
    if not wanted: return 0
    opener = urllib.request.build_opener(NoRedirect())
    while time.monotonic() < deadline:
        request = urllib.request.Request(settings["endpoint"] + "/drain", data=json.dumps({"eventIds": sorted(wanted)}).encode(),
            headers={"Authorization": "Bearer " + settings["token"], "X-Towbar-Server": settings["serverId"], "Content-Type": "application/json"})
        try:
            with opener.open(request, timeout=min(1, max(0.1, deadline - time.monotonic()))) as response:
                body = response.read(16385)
            if len(body) > 16384: return 1
            if wanted.issubset(set(json.loads(body)["acceptedEventIds"])): return 0
        except urllib.error.HTTPError as error:
            if error.code in (401, 403): return 1
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.2)
    return 1

if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        raise SystemExit(1)
`;

export const drainCentralizedLogsShell = String.raw`
towbar_drain_logs() {
  test -f /usr/local/lib/towbar-logs/drain.py || return 0
  if ! declare -p TOWBAR_LOG_DRAIN_DEADLINE >/dev/null 2>&1; then
    TOWBAR_LOG_DRAIN_DEADLINE=$((SECONDS + 8))
  fi
  local remaining=$((TOWBAR_LOG_DRAIN_DEADLINE - SECONDS))
  local command=(python3)
  if test "$(id -u)" != 0; then command=(sudo -n python3); fi
  if test "$remaining" -le 0 || ! timeout "$remaining" "${"$"}{command[@]}" /usr/local/lib/towbar-logs/drain.py "$1"; then
    printf "Centralized logs could not confirm the final record before container cleanup.\n" >&2
  fi
  return 0
}
`;
