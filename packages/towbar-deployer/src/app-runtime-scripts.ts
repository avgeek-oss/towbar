import { drainCentralizedLogsShell } from "./log-drain.js";
import { containerRuntimeArgumentsScript } from "./container-runtime.js";
import {
  dockerNetworkLockScript,
  validateNetworkAliasScript,
} from "./network-alias-scripts.js";
import { hostLogRuntimeArgumentsScript } from "./host-log-collection.js";

export const startRemoteScript = String.raw`
set -euo pipefail
${drainCentralizedLogsShell}
remote_dir="$1"
container_name="$2"
image_tag="$3"
container_port="$4"
network_name="$5"
resource_cpus="$6"
resource_memory="$7"
network_alias="${"$"}{8:-}"
previous_container="${"$"}{9:-}"
${dockerNetworkLockScript}
towbar_drain_logs "$container_name"; docker rm -f "$container_name" >/dev/null 2>&1 || true
${validateNetworkAliasScript}
if test -n "$network_alias"; then
  # An alias has one live owner. Stop the prior release before attaching the
  # candidate; rollback restarts it if startup or health validation fails.
  if test -n "$previous_container" && docker container inspect "$previous_container" >/dev/null 2>&1; then
    docker stop "$previous_container" >/dev/null
  fi
fi
runtime_args=()
if test -n "$network_name"; then runtime_args+=(--network "$network_name"); fi
if test -n "$network_alias"; then runtime_args+=(--network-alias "$network_alias"); fi
if test -n "$resource_cpus"; then runtime_args+=(--cpus "$resource_cpus"); fi
if test -n "$resource_memory"; then runtime_args+=(--memory "$resource_memory"); fi
/usr/bin/python3 - "$remote_dir/secrets/runtime" "$container_name" "$container_port" "${"$"}{TOWBAR_HOST_LOG_COLLECTION:-false}" \
  /usr/bin/docker run -d "${"$"}{runtime_args[@]}" \
  --name "$container_name" \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  --env "SOURCE_COMMIT=$TOWBAR_COMMIT_SHA" \
  --env "TOWBAR_APP_ID=$TOWBAR_APP_ID" \
  --env "TOWBAR_COMMIT_SHA=$TOWBAR_COMMIT_SHA" \
  --env "TOWBAR_DEPLOYMENT_ID=$TOWBAR_DEPLOYMENT_ID" \
  --label "towbar.managed=true" \
  --label "towbar.app=$TOWBAR_APP_ID" \
  --label "towbar.deployable=$TOWBAR_DEPLOYABLE_ID" \
  --label "towbar.source=$TOWBAR_SOURCE_ID" \
  --label "towbar.deployment=$TOWBAR_DEPLOYMENT_ID" \
  --label "towbar.host-port=__TOWBAR_HOST_PORT__" \
  -p "__TOWBAR_PUBLISH__" \
  "$image_tag" <<'PYTHON' >/dev/null
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys

runtime_directory = Path(sys.argv[1])
container_name = sys.argv[2]
container_port = sys.argv[3]
host_log_collection = sys.argv[4] == "true"
runtime_identity = {key: os.environ[key] for key in ("TOWBAR_APP_ID", "TOWBAR_SOURCE_ID", "TOWBAR_DEPLOYABLE_ID")}
command = sys.argv[5:]
runtime_arguments: list[str] = json.loads(os.environ.get("TOWBAR_VOLUME_ARGS_JSON", "[]"))
for option in runtime_arguments[1::2]:
    volume_name = next(part[4:] for part in option.split(",") if part.startswith("src="))
    inspected = subprocess.run(["/usr/bin/docker", "volume", "inspect", volume_name], capture_output=True, text=True)
    if inspected.returncode:
        raise SystemExit("Persistent volume is missing before startup: " + volume_name)
    labels = json.loads(inspected.stdout)[0].get("Labels") or {}
    if any(labels.get(key) != value for key, value in {
        "towbar.managed": "true", "towbar.storage": "app",
        "towbar.runtime": os.environ["TOWBAR_APP_ID"],
        "towbar.deployable": os.environ["TOWBAR_DEPLOYABLE_ID"],
    }.items()) or labels.get("towbar.source") not in {os.environ["TOWBAR_SOURCE_ID"], *json.loads(os.environ.get("TOWBAR_PREVIOUS_SOURCE_IDS_JSON", "[]"))}:
        raise SystemExit("Persistent volume ownership changed before startup")

${containerRuntimeArgumentsScript}

for secret_path in sorted(runtime_directory.iterdir()):
    if not secret_path.is_file():
        continue
    if host_log_collection and secret_path.name in {"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"}:
        raise SystemExit("Host log collectors cannot override Docker connection settings through runtime secrets")
    os.environ[secret_path.name] = secret_path.read_text(encoding="utf-8")
    runtime_arguments.extend(("--env", secret_path.name))

${hostLogRuntimeArgumentsScript}

# Docker records an anonymous loopback publication with an empty HostPort and
# may assign a different port when it restarts the container. Caddy would then
# retain the obsolete upstream. Select an explicit port instead so the binding
# remains stable for the lifetime of the container, including restarts.
port_minimum = 20_000
port_count = 10_000
seed = int.from_bytes(
    hashlib.sha256(os.environ["TOWBAR_DEPLOYABLE_ID"].encode()).digest()[:4],
    "big",
)
retryable_errors = (
    "address already in use",
    "port is already allocated",
)

for offset in range(port_count):
    host_port = port_minimum + ((seed + offset) % port_count)
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", host_port))
    except OSError:
        probe.close()
        continue
    probe.close()

    publish = f"127.0.0.1:{host_port}:{container_port}"
    candidate_command = [
        argument
        .replace("__TOWBAR_HOST_PORT__", str(host_port))
        .replace("__TOWBAR_PUBLISH__", publish)
        for argument in command
    ]
    candidate_command[3:3] = runtime_arguments
    result = subprocess.run(
        candidate_command,
        check=False,
        env=os.environ,
        stderr=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    if result.returncode == 0:
        sys.stdout.write(result.stdout)
        raise SystemExit(0)

    error = result.stderr.strip()
    if not any(fragment in error.lower() for fragment in retryable_errors):
        if error:
            print(error, file=sys.stderr)
        raise SystemExit(result.returncode)

    subprocess.run(
        ["/usr/bin/docker", "rm", "-f", container_name],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

raise SystemExit("Towbar could not allocate a stable loopback host port")
PYTHON
docker port "$container_name" "$container_port/tcp" | awk -F: 'NR==1 {print $NF}'
`;
