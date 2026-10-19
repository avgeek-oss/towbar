import { drainCentralizedLogsShell } from "./log-drain.js";
import { domainRoutingPython } from "./domain-routing.js";
import { containerRuntimeArgumentsScript } from "./container-runtime.js";
/* eslint-disable max-lines -- Remote scripts are kept with their shared shell-safety primitives so quoting rules cannot drift. */
import {
  dockerNetworkLockScript,
  validateNetworkAliasScript,
} from "./network-alias-scripts.js";
import { reclaimHostLogVolumeScript } from "./host-log-collection.js";
import { maintainBuildkitCacheScript } from "./buildkit-cache.js";

export { startRemoteScript } from "./app-runtime-scripts.js";

const maintainBuildCacheScript = String.raw`
cache_state=/var/lib/towbar/build-cache
cache_budget_bytes=21474836480
sudo install -d -m 0755 -o "$(id -u)" -g "$(id -g)" "$cache_state"
remove_cache_scope() {
  local scope="$1"
  docker image rm "towbar/build-cache-$scope:current" >/dev/null 2>&1 || true
  docker volume rm \
    "towbar-build-$scope-build" \
    "towbar-build-$scope-launch" >/dev/null 2>&1 || true
  rm -f -- "$cache_state/$scope"
}
cache_usage_bytes() {
  local total=0 marker scope image_size volume mountpoint volume_size
  for marker in "$cache_state"/*; do
    test -f "$marker" || continue
    scope="$(basename "$marker")"
    if ! grep -Eq '^[a-f0-9]{32}$' <<<"$scope"; then continue; fi
    image_size="$(docker image inspect --format '{{.Size}}' "towbar/build-cache-$scope:current" 2>/dev/null || printf 0)"
    case "$image_size" in ''|*[!0-9]*) image_size=0;; esac
    total=$((total + image_size))
    for volume in "towbar-build-$scope-build" "towbar-build-$scope-launch"; do
      mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "$volume" 2>/dev/null || true)"
      test -n "$mountpoint" || continue
      volume_size="$(sudo du -sb "$mountpoint" 2>/dev/null | awk '{print $1}' || true)"
      case "$volume_size" in ''|*[!0-9]*) volume_size=0;; esac
      total=$((total + volume_size))
    done
  done
  printf '%s' "$total"
}
if test "$cache_enabled" = true; then
  printf '%s\n' "$TOWBAR_COMMIT_SHA" >"$cache_state/$cache_scope"
else
  remove_cache_scope "$cache_scope"
fi
find "$cache_state" -maxdepth 1 -type f -mmin +43200 -print0 | while IFS= read -r -d '' marker; do
  stale_scope="$(basename "$marker")"
  if ! grep -Eq '^[a-f0-9]{32}$' <<<"$stale_scope"; then
    rm -f -- "$marker"
    continue
  fi
  remove_cache_scope "$stale_scope"
done
docker image prune -f --filter label=towbar.build-cache=true --filter until=720h >/dev/null 2>&1 || true
cache_usage="$(cache_usage_bytes)"
if test "$cache_usage" -gt "$cache_budget_bytes"; then
  while read -r _ cache_candidate; do
    test -n "$cache_candidate" || continue
    remove_cache_scope "$cache_candidate"
    cache_usage="$(cache_usage_bytes)"
    test "$cache_usage" -le "$cache_budget_bytes" && break
  done < <(find "$cache_state" -maxdepth 1 -type f -printf '%T@ %f\n' | sort -n)
fi
`;

const configureDockerBuildCacheScript = String.raw`
cache_image="towbar/build-cache-$cache_scope:current"
cache_marker="/var/lib/towbar/build-cache/$cache_scope"
cached_commit="$(cat "$cache_marker" 2>/dev/null || true)"
cache_mode=disabled
if test "$cache_enabled" = true; then
  build_args+=(--build-arg BUILDKIT_INLINE_CACHE=1)
  if test "$cached_commit" = "$TOWBAR_COMMIT_SHA" && docker image inspect "$cache_image" >/dev/null 2>&1; then
    build_args+=(--cache-from "$cache_image")
    cache_mode=reuse
  else
    build_args+=(--no-cache)
    cache_mode=clean
  fi
else
  build_args+=(--no-cache)
fi
context_digest="$(tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -cf - -C "$remote_dir/context" . | sha256sum | awk '{print $1}')"
`;

export const prepareRemoteScript = String.raw`
set -euo pipefail
remote_dir="$1"
install -d -m 700 \
  "$remote_dir" \
  "$remote_dir/secrets/build" \
  "$remote_dir/secrets/hooks/postDeploy" \
  "$remote_dir/secrets/hooks/preDeploy" \
  "$remote_dir/secrets/runtime"
`;

