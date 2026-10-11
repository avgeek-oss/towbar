import { domainHandoffRoutingMessage } from "./domain-routing.js";
import {
  domainDnsRecorder,
  readDomainDnsReceipt,
  restoreDomainDnsReceipt,
} from "./domain-dns-recovery.js";
import {
  assertDomainRollbackSafe,
  cleanupTransferredDomainRoutes,
  domainRoutingPython,
  localDomainHandoffs,
  throwIfDomainRecoveryFailed,
} from "./domain-routing.js";
/* eslint-disable max-lines -- Compose validation, deployment, health checks, and rollback implement one atomic deployment protocol. */
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { deploymentRuntimeId } from "./deployment-identity.js";
import { safeLog, transition } from "./executor-hooks.js";
import {
  DeploymentCommitUncertainError,
  DeploymentCommittedError,
  resolveDeploymentFailureBoundary,
} from "./promotion-boundary.js";
import { runCommand } from "./process.js";
import { fetchDeploymentSource } from "./source-fetch.js";
import { SshSession } from "./ssh.js";
import {
  type CloudflareDnsTransition,
  type CloudflareTunnelTransition,
  cleanupCloudflareDnsTransition,
  cleanupCloudflareTunnelTransition,
  deploymentPublicHostnames,
  inspectCloudflareDeploymentDns,
  reconcileCloudflareForDeployment,
  reconcileCloudflareTunnelRoutes,
} from "./cloudflare.js";
import { collectSensitiveValues } from "./secrets.js";
import { configureCaddyScript } from "./remote-scripts.js";
import { validateComposeRepository } from "./compose-security.js";
import {
  type NormalizedComposeWorkload,
  deploymentCloudflareDnsDomains,
  isNormalizedCompose,
} from "@workspace/towbar-core";
import { ensureCloudflareCaddyModule } from "./caddy-preparation.js";

import type {
  DeploymentExecutionContext,
  DeploymentResult,
  DeploymentSecrets,
  ExecutorHooks,
  SshLoginSecret,
} from "./types.js";

const generatedOverrideFile = ".towbar.generated.override.json";

const prepareComposeStorageScript = String.raw`
set -euo pipefail
parent=/var/lib/towbar
state="$parent/compose"
owner_uid="$(id -u)"
owner_gid="$(id -g)"
if test -L "$parent" || test -L "$state"; then
  printf 'Compose state path cannot be a symbolic link.\n' >&2
  exit 72
fi
if test -e "$parent"; then
  if ! test -d "$parent" || test "$(stat -c '%u' "$parent")" != 0; then
    printf 'Compose parent must be a root-owned directory; operator attention is required.\n' >&2
    exit 72
  fi
  if ! test -x "$parent"; then
    printf 'Compose parent must be searchable by the deploy user; operator attention is required.\n' >&2
    exit 72
  fi
  writable_parent="$(find "$parent" -maxdepth 0 -perm /022 -print -quit)"
  if test -n "$writable_parent"; then
    printf 'Compose parent must not be group- or world-writable.\n' >&2
    exit 72
  fi
fi
if test "$owner_uid" -eq 0; then SUDO=(); else SUDO=(sudo -n); fi
if test -e "$state"; then
  if ! test -d "$state"; then
    printf 'Compose state path is not a directory.\n' >&2
    exit 72
  fi
  existing_uid="$(stat -c '%u' "$state")"
  if test "$existing_uid" != 0 && test "$existing_uid" != "$owner_uid"; then
    printf 'Compose state belongs to another user; operator attention is required.\n' >&2
    exit 72
  fi
  writable_state="$(find "$state" -maxdepth 0 -perm /022 -print -quit)"
  if test -n "$writable_state"; then
    printf 'Compose state must not be group- or world-writable.\n' >&2
    exit 72
  fi
  if test "$existing_uid" = 0 && test "$owner_uid" != 0; then
    existing_entry="$("${"$"}{SUDO[@]}" find "$state" -mindepth 1 -print -quit)"
    if test -n "$existing_entry"; then
      printf 'Root-owned Compose state contains existing releases; operator attention is required.\n' >&2
      exit 72
    fi
  fi
fi
"${"$"}{SUDO[@]}" install -d -m 0755 -o 0 -g 0 "$parent"
"${"$"}{SUDO[@]}" install -d -m 0700 -o "$owner_uid" -g "$owner_gid" "$state"
test "$(stat -c '%u' "$parent")" = 0
test -O "$state" && test -w "$state"
`;

export function buildComposeServiceOverride(
  app: Extract<DeploymentExecutionContext["app"], { kind: "compose" }>,
  environment: string,
  sourceId = app.id,
  identity?: Pick<
    DeploymentExecutionContext,
    "deployableId" | "deploymentId" | "serverId" | "workspaceId"
  >,
) {
  const deployableId = identity?.deployableId ?? app.id;
  return {
    services: Object.fromEntries(
      Object.entries(app.services).map(([service, policy]) => {
        return [
          service,
          {
            labels: {
              "towbar.managed": "true",
              "towbar.app": deployableId,
              "towbar.deployable": deployableId,
              "towbar.source": sourceId,
              "towbar.compose.service": service,
            },
            ...(policy.domains?.length && policy.port
              ? { ports: [`127.0.0.1::${policy.port}`] }
              : {}),
          },
        ];
      }),
    ),
  };
}

const composeDeployScript = String.raw`
set -euo pipefail
archive="$1"
staged="$2"
stable="$3"
previous="$4"
project="$5"
files_json="$6"
profiles_json="$7"
strategy="$8"
policies_json="$9"
deployable_id="${"$"}{10}"
source_id="${"$"}{11}"
deployment_id="${"$"}{12}"
rm -rf -- "$staged" "$previous"
install -d -m 700 "$staged/source"
printf '%s' "$deployment_id" >"$staged/deployment-id"
expanded_bytes="$(gzip -cd "$archive" | wc -c)"
test "$expanded_bytes" -le 2147483648
entries="$(tar -tzf "$archive" | wc -l)"
test "$entries" -le 100000
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$staged/source"
install -m 600 "${"$"}{archive}.env" "$staged/runtime.env"
mapfile -t compose_args < <(python3 - "$staged/source" "$files_json" "$profiles_json" <<'PYTHON'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
for value in json.loads(sys.argv[2]):
    candidate = (root / value).resolve(strict=True)
    if root != candidate and root not in candidate.parents:
        raise SystemExit("Compose file escaped the repository checkout")
    if not candidate.is_file() or candidate.is_symlink():
        raise SystemExit(f"Compose file is not a regular repository file: {value}")
    print("-f")
    print(str(candidate))
for profile in json.loads(sys.argv[3]):
    print("--profile")
    print(profile)
PYTHON
)
compose=(docker compose --project-name "$project" --env-file "$staged/runtime.env" "${"$"}{compose_args[@]}")
"${"$"}{compose[@]}" config --format json >"$staged/config.initial.json"
ownership_override="$staged/source/.towbar.ownership.override.json"
python3 - "$staged/config.initial.json" "$ownership_override" "$deployable_id" "$source_id" <<'PYTHON'
import json, pathlib, sys
config = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
services = config.get("services")
if not isinstance(services, dict) or not services:
    raise SystemExit("Compose must declare at least one service")
override = {"services": {}}
for service in sorted(services):
    override["services"][service] = {"labels": {
        "towbar.managed": "true",
        "towbar.app": sys.argv[3],
        "towbar.deployable": sys.argv[3],
        "towbar.source": sys.argv[4],
        "towbar.compose.service": service,
    }}
pathlib.Path(sys.argv[2]).write_text(json.dumps(override, separators=(",", ":")), encoding="utf-8")
PYTHON
files_json="$(python3 - "$files_json" <<'PYTHON'
import json, sys
values = json.loads(sys.argv[1])
if ".towbar.ownership.override.json" not in values:
    values.append(".towbar.ownership.override.json")
print(json.dumps(values, separators=(",", ":")))
PYTHON
)"
compose_args+=(-f "$ownership_override")
compose=(docker compose --project-name "$project" --env-file "$staged/runtime.env" "${"$"}{compose_args[@]}")
"${"$"}{compose[@]}" config --format json >"$staged/config.json"
rm -f "$staged/config.initial.json"
printf '%s' "$files_json" >"$staged/compose-files.json"
printf '%s' "$profiles_json" >"$staged/compose-profiles.json"
python3 - "$staged/config.json" "$staged/source" "$project" <<'PYTHON'
import json, pathlib, re, sys
config = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
root = pathlib.Path(sys.argv[2]).resolve(strict=True)
project = sys.argv[3]
def require_local_path(value, label):
    if not isinstance(value, str): return
    if re.match(r"^[a-z][a-z0-9+.-]*://", value, re.I):
        raise SystemExit(f"{label} cannot use a remote URL")
    candidate = pathlib.Path(value)
    if not candidate.is_absolute(): candidate = root / candidate
    candidate = candidate.resolve(strict=False)
    if candidate != root and root not in candidate.parents:
        raise SystemExit(f"{label} escaped the repository checkout")
services = config.get("services")
if not isinstance(services, dict) or not services:
    raise SystemExit("Compose must declare at least one service")
for name, service in services.items():
    for field in ("container_name", "devices", "device_cgroup_rules", "gpus", "volumes_from", "external_links", "runtime", "develop", "cgroup", "cgroup_parent", "credential_spec", "use_api_socket"):
        if service.get(field):
            raise SystemExit(f"Compose service {name} cannot set {field}")
    if service.get("privileged"):
        raise SystemExit(f"Compose service {name} cannot run privileged")
    for field in ("network_mode", "pid", "ipc", "uts", "userns_mode"):
        if service.get(field):
            raise SystemExit(f"Compose service {name} cannot join a host or external namespace through {field}")
    if service.get("cap_add"):
        raise SystemExit(f"Compose service {name} cannot add Linux capabilities")
    if service.get("security_opt"):
        raise SystemExit(f"Compose service {name} cannot override container security options")
    if service.get("devices"):
        raise SystemExit(f"Compose service {name} cannot attach host devices")
    image = service.get("image")
    if image and not service.get("build") and not re.search(r"@sha256:[a-f0-9]{64}$", image):
        raise SystemExit(f"Compose service {name} image must be pinned by sha256 digest")
    build = service.get("build")
    if isinstance(build, dict):
        if any(build.get(field) for field in ("privileged", "ssh", "entitlements", "cache_from", "cache_to", "output", "outputs")):
            raise SystemExit(f"Compose service {name} requests prohibited build privileges, caches, or outputs")
        if build.get("network") not in (None, "", "default", "none"):
            raise SystemExit(f"Compose service {name} must use default or disabled build networking")
        if any("host-gateway" in str(value).lower() for value in build.get("extra_hosts") or []):
            raise SystemExit(f"Compose service {name} cannot resolve the Docker host gateway while building")
        require_local_path(build.get("context"), f"Compose service {name} build context")
        require_local_path(build.get("dockerfile"), f"Compose service {name} Dockerfile")
    for env_file in service.get("env_file") or []:
        require_local_path(env_file.get("path") if isinstance(env_file, dict) else env_file, f"Compose service {name} env_file")
    for volume in service.get("volumes") or []:
        source = volume.get("source") if isinstance(volume, dict) else None
        if isinstance(volume, dict) and volume.get("type") == "bind":
            raise SystemExit(f"Compose service {name} uses a prohibited host bind mount")
        if isinstance(source, str) and (source.startswith("/") or "docker.sock" in source):
            raise SystemExit(f"Compose service {name} uses a prohibited host bind mount")
    for port in service.get("ports") or []:
        if not isinstance(port, dict):
            raise SystemExit(f"Compose service {name} uses an unvalidated published port")
        if port.get("host_ip") not in ("127.0.0.1", "::1"):
            raise SystemExit(f"Compose service {name} published ports must bind to loopback")
        published = port.get("published")
        if published not in (None, "", "0", 0):
            raise SystemExit(f"Compose service {name} cannot reserve a fixed host port")
for collection in ("configs", "secrets"):
    for name, item in (config.get(collection) or {}).items():
        if isinstance(item, dict): require_local_path(item.get("file"), f"Compose {collection[:-1]} {name}")
for collection in ("volumes", "networks", "configs", "secrets"):
    for name, item in (config.get(collection) or {}).items():
        if not isinstance(item, dict): continue
        resolved_name = item.get("name")
        if resolved_name and not str(resolved_name).startswith(project + "_"):
            raise SystemExit(f"Compose {collection[:-1]} {name} escaped the project namespace")
        if collection == "volumes" and (item.get("driver") or item.get("driver_opts")):
            raise SystemExit(f"Compose volume {name} cannot configure a storage driver or host driver options")
        if collection == "networks":
            if item.get("driver") not in (None, "", "bridge"):
                raise SystemExit(f"Compose network {name} must use the bridge driver")
            if item.get("driver_opts") or item.get("attachable"):
                raise SystemExit(f"Compose network {name} cannot set host driver options or allow external attachment")
PYTHON
if test -d "$stable"; then mv "$stable" "$previous"; fi
mv "$staged" "$stable"
restore_previous() {
  status="$?"
  rm -f -- "$archive" "${"$"}{archive}.env"
  if test "$status" -ne 0; then
    rm -rf -- "$stable"
    if test -d "$previous"; then
      mv "$previous" "$stable"
      old_files_json="$(cat "$stable/compose-files.json" 2>/dev/null || printf '%s' "$files_json")"
      old_profiles_json="$(cat "$stable/compose-profiles.json" 2>/dev/null || printf '%s' "$profiles_json")"
      mapfile -t old_args < <(python3 - "$stable/source" "$old_files_json" "$old_profiles_json" <<'PYTHON'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
for value in json.loads(sys.argv[2]):
    print("-f"); print(str((root / value).resolve(strict=True)))
for profile in json.loads(sys.argv[3]): print("--profile"); print(profile)
PYTHON
)
      if docker compose --project-name "$project" --env-file "$stable/runtime.env" "${"$"}{old_args[@]}" up --detach --build --remove-orphans --wait --wait-timeout 300 >/dev/null 2>&1; then
        printf 'Previous Compose release restarted after deployment failure.\n' >&2
      else
        printf 'Previous Compose release could not be restarted; operator attention is required.\n' >&2
      fi
    fi
  fi
  exit "$status"
}
trap restore_previous EXIT
mapfile -t live_args < <(python3 - "$stable/source" "$files_json" "$profiles_json" <<'PYTHON'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
for value in json.loads(sys.argv[2]): print("-f"); print(str((root / value).resolve(strict=True)))
for profile in json.loads(sys.argv[3]): print("--profile"); print(profile)
PYTHON
)
live=(docker compose --project-name "$project" --env-file "$stable/runtime.env" "${"$"}{live_args[@]}")
if test "$strategy" = maintenance && test -d "$previous"; then
  old_files_json="$(cat "$previous/compose-files.json" 2>/dev/null || printf '%s' "$files_json")"
  old_profiles_json="$(cat "$previous/compose-profiles.json" 2>/dev/null || printf '%s' "$profiles_json")"
  mapfile -t maintenance_args < <(python3 - "$previous/source" "$old_files_json" "$old_profiles_json" <<'PYTHON'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
for value in json.loads(sys.argv[2]): print("-f"); print(str((root / value).resolve(strict=True)))
for profile in json.loads(sys.argv[3]): print("--profile"); print(profile)
PYTHON
  )
  docker compose --project-name "$project" --env-file "$previous/runtime.env" "${"$"}{maintenance_args[@]}" down --remove-orphans
fi
"${"$"}{live[@]}" pull --ignore-buildable
up_args=(--detach --build --remove-orphans --wait --wait-timeout 300)
if test "$strategy" = recreate; then up_args+=(--force-recreate); fi
"${"$"}{live[@]}" up "${"$"}{up_args[@]}"
"${"$"}{live[@]}" ps
python3 - "$project" "$policies_json" <<'PYTHON'
import json, re, subprocess, sys
project = sys.argv[1]
policies = json.loads(sys.argv[2])
routes = []
for service, policy in policies.items():
    domains = policy.get("domains") or []
    port = policy.get("port")
    if not domains: continue
    if not isinstance(port, int): raise SystemExit(f"Compose service {service} is missing its public port")
    ids = subprocess.run([
        "docker", "ps", "--filter", f"label=com.docker.compose.project={project}",
        "--filter", f"label=com.docker.compose.service={service}", "--format", "{{.ID}}"
    ], check=True, capture_output=True, text=True).stdout.splitlines()
    if not ids: raise SystemExit(f"Compose service {service} has no healthy running container")
    upstreams = []
    for container_id in ids:
        inspected = json.loads(subprocess.run(["docker", "inspect", container_id], check=True, capture_output=True, text=True).stdout)[0]
        bindings = (inspected.get("NetworkSettings", {}).get("Ports", {}) or {}).get(f"{port}/tcp") or []
        for binding in bindings:
            host_ip, host_port = binding.get("HostIp"), binding.get("HostPort")
            if host_ip not in ("127.0.0.1", "::1") or not re.fullmatch(r"[0-9]{1,5}", str(host_port)):
                raise SystemExit(f"Compose service {service} public port is not loopback-scoped")
            upstreams.append(f"127.0.0.1:{host_port}")
    if not upstreams: raise SystemExit(f"Compose service {service} has no published port {port}")
    routes.append({"service": service, "domains": domains, "ingress": policy.get("ingress") or {"type": "proxy"}, "tls": policy.get("tls"), "upstreams": sorted(set(upstreams))})
print("TOWBAR_ROUTING=" + json.dumps(routes, separators=(",", ":")))
PYTHON
python3 - "$stable/config.json" <<'PYTHON'
import json, pathlib, sys
services = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")).get("services") or {}
print("TOWBAR_SERVICES=" + json.dumps(sorted(services), separators=(",", ":")))
PYTHON
config_digest="$(sha256sum "$stable/config.json" | awk '{print $1}')"
test "${"$"}{#config_digest}" = 64
rm -f -- "$archive" "${"$"}{archive}.env"
trap - EXIT
printf '%s\n' "$config_digest"
`;