export const buildRemoteScript = String.raw`
set -euo pipefail
remote_dir="$1"
image_tag="$2"
dockerfile="$3"
max_expanded_bytes="$4"
max_archive_entries="$5"
build_arguments_json="$6"
build_cpus="$7"
build_memory="$8"
target="$9"
architecture="${"$"}{10}"
cache_enabled="${"$"}{11}"
cache_scope="${"$"}{12}"
${maintainBuildkitCacheScript}
rm -rf "$remote_dir/context"
install -d -m 700 "$remote_dir/context"
expanded_bytes="$(gzip -cd "$remote_dir/context.tar.gz" | wc -c)"
test "$expanded_bytes" -le "$max_expanded_bytes"
archive_entries="$(tar -tzf "$remote_dir/context.tar.gz" | wc -l)"
test "$archive_entries" -le "$max_archive_entries"
tar -xzf "$remote_dir/context.tar.gz" \
  --no-same-owner --no-same-permissions -C "$remote_dir/context"
build_args=()
mapfile -t ordinary_build_args < <(python3 - "$build_arguments_json" <<'PYTHON'
import json, sys
for key, value in sorted(json.loads(sys.argv[1]).items()): print(f"{key}={value}")
PYTHON
)
for argument in "${"$"}{ordinary_build_args[@]}"; do build_args+=(--build-arg "$argument"); done
for secret_path in "$remote_dir"/secrets/build/*; do
  test -e "$secret_path" || continue
  secret_id="$(basename "$secret_path")"
  build_args+=(--secret "id=$secret_id,src=$secret_path")
done
if test -n "$target"; then build_args+=(--target "$target"); fi
if test -n "$architecture"; then build_args+=(--platform "linux/$architecture"); fi
${configureDockerBuildCacheScript}
tar -cf - -C "$remote_dir/context" . | docker buildx build --builder default --load "${"$"}{build_args[@]}" \
  --resource "cpu-quota=$(python3 -c 'import sys; print(round(float(sys.argv[1]) * 100000))' "$build_cpus")" \
  --resource "memory=$build_memory" \
  --label "towbar.managed=true" \
  --label "towbar.app=$TOWBAR_APP_ID" \
  --label "towbar.deployable=$TOWBAR_DEPLOYABLE_ID" \
  --label "towbar.source=$TOWBAR_SOURCE_ID" \
  --label "towbar.commit=$TOWBAR_COMMIT_SHA" \
  --label "towbar.build-cache-mode=$cache_mode" \
  --label "towbar.context-digest=$context_digest" \
  --label towbar.build-cache=true \
  -f "$dockerfile" \
  -t "$image_tag" \
  -
if test "$cache_enabled" = true; then docker image tag "$image_tag" "$cache_image"; fi
${maintainBuildCacheScript}
`;

export const pullApplicationImageRemoteScript = String.raw`
set -euo pipefail
source_image="$1"
image_tag="$2"
pull_policy="$3"
platform="$4"
remote_dir="$5"
registry_server="$6"
if test -n "$registry_server"; then
  cat "$remote_dir/secrets/registry/password" | docker login "$registry_server" --username "$(cat "$remote_dir/secrets/registry/username")" --password-stdin >/dev/null
  trap 'docker logout "$registry_server" >/dev/null 2>&1 || true' EXIT
fi
pull_args=()
if test -n "$platform"; then pull_args+=(--platform "$platform"); fi
if test "$pull_policy" = always || ! docker image inspect "$source_image" >/dev/null 2>&1; then
  docker pull "${"$"}{pull_args[@]}" "$source_image"
fi
resolved="$(docker image inspect --format '{{.Id}}' "$source_image")"
test -n "$resolved"
docker image tag "$source_image" "$image_tag"
`;

export const staticBuildRemoteScript = String.raw`
set -euo pipefail
remote_dir="$1"
image_tag="$2"
output_path="$3"
port="$4"
node_image="$5"
runtime_image="$6"
build_command_json="$7"
spa_fallback="$8"
index_file="$9"
error_page="${"$"}{10}"
headers_json="${"$"}{11}"
max_expanded_bytes="${"$"}{12}"
max_archive_entries="${"$"}{13}"
build_arguments_json="${"$"}{14}"
build_cpus="${"$"}{15}"
build_memory="${"$"}{16}"
architecture="${"$"}{17}"
cache_enabled="${"$"}{18}"
cache_scope="${"$"}{19}"
${maintainBuildkitCacheScript}
rm -rf "$remote_dir/context"
install -d -m 700 "$remote_dir/context"
expanded_bytes="$(gzip -cd "$remote_dir/context.tar.gz" | wc -c)"
test "$expanded_bytes" -le "$max_expanded_bytes"
archive_entries="$(tar -tzf "$remote_dir/context.tar.gz" | wc -l)"
test "$archive_entries" -le "$max_archive_entries"
tar -xzf "$remote_dir/context.tar.gz" --no-same-owner --no-same-permissions -C "$remote_dir/context"
python3 - "$remote_dir/context" "$output_path" <<'PYTHON'
import json
import re
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve(strict=True)
output = (root / sys.argv[2]).resolve()
if root != output and root not in output.parents:
    raise SystemExit("Static output escaped the build context")
PYTHON
mapfile -t build_command < <(python3 - "$build_command_json" <<'PYTHON'
import json
import sys
for argument in json.loads(sys.argv[1]): print(argument)
PYTHON
)
export TOWBAR_TARGET_ARCHITECTURE="$architecture"
if (( ${"#"}{build_command[@]} > 0 )); then
  python3 - "$remote_dir/secrets/build" "$remote_dir/context" "$node_image" "$build_arguments_json" "$build_cpus" "$build_memory" "${"$"}{build_command[@]}" <<'PYTHON'
import json
import os
from pathlib import Path
import sys

secret_directory, context, image, build_arguments_json, build_cpus, build_memory, *build_command = sys.argv[1:]
command = [
    "/usr/bin/docker", "run", "--rm",
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
    "--cpus", build_cpus,
    "--memory", build_memory,
    "--pids-limit", "512",
    "--mount", f"type=bind,src={context},dst=/workspace",
    "--workdir", "/workspace",
]
architecture = os.environ.get("TOWBAR_TARGET_ARCHITECTURE")
if architecture:
    command += ["--platform", "linux/" + architecture]
for key, value in sorted(json.loads(build_arguments_json).items()):
    os.environ[key] = value
    command += ["--env", key]
for secret in sorted(Path(secret_directory).iterdir()):
    if not secret.is_file() or secret.name == "TOWBAR_BUILD_ENV_JSON":
        continue
    os.environ[secret.name] = secret.read_text(encoding="utf-8")
    command += ["--env", secret.name]
command += [image, *build_command]
os.execve(command[0], command, os.environ)
PYTHON
fi
python3 - "$remote_dir/context" "$output_path" <<'PYTHON'
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve(strict=True)
output = (root / sys.argv[2]).resolve(strict=True)
if root != output and root not in output.parents:
    raise SystemExit("Static output escaped the build context")
if not output.is_dir() or output.is_symlink():
    raise SystemExit("Static output must be a directory inside the build context")
PYTHON
python3 - "$remote_dir/context" "$output_path" "$port" "$spa_fallback" "$index_file" "$error_page" "$headers_json" "$runtime_image" <<'PYTHON'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve(strict=True)
output = (root / sys.argv[2]).resolve(strict=True)
port, spa, index_file, error_page = sys.argv[3:7]
headers = json.loads(sys.argv[7])
runtime_image = sys.argv[8]
def nginx_quote(value):
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise SystemExit("Static Nginx values cannot contain control characters")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
    return '"' + escaped + '"'
lines = [
    "server {",
    f"  listen {int(port)};",
    "  server_name _;",
    "  root /usr/share/nginx/html;",
    f"  index {nginx_quote(index_file)};",
]
for name, value in sorted(headers.items()):
    if not re.fullmatch(r"[!#$%&'*+.^_\x60|~0-9A-Za-z-]+", name):
        raise SystemExit("Static header name is invalid")
    lines.append(f"  add_header {name} {nginx_quote(value)} always;")
if spa == "true":
    lines.append(f"  location / {{ try_files $uri $uri/ {nginx_quote('/' + index_file)}; }}")
if error_page:
    lines.append(f"  error_page 404 {nginx_quote('/' + error_page)};")
lines.append("}")
(root / ".towbar-nginx.conf").write_text("\\n".join(lines) + "\\n", encoding="utf-8")
(root / ".towbar-static.Dockerfile").write_text(
    f"FROM {runtime_image}\\n"
    "COPY --chown=101:101 " + json.dumps([output.relative_to(root).as_posix() + "/", "/usr/share/nginx/html/"]) + "\\n"
    "COPY --chown=101:101 [\".towbar-nginx.conf\", \"/etc/nginx/conf.d/default.conf\"]\\n",
    encoding="utf-8",
)
PYTHON
build_args=()
if test -n "$architecture"; then build_args+=(--platform "linux/$architecture"); fi
${configureDockerBuildCacheScript}
tar -cf - -C "$remote_dir/context" . | docker buildx build --builder default --load "${"$"}{build_args[@]}" \
  --resource "cpu-quota=$(python3 -c 'import sys; print(round(float(sys.argv[1]) * 100000))' "$build_cpus")" \
  --resource "memory=$build_memory" \
  --label "towbar.managed=true" \
  --label "towbar.app=$TOWBAR_APP_ID" \
  --label "towbar.deployable=$TOWBAR_DEPLOYABLE_ID" \
  --label "towbar.source=$TOWBAR_SOURCE_ID" \
  --label "towbar.commit=$TOWBAR_COMMIT_SHA" \
  --label "towbar.build-cache-mode=$cache_mode" \
  --label "towbar.context-digest=$context_digest" \
  --label towbar.build-cache=true \
  -f .towbar-static.Dockerfile \
  -t "$image_tag" -
if test "$cache_enabled" = true; then docker image tag "$image_tag" "$cache_image"; fi
${maintainBuildCacheScript}
`;

export const builderBuildRemoteScript = String.raw`
set -euo pipefail
remote_dir="$1"
image_tag="$2"
builder_type="$3"
tool_image="$4"
builder_image="$5"
build_command_json="$6"
start_command_json="$7"
architecture="$8"
cache_enabled="$9"
shift 9
buildpacks_json="$1"
build_arguments_json="$2"
max_expanded_bytes="$3"
max_archive_entries="$4"
build_cpus="$5"
build_memory="$6"
expected_version="$7"
config_file="$8"
cache_scope="$9"
${maintainBuildkitCacheScript}
rm -rf "$remote_dir/context"
install -d -m 700 "$remote_dir/context"
expanded_bytes="$(gzip -cd "$remote_dir/context.tar.gz" | wc -c)"
test "$expanded_bytes" -le "$max_expanded_bytes"
archive_entries="$(tar -tzf "$remote_dir/context.tar.gz" | wc -l)"
test "$archive_entries" -le "$max_archive_entries"
tar -xzf "$remote_dir/context.tar.gz" --no-same-owner --no-same-permissions -C "$remote_dir/context"
python3 - "$remote_dir/context" "$config_file" <<'PYTHON'
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve(strict=True)
value = sys.argv[2]
if value:
    candidate = (root / value).resolve(strict=True)
    if candidate == root or root not in candidate.parents or not candidate.is_file() or candidate.is_symlink():
        raise SystemExit("Builder configuration must be a regular file inside the build context")
PYTHON
python3 - "$remote_dir/context" "$buildpacks_json" <<'PYTHON'
import json
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve(strict=True)
for value in json.loads(sys.argv[2]):
    if not value.startswith("./"):
        continue
    candidate = (root / value).resolve(strict=True)
    if root not in candidate.parents or not candidate.is_dir() or candidate.is_symlink():
        raise SystemExit("Local buildpacks must be regular directories inside the build context")
PYTHON
if test "$builder_type" = buildpack && { test "$build_command_json" != '[]' || test "$start_command_json" != '[]'; }; then
  python3 - "$remote_dir/context/.towbar-command-buildpack" "$build_command_json" "$start_command_json" <<'PYTHON'
import json, os, shlex, sys
from pathlib import Path
directory = Path(sys.argv[1])
build = json.loads(sys.argv[2])
start = json.loads(sys.argv[3])
(directory / "bin").mkdir(parents=True, exist_ok=True)
(directory / "buildpack.toml").write_text(
    'api = "0.10"\n[buildpack]\nid = "com.towbar.command"\nname = "Towbar command"\nversion = "1.0.0"\n[[targets]]\nos = "linux"\n',
    encoding="utf-8",
)
(directory / "bin" / "detect").write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
lines = ["#!/usr/bin/env sh", "set -eu", 'layers_dir="$1"']
if build:
    lines.append(shlex.join(build))
if start:
    command, *arguments = start
    lines += [
        'cat >"$layers_dir/launch.toml" <<\'TOML\'',
        "[[processes]]",
        'type = "web"',
        "command = " + json.dumps(command),
        "args = " + json.dumps(arguments),
        "default = true",
        "TOML",
    ]
(directory / "bin" / "build").write_text("\n".join(lines) + "\n", encoding="utf-8")
os.chmod(directory / "bin" / "detect", 0o755)
os.chmod(directory / "bin" / "build", 0o755)
PYTHON
fi
if find "$remote_dir/secrets/build" -type f ! -name TOWBAR_BUILD_ENV_JSON -print -quit | grep -q .; then
  echo "Build secrets are not supported by this builder without a secret-safe adapter" >&2
  exit 65
fi
mapfile -t options < <(python3 - "$builder_type" "$image_tag" "$builder_image" "$build_command_json" "$start_command_json" "$architecture" "$cache_enabled" "$buildpacks_json" "$build_arguments_json" "$config_file" "$cache_scope" <<'PYTHON'
import json
import shlex
import sys

kind, image, builder, build_json, start_json, architecture, cache, packs_json, arguments_json, config_file, cache_scope = sys.argv[1:]
build_command = json.loads(build_json)
start_command = json.loads(start_json)
buildpacks = json.loads(packs_json)
arguments = json.loads(arguments_json)
options = []
if kind == "railpack":
    options = ["build", "--name", image, "--progress", "plain"]
    if architecture: options += ["--platform", "linux/" + architecture]
    if build_command: options += ["--build-cmd", shlex.join(build_command)]
    if start_command: options += ["--start-cmd", shlex.join(start_command)]
    if config_file: options += ["--config-file", "/workspace/" + config_file]
    if cache == "true": options += ["--cache-key", cache_scope]
    if cache != "true": options += ["--no-cache"]
    options += ["/workspace"]
elif kind == "nixpacks":
    options = ["build", "/workspace", "--name", image]
    if architecture: options += ["--platform", "linux/" + architecture]
    if build_command: options += ["--build-cmd", shlex.join(build_command)]
    if start_command: options += ["--start-cmd", shlex.join(start_command)]
    if config_file: options += ["--config", "/workspace/" + config_file]
    if cache == "true": options += ["--cache-key", cache_scope]
    if cache != "true": options += ["--no-cache"]
elif kind == "buildpack":
    options = ["build", image, "--path", "/workspace", "--builder", builder]
    if architecture: options += ["--platform", "linux/" + architecture]
    if config_file: options += ["--descriptor", "/workspace/" + config_file]
    for buildpack in buildpacks:
        options += ["--buildpack", "/workspace/" + buildpack if buildpack.startswith("./") else buildpack]
    if build_command or start_command:
        options += ["--post-buildpack", "/workspace/.towbar-command-buildpack"]
    for key, value in sorted(arguments.items()): options += ["--env", f"{key}={value}"]
    options += [
        "--cache", f"type=build;format=volume;name=towbar-build-{cache_scope}-build",
        "--cache", f"type=launch;format=volume;name=towbar-build-{cache_scope}-launch",
    ]
    if cache != "true": options += ["--clear-cache"]
else:
    raise SystemExit("Unsupported builder")
for option in options:
    print(option)
PYTHON
)
mapfile -t build_environment < <(python3 - "$build_arguments_json" <<'PYTHON'
import json, sys
for key, value in sorted(json.loads(sys.argv[1]).items()): print(f"{key}={value}")
PYTHON
)
environment_args=()
for value in "${"$"}{build_environment[@]}"; do environment_args+=(--env "$value"); done
entrypoint="$builder_type"
if test "$builder_type" = railpack; then entrypoint=/railpack; fi
if test "$builder_type" = buildpack; then entrypoint=pack; fi
if test -n "$expected_version"; then
  actual_version="$(docker run --rm --entrypoint "$entrypoint" "$tool_image" --version 2>&1)"
  python3 - "$expected_version" "$actual_version" <<'PYTHON'
import re, sys
expected, actual = sys.argv[1:]
tokens = re.findall(r"(?<![0-9A-Za-z])v?([0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)(?![0-9A-Za-z])", actual)
if expected.removeprefix("v") not in {token.removeprefix("v") for token in tokens}:
    raise SystemExit(f"Builder version mismatch: expected {expected}")
PYTHON
fi
cache_volumes=("towbar-build-$cache_scope-build" "towbar-build-$cache_scope-launch")
if test "$builder_type" = buildpack; then
  for cache_volume in "${"$"}{cache_volumes[@]}"; do
    docker volume create \
      --label towbar.managed=true \
      --label towbar.build-cache=true \
      --label "towbar.source=$TOWBAR_SOURCE_ID" \
      --label "towbar.deployable=$TOWBAR_DEPLOYABLE_ID" \
      "$cache_volume" >/dev/null
  done
  if test "$cache_enabled" != true; then
    cleanup_builder_cache() { docker volume rm -f "${"$"}{cache_volumes[@]}" >/dev/null 2>&1 || true; }
    trap 'cleanup_builder_cache; maintain_buildkit_cache' EXIT
  fi
fi
docker run --rm \
  "${"$"}{environment_args[@]}" \
  --network bridge \
  --read-only \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --cpus "$build_cpus" \
  --memory "$build_memory" \
  --pids-limit 512 \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount "type=bind,src=$remote_dir/context,dst=/workspace,readonly" \
  --entrypoint "$entrypoint" "$tool_image" "${"$"}{options[@]}"
docker image inspect "$image_tag" >/dev/null
${maintainBuildCacheScript}
`;