const composeRollbackScript = String.raw`
set -euo pipefail
stable="$1"
previous="$2"
project="$3"
files_json="$4"
profiles_json="$5"
runtime="$6"
expected_deployment_id="${"$"}{7:-}"
if test -n "$expected_deployment_id"; then
  test -f "$stable/deployment-id"
  test "$(cat "$stable/deployment-id")" = "$expected_deployment_id"
fi
if test -d "$stable"; then
  mapfile -t current_args < <(python3 - "$stable/source" "$files_json" "$profiles_json" <<'PYTHON'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
for value in json.loads(sys.argv[2]): print("-f"); print(str((root / value).resolve(strict=True)))
for profile in json.loads(sys.argv[3]): print("--profile"); print(profile)
PYTHON
)
  if ! docker compose --project-name "$project" --env-file "$stable/runtime.env" "${"$"}{current_args[@]}" down --remove-orphans >/dev/null 2>&1; then
    mapfile -t container_ids < <(docker ps -aq --filter "label=com.docker.compose.project=$project")
    if test "${"$"}{#container_ids[@]}" -gt 0; then docker rm -f "${"$"}{container_ids[@]}" >/dev/null; fi
  fi
  remaining_containers="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  test -z "$remaining_containers"
fi
sudo python3 - "$stable" rollback <<'PYTHON'
${domainRoutingPython}
PYTHON
if test -f "$stable/caddy.previous.state"; then
  if test "$(cat "$stable/caddy.previous.state")" = present; then
    sudo install -m 644 "$stable/caddy.previous" "/etc/caddy/towbar/$runtime.caddy"
  else
    sudo rm -f "/etc/caddy/towbar/$runtime.caddy"
  fi
  if test -f "$stable/cloudflare.previous.state"; then
    if test "$(cat "$stable/cloudflare.previous.state")" = present; then
      sudo install -m 600 "$stable/cloudflare.previous" /etc/caddy/towbar/cloudflare.env
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
  if sudo test -s /etc/caddy/towbar/cloudflare.env; then validate_args+=(--envfile /etc/caddy/towbar/cloudflare.env); fi
  sudo caddy validate "${"$"}{validate_args[@]}"
  if sudo test -s /etc/caddy/towbar/cloudflare.env; then sudo systemctl restart caddy; else sudo systemctl reload caddy; fi
fi
rm -rf -- "$stable"
if test -d "$previous"; then
  mv "$previous" "$stable"
  old_files_json="$(cat "$stable/compose-files.json" 2>/dev/null || printf '%s' "$files_json")"
  old_profiles_json="$(cat "$stable/compose-profiles.json" 2>/dev/null || printf '%s' "$profiles_json")"
  mapfile -t old_args < <(python3 - "$stable/source" "$old_files_json" "$old_profiles_json" <<'PYTHON'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
for value in json.loads(sys.argv[2]): print("-f"); print(str((root / value).resolve(strict=True)))
for profile in json.loads(sys.argv[3]): print("--profile"); print(profile)
PYTHON
)
  docker compose --project-name "$project" --env-file "$stable/runtime.env" "${"$"}{old_args[@]}" up --detach --build --remove-orphans --wait --wait-timeout 300
fi
`;