export const startResourceRemoteScript = String.raw`
set -euo pipefail
${drainCentralizedLogsShell}
remote_dir="$1"
container_name="$2"
image_tag="$3"
container_port="$4"
network_name="$5"
network_alias="$6"
host_port="$7"
resource_cpus="$8"
resource_memory="$9"
previous_container="${"$"}{10}"
deployable_id="${"$"}{11}"
volume_count="${"$"}{12}"
shift 12
${dockerNetworkLockScript}
towbar_drain_logs "$container_name"; docker rm -f "$container_name" >/dev/null 2>&1 || true
${validateNetworkAliasScript}
python3 - "$network_name" "$network_alias" "$host_port" "$previous_container" <<'PYTHON'
import json
import re
import socket
import subprocess
import sys

network_name, network_alias, host_port, previous_container = sys.argv[1:]

if host_port:
    version = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Version}}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    major = re.match(r"^(\d+)", version)
    if not major or int(major.group(1)) < 28:
        raise SystemExit(
            "SSH tunnel access requires Docker Engine 28 or newer for safe loopback publishing"
        )

def inspect_container(container_id):
    result = subprocess.run(
        ["docker", "container", "inspect", container_id],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    values = json.loads(result.stdout)
    return values[0] if values else None

running = subprocess.run(
    ["docker", "ps", "-q"],
    check=True,
    capture_output=True,
    text=True,
).stdout.splitlines()
port_held_by_previous = False
for container_id in running:
    container = inspect_container(container_id)
    if not container:
        continue
    name = container.get("Name", "").lstrip("/")
    if host_port:
        bindings = container.get("NetworkSettings", {}).get("Ports") or {}
        for values in bindings.values():
            for binding in values or []:
                if binding.get("HostPort") != host_port:
                    continue
                if name != previous_container:
                    raise SystemExit(
                        f"Loopback host port '{host_port}' is already used by container '{name}'"
                    )
                port_held_by_previous = True

if host_port and not port_held_by_previous:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", int(host_port)))
    except OSError as error:
        raise SystemExit(
            f"Loopback host port '{host_port}' is unavailable: {error}"
        ) from error
    finally:
        probe.close()
PYTHON
runtime_args=()
if test -n "$network_name"; then
  runtime_args+=(--network "$network_name")
  if test -n "$network_alias"; then runtime_args+=(--network-alias "$network_alias"); fi
fi
if test -n "$resource_cpus"; then runtime_args+=(--cpus "$resource_cpus"); fi
if test -n "$resource_memory"; then runtime_args+=(--memory "$resource_memory"); fi
for ((index = 0; index < volume_count; index += 1)); do
  logical_name="$1"
  mount_path="$2"
  shift 2
  state_dir="/var/lib/towbar/resources/$deployable_id/volumes"
  sudo install -d -m 0755 -o "$(id -u)" -g "$(id -g)" "$state_dir"
  pointer="$state_dir/$logical_name.active"
  legacy_volume="towbar-$deployable_id-$logical_name"
  if ! test -s "$pointer"; then
    printf '%s\n' "$legacy_volume" >"$pointer.tmp"
    mv "$pointer.tmp" "$pointer"
  fi
  volume_name="$(cat "$pointer")"
  case "$volume_name" in towbar-*) ;; *) exit 65 ;; esac
  docker volume create \
    --label "towbar.managed=true" \
    --label "towbar.deployable=$deployable_id" \
    --label "towbar.source=$TOWBAR_SOURCE_ID" \
    "$volume_name" >/dev/null
  test "$(docker volume inspect --format '{{index .Labels "towbar.managed"}}' "$volume_name")" = true
  test "$(docker volume inspect --format '{{index .Labels "towbar.deployable"}}' "$volume_name")" = "$deployable_id"
  runtime_args+=(--mount "type=volume,src=$volume_name,dst=$mount_path")
done
if test -n "$previous_container" && docker container inspect "$previous_container" >/dev/null 2>&1; then
  docker stop --time 30 "$previous_container" >/dev/null
fi
docker_command=(
  /usr/bin/docker run -d "${"$"}{runtime_args[@]}"
  --name "$container_name"
  --restart unless-stopped
  --add-host host.docker.internal:host-gateway
  --env "SOURCE_COMMIT=$TOWBAR_COMMIT_SHA"
  --env "TOWBAR_APP_ID=$TOWBAR_APP_ID"
  --env "TOWBAR_COMMIT_SHA=$TOWBAR_COMMIT_SHA"
  --env "TOWBAR_DEPLOYMENT_ID=$TOWBAR_DEPLOYMENT_ID"
  --label "towbar.managed=true"
  --label "towbar.app=$TOWBAR_CLEANUP_ID"
  --label "towbar.resource=$deployable_id"
  --label "towbar.deployable=$TOWBAR_DEPLOYABLE_ID"
  --label "towbar.source=$TOWBAR_SOURCE_ID"
  --label "towbar.deployment=$TOWBAR_DEPLOYMENT_ID"
)
if test -n "$container_port"; then
  if test -n "$host_port"; then
    docker_command+=(-p "127.0.0.1:$host_port:$container_port")
  else
    docker_command+=(-p "127.0.0.1::$container_port")
  fi
fi
docker_command+=("$image_tag")
if (( $# > 0 )); then docker_command+=("$@"); fi
/usr/bin/python3 - "$remote_dir/secrets/runtime" "${"$"}{docker_command[@]}" <<'PYTHON' >/dev/null
import os
import json
from pathlib import Path
import sys

runtime_directory = Path(sys.argv[1])
command = sys.argv[2:]
runtime_arguments: list[str] = []
${containerRuntimeArgumentsScript}
for secret_path in sorted(runtime_directory.iterdir()):
    if not secret_path.is_file():
        continue
    os.environ[secret_path.name] = secret_path.read_text(encoding="utf-8")
    runtime_arguments.extend(("--env", secret_path.name))
command[3:3] = runtime_arguments
os.execve(command[0], command, os.environ)
PYTHON
if test -n "$container_port"; then
  docker port "$container_name" "$container_port/tcp" | awk -F: 'NR==1 {print $NF}'
else
  printf '0\n'
fi
`;