const composeInspectInterruptedScript = String.raw`
set -euo pipefail
stable="$1"
previous="$2"
staged="$3"
deployment_id="$4"
if test -d "$previous"; then
  test -f "$stable/deployment-id"
  test "$(cat "$stable/deployment-id")" = "$deployment_id"
fi
if test -f "$stable/deployment-id" && test "$(cat "$stable/deployment-id")" = "$deployment_id"; then
  printf 'candidate\n'
else
  rm -rf -- "$staged"
  printf 'none\n'
fi
`;

const composeFinalizeScript = String.raw`
set -euo pipefail
previous="$1"
stable="$2"
rm -rf -- "$previous" "$stable/domain-handoffs"
rm -f -- "$stable/domain-dns.json" "$stable/cloudflare.env" "$stable/cloudflare.previous" "$stable/cloudflare.previous.state" "$stable/caddy.previous" "$stable/caddy.previous.state"
`;

export const composeDeploymentScripts = {
  prepareStorage: prepareComposeStorageScript,
  deploy: composeDeployScript,
  rollback: composeRollbackScript,
  inspectInterrupted: composeInspectInterruptedScript,
  finalize: composeFinalizeScript,
} as const;

export async function rollbackInterruptedComposeDeployment(input: {
  context: DeploymentExecutionContext;
  login: SshLoginSecret;
  secrets?: DeploymentSecrets;
}): Promise<"removed" | "not-found"> {
  const { context } = input;
  if (!isNormalizedCompose(context.app))
    throw new Error("Compose recovery requires a Compose workload");
  const runtime = deploymentRuntimeId(context);
  const base = `/var/lib/towbar/compose/${runtime}`;
  const previous = `${base}.previous-${context.deploymentId}`;
  const staged = `${base}.staged-${context.deploymentId}`;
  const project = `towbar-${runtime}`.slice(0, 63);
  const files = [
    context.app.file,
    ...context.app.overrides,
    generatedOverrideFile,
  ];
  const session = await SshSession.connect({
    login: input.login,
    server: context.server,
    trustedHostKeys: context.trustedHostKeys,
  });
  try {
    const { stdout } = await session.run(
      composeInspectInterruptedScript,
      [base, previous, staged, context.deploymentId],
      { timeoutMs: 30_000 },
    );
    if (stdout.trim() === "none") return "not-found";
    if (stdout.trim() !== "candidate")
      throw new Error("Compose recovery returned an unknown candidate state");
    const dnsChanges = context.domainHandoffs?.length
      ? await readDomainDnsReceipt(session, base)
      : [];
    await restoreDomainDnsReceipt(context, input.secrets, dnsChanges);
    await session.run(
      composeRollbackScript,
      [
        base,
        previous,
        project,
        JSON.stringify(files),
        JSON.stringify(context.app.profiles),
        runtime,
        context.deploymentId,
      ],
      { timeoutMs: 10 * 60_000 },
    );
    return "removed";
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function finalizeInterruptedComposeDeployment(input: {
  context: DeploymentExecutionContext;
  login: SshLoginSecret;
  secrets?: DeploymentSecrets;
}) {
  const { context } = input;
  if (!isNormalizedCompose(context.app))
    throw new Error("Compose recovery requires a Compose workload");
  const runtime = deploymentRuntimeId(context);
  const base = `/var/lib/towbar/compose/${runtime}`;
  const previous = `${base}.previous-${context.deploymentId}`;
  const session = await SshSession.connect({
    login: input.login,
    server: context.server,
    trustedHostKeys: context.trustedHostKeys,
  });
  try {
    if (context.domainHandoffServers?.length) {
      if (!input.secrets)
        throw new Error("Previous domain credentials are required for cleanup");
      await cleanupTransferredDomainRoutes(context, input.secrets);
    }
    await session.run(composeFinalizeScript, [previous, base], {
      timeoutMs: 30_000,
    });
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function prepareComposeDns(input: {
  context: DeploymentExecutionContext;
  secrets: DeploymentSecrets;
  session: SshSession;
  signal?: AbortSignal;
}) {
  if (!deploymentCloudflareDnsDomains(input.context.app).length) return;
  if (!input.secrets.cloudflare)
    throw new Error("Cloudflare DNS credentials were not resolved");
  await ensureCloudflareCaddyModule(input.session, input.signal);
}

async function uploadComposeDnsToken(input: {
  context: DeploymentExecutionContext;
  secrets: DeploymentSecrets;
  session: SshSession;
  localDirectory: string;
  base: string;
  signal?: AbortSignal;
}) {
  if (
    !deploymentCloudflareDnsDomains(input.context.app).length ||
    !input.secrets.cloudflare
  )
    return;
  const tokenFile = path.join(input.localDirectory, "cloudflare.env");
  await writeFile(
    tokenFile,
    `CLOUDFLARE_API_TOKEN=${input.secrets.cloudflare.apiToken}\n`,
    { mode: 0o600 },
  );
  await input.session.upload(tokenFile, `${input.base}/cloudflare.env`, {
    signal: input.signal,
  });
}

async function cleanupPreviousComposeDns(input: {
  context: DeploymentExecutionContext;
  secrets: DeploymentSecrets;
}) {
  if (input.secrets.previousCloudflareDnsCleanupBlocked)
    throw new Error("Previous DNS credentials are unavailable");
  await cleanupCloudflareDnsTransition({
    appId: deploymentRuntimeId(input.context),
    previous: input.secrets.previousCloudflareDns ?? null,
    protectedHostnames: deploymentPublicHostnames(input.context.app),
    managedHostnames: deploymentCloudflareDnsDomains(input.context.app),
  });
}

export async function executeComposeDeployment(input: {
  context: DeploymentExecutionContext;
  hooks?: ExecutorHooks;
  secrets: DeploymentSecrets;
  signal?: AbortSignal;
  localDirectory: string;
}): Promise<DeploymentResult> {
  const { context, hooks = {}, secrets, signal } = input;
  if (!isNormalizedCompose(context.app))
    throw new Error("Compose executor requires a Compose workload");
  await transition(hooks, "preparing", "Preparing Compose deployment");
  await transition(
    hooks,
    "validating_credentials",
    "Credentials resolved and validated",
  );
  await transition(
    hooks,
    "checking_server",
    "Checking Compose server connectivity and DNS support",
  );
  const session = await SshSession.connect({
    login: secrets.login,
    server: context.server,
    trustedHostKeys: context.trustedHostKeys,
  });
  const runtime = deploymentRuntimeId(context);
  let cloudflareDnsExpectations: Awaited<
    ReturnType<typeof inspectCloudflareDeploymentDns>
  > = {};
  const base = `/var/lib/towbar/compose/${runtime}`;
  const remoteArchive = `/tmp/towbar-compose-${context.deploymentId}.tar.gz`;
  const project = `towbar-${runtime}`.slice(0, 63);
  const files = [
    context.app.file,
    ...context.app.overrides,
    generatedOverrideFile,
  ];
  const previous = `${base}.previous-${context.deploymentId}`;
  const onDnsChange = domainDnsRecorder({
    context,
    session,
    localDirectory: input.localDirectory,
    remoteDirectory: base,
  });
  let commitAttempted = false;
  let committed = false;
  let candidateStarted = false;
  let cloudflareTunnelTransition: CloudflareTunnelTransition | undefined;
  let cloudflareDnsTransition: CloudflareDnsTransition | undefined;
  try {
    cloudflareDnsExpectations = await inspectCloudflareDeploymentDns({
      app: context.app,
      appId: runtime,
      serverIp: context.server.ip,
      handoffs: context.domainHandoffs,
      dns: secrets.cloudflare,
      handoffDns: secrets.domainHandoffDns,
      tunnel: secrets.cloudflareTunnel,
    });
    await session.run(prepareComposeStorageScript, [], {
      signal,
      timeoutMs: 30_000,
    });
    await prepareComposeDns({ context, secrets, session, signal });
    await transition(
      hooks,
      "fetching_source",
      `${context.kind === "rollback" ? "Fetching retained" : "Fetching immutable"} source revision ${context.commitSha.slice(0, 12)}`,
    );
    const checkout = await fetchDeploymentSource(
      context,
      input.localDirectory,
      signal,
    );
    await writeFile(
      path.join(checkout, generatedOverrideFile),
      JSON.stringify(
        buildComposeServiceOverride(
          context.app,
          context.environmentName,
          context.sourceId,
          context,
        ),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await validateComposeRepository(checkout, [
      context.app.file,
      ...context.app.overrides,
    ]);
    const archive = path.join(input.localDirectory, "compose-source.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", checkout, "."], {
      signal,
      timeoutMs: 120_000,
    });
    await transition(
      hooks,
      "resolving_secrets",
      "Preparing runtime environment without logging secret values",
    );
    const environment = path.join(input.localDirectory, "compose.env");
    await writeFile(
      environment,
      Object.entries(secrets.runtime)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    await transition(hooks, "transferring", "Transferring Compose source");
    await session.upload(archive, remoteArchive, { signal });
    await session.upload(environment, `${remoteArchive}.env`, { signal });
    await transition(
      hooks,
      "building",
      "Validating and building Compose services",
    );
    await transition(hooks, "starting_candidate", "Starting Compose services");
    await transition(
      hooks,
      "checking_health",
      "Waiting for Compose health checks",
    );
    const { stdout } = await session.run(
      composeDeployScript,
      [
        remoteArchive,
        `${base}.staged-${context.deploymentId}`,
        base,
        previous,
        project,
        JSON.stringify(files),
        JSON.stringify(context.app.profiles),
        context.app.strategy,
        JSON.stringify(context.app.services),
        context.deployableId,
        context.sourceId,
        context.deploymentId,
      ],
      {
        signal,
        timeoutMs: 60 * 60_000,
        onStdout: (content) => hooks.log?.(content, "stdout"),
        onStderr: (content) => hooks.log?.(content, "stderr"),
      },
    );
    candidateStarted = true;
    const routingLine = stdout
      .split("\n")
      .find((line) => line.startsWith("TOWBAR_ROUTING="));
    if (!routingLine)
      throw new Error("Compose did not return its validated routing map");
    const routing = JSON.parse(
      routingLine.slice("TOWBAR_ROUTING=".length),
    ) as Array<{
      domains: string[];
      ingress: { type: "proxy" | "cloudflare-tunnel" };
      service: string;
      tls?: NormalizedComposeWorkload["services"][string]["tls"];
      upstreams: string[];
    }>;
    const servicesLine = stdout
      .split("\n")
      .find((line) => line.startsWith("TOWBAR_SERVICES="));
    const composeServices = servicesLine
      ? (JSON.parse(servicesLine.slice("TOWBAR_SERVICES=".length)) as string[])
      : [];
    if (!composeServices.length)
      throw new Error("Compose did not return its rendered service inventory");
    await transition(
      hooks,
      "configuring_routing",
      domainHandoffRoutingMessage(context) ??
        "Reconciling DNS and validating Compose routing",
    );
    const caddy = renderComposeCaddy(routing);
    const caddyFile = path.join(input.localDirectory, "compose.caddy");
    await writeFile(caddyFile, caddy, { mode: 0o600 });
    await session.upload(caddyFile, `${base}/app.caddy`, { signal });
    await uploadComposeDnsToken({
      context,
      secrets,
      session,
      signal,
      localDirectory: input.localDirectory,
      base,
    });
    await transition(
      hooks,
      "provisioning_tls",
      "Provisioning Compose TLS through Caddy",
    );
    await session.run(
      configureCaddyScript,
      [base, runtime, JSON.stringify(localDomainHandoffs(context))],
      {
        signal,
        timeoutMs: 180_000,
      },
    );
    cloudflareDnsTransition = await reconcileCloudflareForDeployment({
      app: context.app,
      appId: runtime,
      onDnsChange,
      handoffs: context.domainHandoffs,
      expectedRecords: cloudflareDnsExpectations,
      credentials: secrets.cloudflare,
      handoffDns: secrets.domainHandoffDns,
      server: context.server,
    });
    const tunnelRoutes = routing.filter(
      (route) => route.ingress.type === "cloudflare-tunnel",
    );
    if (tunnelRoutes.length) {
      if (!secrets.cloudflareTunnel)
        throw new Error("Cloudflare Tunnel credentials were not resolved");
      cloudflareTunnelTransition = await reconcileCloudflareTunnelRoutes({
        ...secrets.cloudflareTunnel,
        appId: runtime,
        onDnsChange,
        handoffs: context.domainHandoffs,
        expectedRecords: cloudflareDnsExpectations,
        hostnames: tunnelRoutes.flatMap((route) => route.domains),
        localDirectory: input.localDirectory,
        session,
      });
    }
    const digest = stdout.trim().split(/\s+/u).at(-1);
    if (!digest?.match(/^[a-f0-9]{64}$/u))
      throw new Error("Compose did not return a configuration digest");
    const result: DeploymentResult = {
      candidatePort: 0,
      candidatePorts: [],
      composeServices,
      containerName: project,
      containerNames: [project],
      imageDigest: `sha256:${digest}`,
      imagePlatform: "compose",
      imageTag: `compose:${project}`,
      warnings: [],
    };
    await transition(
      hooks,
      "switching_traffic",
      "Recording the healthy Compose release",
    );
    if (hooks.commitRelease) {
      commitAttempted = true;
      await hooks.commitRelease(result);
    }
    committed = true;
    await cleanupTransferredDomainRoutes(context, secrets).catch(() => {
      result.warnings.push(
        "The release is live, but previous domain routes need cleanup",
      );
    });
    await cleanupPreviousComposeDns({ context, secrets }).catch(async () => {
      const warning =
        "The release is live, but previous Cloudflare DNS records need cleanup";
      result.warnings.push(warning);
      await safeLog(
        hooks,
        `${warning}.\n`,
        "stderr",
        collectSensitiveValues(secrets),
      );
    });
    await (
      secrets.previousCloudflareTunnelCleanupBlocked
        ? Promise.reject(
            new Error("Previous tunnel credentials are unavailable"),
          )
        : cleanupCloudflareTunnelTransition({
            appId: runtime,
            current: secrets.cloudflareTunnel,
            previous: secrets.previousCloudflareTunnel,
            protectedHostnames: deploymentPublicHostnames(context.app),
            session,
          })
    ).catch(async () => {
      const warning =
        "The release is live, but the previous Cloudflare Tunnel needs cleanup";
      result.warnings.push(warning);
      await safeLog(
        hooks,
        `${warning}.\n`,
        "stderr",
        collectSensitiveValues(secrets),
      );
    });
    await cloudflareTunnelTransition?.finalize().catch(async () => {
      const warning =
        "The release is live, but Cloudflare Tunnel rollback state needs cleanup";
      result.warnings.push(warning);
      await safeLog(
        hooks,
        `${warning}.\n`,
        "stderr",
        collectSensitiveValues(secrets),
      );
    });
    await session.run(composeFinalizeScript, [previous, base], {
      signal,
      timeoutMs: 30_000,
    });
    await transition(hooks, "cleaning_up", "Compose deployment finalized");
    await transition(
      hooks,
      result.warnings.length ? "succeeded_with_warnings" : "succeeded",
      result.warnings.length
        ? "Compose deployment completed with post-deploy warnings"
        : "Compose deployment succeeded",
    );
    return result;
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    const boundary = resolveDeploymentFailureBoundary({
      commitAttempted,
      commitConfirmed: committed,
    });
    assertDomainRollbackSafe(error, boundary);
    if (boundary === "rollback") {
      await cloudflareDnsTransition?.rollback().catch(async (rollbackError) => {
        recoveryErrors.push(rollbackError);
        await hooks.log?.(
          "Cloudflare DNS rollback needs operator attention.\n",
          "stderr",
        );
      });
      await cloudflareTunnelTransition
        ?.rollback()
        .catch(async (rollbackError) => {
          recoveryErrors.push(rollbackError);
          await hooks.log?.(
            "Cloudflare Tunnel rollback needs operator attention.\n",
            "stderr",
          );
        });
    }
    throwIfDomainRecoveryFailed(context, recoveryErrors, error);
    if (candidateStarted && boundary === "rollback") {
      await session
        .run(
          composeRollbackScript,
          [
            base,
            previous,
            project,
            JSON.stringify(files),
            JSON.stringify(context.app.profiles),
            runtime,
          ],
          { signal: undefined, timeoutMs: 10 * 60_000 },
        )
        .catch(async (rollbackError) => {
          recoveryErrors.push(rollbackError);
          await hooks.log?.(
            `Compose rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}\n`,
            "stderr",
          );
        });
    }
    if (boundary === "committed") throw new DeploymentCommittedError(error);
    if (boundary === "commit-uncertain")
      throw new DeploymentCommitUncertainError(error);
    throwIfDomainRecoveryFailed(context, recoveryErrors, error);
    throw error;
  } finally {
    await session.close().catch(() => undefined);
  }
}

export function renderComposeCaddy(
  routes: Array<{
    domains: string[];
    ingress: { type: "proxy" | "cloudflare-tunnel" };
    upstreams: string[];
    tls?: NormalizedComposeWorkload["services"][string]["tls"] | null;
  }>,
) {
  const lines: string[] = [];
  for (const route of routes)
    for (const domain of route.domains) {
      const site =
        route.ingress.type === "cloudflare-tunnel"
          ? `http://${domain}`
          : domain;
      lines.push(
        `${site} {`,
        `  reverse_proxy ${route.upstreams.join(" ")} {`,
        "    lb_policy round_robin",
        "  }",
        '  header ?Strict-Transport-Security "max-age=15552000"',
        ...(route.tls?.mode === "cloudflare-dns"
          ? ["  tls {", "    dns cloudflare {env.CLOUDFLARE_API_TOKEN}", "  }"]
          : []),
        "}",
      );
    }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