export const hookRemoteScript = String.raw`
set -euo pipefail
${drainCentralizedLogsShell}
remote_dir="$1"
hook_name="$2"
container_name="$3"
image_tag="$4"
network_name="$5"
resource_cpus="$6"
resource_memory="$7"
timeout_seconds="$8"
shift 8
hook_container="$container_name-hook-${"$"}{hook_name,,}"
secret_directory="$remote_dir/secrets/hooks/$hook_name"
runtime_args=()
if test -n "$network_name"; then runtime_args+=(--network "$network_name"); fi
if test -n "$resource_cpus"; then runtime_args+=(--cpus "$resource_cpus"); fi
if test -n "$resource_memory"; then runtime_args+=(--memory "$resource_memory"); fi
cleanup_hook() { towbar_drain_logs "$hook_container"; docker rm -f "$hook_container" >/dev/null 2>&1 || true; }
trap cleanup_hook EXIT
/usr/bin/timeout --signal=TERM --kill-after=10s "$timeout_seconds" \
  /usr/bin/python3 - "$secret_directory" \
  /usr/bin/docker run --rm "${"$"}{runtime_args[@]}" \
  --name "$hook_container" \
  --add-host host.docker.internal:host-gateway \
  --env "SOURCE_COMMIT=$TOWBAR_COMMIT_SHA" \
  --env "TOWBAR_APP_ID=$TOWBAR_APP_ID" \
  --env "TOWBAR_COMMIT_SHA=$TOWBAR_COMMIT_SHA" \
  --env "TOWBAR_DEPLOYMENT_ID=$TOWBAR_DEPLOYMENT_ID" \
  --env "TOWBAR_HOOK=$hook_name" \
  "$image_tag" "$@" <<'PYTHON'
import os
import json
import subprocess
from pathlib import Path
import sys

secret_directory = Path(sys.argv[1])
command = sys.argv[2:]
runtime_arguments: list[str] = json.loads(os.environ.get("TOWBAR_VOLUME_ARGS_JSON", "[]"))
for option in runtime_arguments[1::2]:
    name = next(part[4:] for part in option.split(",") if part.startswith("src="))
    result = subprocess.run(["/usr/bin/docker", "volume", "inspect", name], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit("Persistent volume is missing before hook execution: " + name)
    labels = json.loads(result.stdout)[0].get("Labels") or {}
    if labels.get("towbar.managed") != "true" or labels.get("towbar.storage") != "app" or labels.get("towbar.runtime") != os.environ["TOWBAR_APP_ID"]:
        raise SystemExit("Persistent volume ownership changed before hook execution")

${containerRuntimeArgumentsScript}

for secret_path in sorted(secret_directory.iterdir()):
    if not secret_path.is_file():
        continue
    os.environ[secret_path.name] = secret_path.read_text(encoding="utf-8")
    runtime_arguments.extend(("--env", secret_path.name))
command[3:3] = runtime_arguments
os.execve(command[0], command, os.environ)
PYTHON
`;

export const healthRemoteScript = String.raw`
set -euo pipefail
port="$1"
health_path="$2"
timeout_seconds="$3"
deadline=$((SECONDS + timeout_seconds))
until curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port$health_path" >/dev/null; do
  if (( SECONDS >= deadline )); then exit 1; fi
  sleep 2
done
`;

export const containerHealthRemoteScript = String.raw`
set -euo pipefail
container_name="$1"
health_type="$2"
timeout_seconds="$3"
shift 3
deadline=$((SECONDS + timeout_seconds))
while true; do
  healthy=false
  if test "$health_type" = container; then
    state="$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name" 2>/dev/null || true)"
    if test "$state" = 'true none' || test "$state" = 'true healthy'; then healthy=true; fi
  elif /usr/bin/python3 - "$container_name" "$@" <<'PYTHON' >/dev/null 2>&1
import json
import os
from pathlib import Path
import sys

runtime_file = os.environ.get("TOWBAR_CONTAINER_RUNTIME_FILE")
health_command = json.loads(Path(runtime_file).read_text())["healthCommand"] if runtime_file else sys.argv[2:]
os.execv("/usr/bin/docker", ["docker", "exec", sys.argv[1], *health_command])
PYTHON
  then
    healthy=true
  fi
  if test "$healthy" = true; then exit 0; fi
  if (( SECONDS >= deadline )); then exit 1; fi
  sleep 2
done
`;

export const ensureNetworkRemoteScript = String.raw`
set -euo pipefail
network_name="$1"
if docker network inspect "$network_name" >/dev/null 2>&1; then
  exit 0
fi
if docker network create \
  --driver bridge \
  --label towbar.managed=true \
  "$network_name" >/dev/null 2>&1; then
  exit 0
fi
# A concurrent deployment may have created the shared network after the first
# inspection. Accept that race only when the requested network now exists.
docker network inspect "$network_name" >/dev/null
`;

export const configureCaddyScript = String.raw`
set -euo pipefail
remote_dir="$1"
app_id="$2"
sudo install -d -m 755 /etc/caddy/towbar
if ! test -f "$remote_dir/caddy.previous.state"; then
  if sudo test -f "/etc/caddy/towbar/$app_id.caddy"; then
    sudo cp "/etc/caddy/towbar/$app_id.caddy" "$remote_dir/caddy.previous"
    printf 'present' >"$remote_dir/caddy.previous.state"
  else
    printf 'absent' >"$remote_dir/caddy.previous.state"
  fi
fi
if ! test -f "$remote_dir/cloudflare.previous.state"; then
  if sudo test -f /etc/caddy/towbar/cloudflare.env; then
    sudo cp /etc/caddy/towbar/cloudflare.env "$remote_dir/cloudflare.previous"
    printf 'present' >"$remote_dir/cloudflare.previous.state"
  else
    printf 'absent' >"$remote_dir/cloudflare.previous.state"
  fi
fi
mkdir -p "$remote_dir/domain-handoffs"
sudo python3 - "$remote_dir" apply "${"$"}{3:-[]}" <<'PYTHON'
${domainRoutingPython}
PYTHON
sudo install -m 644 "$remote_dir/app.caddy" "/etc/caddy/towbar/$app_id.caddy"
if ! sudo grep -Fq 'import /etc/caddy/towbar/*.caddy' /etc/caddy/Caddyfile; then
  printf '\nimport /etc/caddy/towbar/*.caddy\n' | sudo tee -a /etc/caddy/Caddyfile >/dev/null
fi
if test -s "$remote_dir/cloudflare.env"; then
  sudo install -m 600 "$remote_dir/cloudflare.env" /etc/caddy/towbar/cloudflare.env
  sudo install -d -m 755 /etc/systemd/system/caddy.service.d
  caddy_binary="$(command -v caddy)"
  printf '%s\n' \
    '[Service]' \
    'EnvironmentFile=/etc/caddy/towbar/cloudflare.env' \
    'ExecStart=' \
    "ExecStart=$caddy_binary run --config /etc/caddy/Caddyfile" \
    | sudo tee /etc/systemd/system/caddy.service.d/towbar.conf >/dev/null
  sudo systemctl daemon-reload
fi
sudo caddy fmt --overwrite "/etc/caddy/towbar/$app_id.caddy"
validate_args=(--config /etc/caddy/Caddyfile)
if sudo test -s /etc/caddy/towbar/cloudflare.env; then
  validate_args+=(--envfile /etc/caddy/towbar/cloudflare.env)
fi
sudo caddy validate "${"$"}{validate_args[@]}"
if sudo test -s /etc/caddy/towbar/cloudflare.env; then
  # The provider token is part of the Caddy service environment. A restart is
  # required on first install and token rotation; systemctl reload would keep
  # the previous service environment and fail closed with an empty token.
  sudo systemctl restart caddy
else
  sudo systemctl reload caddy
fi
`;

export const rollbackCandidateScript = String.raw`
set -euo pipefail
${drainCentralizedLogsShell}
remote_dir="$1"
cleanup_id="$2"
container_name="$3"
image_tag="$4"
remove_image="$5"
previous_container="${"$"}{6:-}"
caddy_id="${"$"}{7:-$cleanup_id}"
# Do not restart a writer while an interrupted import is still reading its files.
if test -f "/var/lib/towbar/apps/$caddy_id/volumes/.initialization.lock"; then
  exec 8>"/var/lib/towbar/apps/$caddy_id/volumes/.initialization.lock"
  python3 - <<'PYTHON'
import fcntl
fcntl.flock(8, fcntl.LOCK_EX)
PYTHON
fi
towbar_drain_logs "$container_name"; docker rm -f "$container_name" >/dev/null 2>&1 || true
if test "$remove_image" = true; then docker image rm "$image_tag" >/dev/null 2>&1 || true; fi
if test -n "$previous_container" && docker container inspect "$previous_container" >/dev/null 2>&1; then
  docker start "$previous_container" >/dev/null
fi
sudo python3 - "$remote_dir" rollback <<'PYTHON'
${domainRoutingPython}
PYTHON
if test -f "$remote_dir/caddy.previous.state"; then
  if test "$(cat "$remote_dir/caddy.previous.state")" = present; then
    sudo install -m 644 "$remote_dir/caddy.previous" "/etc/caddy/towbar/$caddy_id.caddy"
  else
    sudo rm -f "/etc/caddy/towbar/$caddy_id.caddy"
  fi
  if test -f "$remote_dir/cloudflare.previous.state"; then
    if test "$(cat "$remote_dir/cloudflare.previous.state")" = present; then
      sudo install -m 600 "$remote_dir/cloudflare.previous" /etc/caddy/towbar/cloudflare.env
      sudo install -d -m 755 /etc/systemd/system/caddy.service.d
      caddy_binary="$(command -v caddy)"
      printf '%s\n' \
        '[Service]' \
        'EnvironmentFile=/etc/caddy/towbar/cloudflare.env' \
        'ExecStart=' \
        "ExecStart=$caddy_binary run --config /etc/caddy/Caddyfile" \
        | sudo tee /etc/systemd/system/caddy.service.d/towbar.conf >/dev/null
    else
      sudo rm -f /etc/caddy/towbar/cloudflare.env /etc/systemd/system/caddy.service.d/towbar.conf
    fi
    sudo systemctl daemon-reload
  fi
  validate_args=(--config /etc/caddy/Caddyfile)
  if sudo test -s /etc/caddy/towbar/cloudflare.env; then
    validate_args+=(--envfile /etc/caddy/towbar/cloudflare.env)
  fi
  sudo caddy validate "${"$"}{validate_args[@]}"
  if sudo test -s /etc/caddy/towbar/cloudflare.env; then
    sudo systemctl restart caddy
  else
    sudo systemctl reload caddy
  fi
fi
rm -rf "$remote_dir"
`;

export const finalizeRemoteScript = String.raw`
set -euo pipefail
${drainCentralizedLogsShell}
remote_dir="$1"
app_id="$2"
container_names="$3"
shift 3
retained_containers="$remote_dir/retained-containers"
if [[ "$container_names" = \[* ]]; then
  python3 - "$container_names" >"$retained_containers" <<'PYTHON'
import json
import sys
for name in json.loads(sys.argv[1]):
    print(name)
PYTHON
else
  printf '%s\n' "$container_names" >"$retained_containers"
fi
docker ps -a --filter "label=towbar.app=$app_id" --format '{{.Names}}' | while read -r name; do
  if test -n "$name" && ! grep -Fxq "$name" "$retained_containers"; then towbar_drain_logs "$name"; docker rm -f "$name" >/dev/null; fi
done
python3 - "$app_id" <<'PYTHON'
${reclaimHostLogVolumeScript}
PYTHON
if (( $# > 0 )); then
  {
    docker images --filter "label=towbar.app=$app_id" --format '{{.Repository}}:{{.Tag}}'
    docker images "towbar/resource-$app_id" --format '{{.Repository}}:{{.Tag}}'
  } | sort -u | while read -r image; do
    case "$image" in towbar/build-cache-*:current) continue ;; esac
    keep=false
    for retained_image in "$@"; do
      if test "$image" = "$retained_image"; then keep=true; break; fi
    done
    if test "$keep" = false; then docker image rm "$image" >/dev/null 2>&1 || true; fi
  done
fi
rm -rf "$remote_dir"
`;

export const scheduleFinalizeRemoteScript = String.raw`
set -euo pipefail
${drainCentralizedLogsShell}
remote_dir="$1"
app_id="$2"
container_names="$3"
delay_seconds="$4"
shift 4
retained_file="$remote_dir/retained-images"
retained_containers="$remote_dir/retained-containers"
printf '%s\n' "$@" >"$retained_file"
if [[ "$container_names" = \[* ]]; then
  python3 - "$container_names" >"$retained_containers" <<'PYTHON'
import json
import sys
for name in json.loads(sys.argv[1]):
    print(name)
PYTHON
else
  printf '%s\n' "$container_names" >"$retained_containers"
fi
chmod 600 "$retained_file"
cat >"$remote_dir/reclaim-host-logs.py" <<'PYTHON'
${reclaimHostLogVolumeScript}
PYTHON
nohup bash -c '
  set -euo pipefail
${drainCentralizedLogsShell}
  remote_dir="$1"
  app_id="$2"
  retained_containers="$3"
  delay_seconds="$4"
  retained_file="$5"
  sleep "$delay_seconds"
  docker ps -a --filter "label=towbar.app=$app_id" --format "{{.Names}}" | while read -r name; do
    if test -n "$name" && ! grep -Fxq "$name" "$retained_containers"; then towbar_drain_logs "$name"; docker rm -f "$name" >/dev/null; fi
  done
  python3 "$remote_dir/reclaim-host-logs.py" "$app_id"
  if test -s "$retained_file"; then
    {
      docker images --filter "label=towbar.app=$app_id" --format "{{.Repository}}:{{.Tag}}"
      docker images "towbar/resource-$app_id" --format "{{.Repository}}:{{.Tag}}"
    } | sort -u | while read -r image; do
      case "$image" in towbar/build-cache-*:current) continue ;; esac
      if ! grep -Fxq "$image" "$retained_file"; then docker image rm "$image" >/dev/null 2>&1 || true; fi
    done
  fi
  rm -rf "$remote_dir"
' -- "$remote_dir" "$app_id" "$retained_containers" "$delay_seconds" "$retained_file" \
  </dev/null >/dev/null 2>&1 &
`;

export const cleanupPreviewRemoteScript = String.raw`
set -euo pipefail
${drainCentralizedLogsShell}
runtime_id="$1"
shift
container_count="$1"
shift
for ((index = 0; index < container_count; index += 1)); do
  requested="$1"
  containers="$(docker container ls --all --format '{{.Names}}')"
  if grep -Fxq -- "$requested" <<<"$containers"; then
    towbar_drain_logs "$requested"; docker rm -f "$requested" >/dev/null
  elif [[ "$requested" = towbar-* ]]; then
    compose_containers="$(docker container ls --all --filter "label=com.docker.compose.project=$requested" --format '{{.Names}}')"
    while IFS= read -r name; do
      if test -n "$name"; then towbar_drain_logs "$name"; docker rm -f "$name" >/dev/null; fi
    done <<<"$compose_containers"
    compose_networks="$(docker network ls --filter "label=com.docker.compose.project=$requested" --format '{{.Name}}')"
    while IFS= read -r name; do
      if test -n "$name"; then docker network rm "$name" >/dev/null 2>&1 || true; fi
    done <<<"$compose_networks"
    compose_volumes="$(docker volume ls --filter "label=com.docker.compose.project=$requested" --format '{{.Name}}')"
    while IFS= read -r name; do
      if test -n "$name"; then docker volume rm "$name" >/dev/null 2>&1 || true; fi
    done <<<"$compose_volumes"
  fi
  shift
done
orphan_containers="$(docker container ls --all --filter "label=towbar.app=$runtime_id" --format '{{.Names}}')"
while IFS= read -r name; do
  if test -n "$name"; then towbar_drain_logs "$name"; docker rm -f "$name" >/dev/null; fi
done <<<"$orphan_containers"
sudo rm -rf -- "/var/lib/towbar/cloudflared/$runtime_id"
sudo rm -rf -- "/var/lib/towbar/compose/$runtime_id" "/var/lib/towbar/compose/${"$"}{runtime_id}."*
image_count="$1"
shift
for ((index = 0; index < image_count; index += 1)); do
  images="$(docker image ls --format '{{.Repository}}:{{.Tag}}')"
  if grep -Fxq -- "$1" <<<"$images"; then
    docker image rm "$1" >/dev/null
  fi
  shift
done
orphan_images="$(docker image ls --filter "label=towbar.app=$runtime_id" --no-trunc --format '{{.ID}}')"
while IFS= read -r image; do
  if test -n "$image"; then
    docker image rm "$image" >/dev/null
  fi
done <<<"$orphan_images"
sudo rm -f "/etc/caddy/towbar/$runtime_id.caddy"
validate_args=(--config /etc/caddy/Caddyfile)
if sudo test -s /etc/caddy/towbar/cloudflare.env; then
  validate_args+=(--envfile /etc/caddy/towbar/cloudflare.env)
fi
sudo caddy validate "${"$"}{validate_args[@]}"
if sudo test -s /etc/caddy/towbar/cloudflare.env; then
  sudo systemctl restart caddy
else
  sudo systemctl reload caddy
fi
`;
