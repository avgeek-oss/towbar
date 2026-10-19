import { buildkitCachePython } from "./buildkit-cache.js";
import { imageOwnershipPython } from "./image-ownership.js";
import {
  type ResourceOperationRequest,
  type ServerCleanupPlan,
  serverCleanupResultSchema,
} from "@workspace/towbar-core";
import type { SshSession } from "./ssh.js";

export async function executeServerCleanup(input: {
  session: SshSession;
  request: Extract<ResourceOperationRequest, { type: "cleanup_orphans" }>;
  expected: ServerCleanupPlan;
  signal?: AbortSignal;
}) {
  const { request } = input;
  const fullManual =
    request.trigger === "manual" &&
    request.scope !== "selected" &&
    !request.retiringDeployableIds?.length;
  const { stdout } = await input.session.run(
    cleanupOrphansScript,
    [
      JSON.stringify(request.items),
      JSON.stringify(input.expected),
      String(Boolean(request.trigger) && request.scope !== "selected"),
      String(fullManual),
    ],
    { signal: input.signal, timeoutMs: 5 * 60_000 },
  );
  const result = serverCleanupResultSchema.parse(JSON.parse(stdout));
  if (result.failures?.length || result.buildCache?.status === "failed") {
    throw Object.assign(
      new Error(
        "Server cleanup could not remove every eligible object. See the attempt results and retry.",
      ),
      { cleanupResult: result },
    );
  }
  return result;
}

export const cleanupOrphansScript = String.raw`
set -euo pipefail
python=(python3)
if test "${"$"}{3:-false}" = true; then python=(sudo python3); fi
"${"$"}{python[@]}" - "$1" "$2" "${"$"}{3:-false}" "${"$"}{4:-false}" <<'PYTHON'
import json, os, re, shutil, subprocess, sys, time
from pathlib import Path

items = json.loads(sys.argv[1])
expected = json.loads(sys.argv[2])
discover = sys.argv[3] == "true"
clean_build_cache = sys.argv[4] == "true"
owned = set(expected.get("ownedDeployableIds", []))
active = set(expected["deployableIds"])
protected = set(expected.get("protectedDeployableIds", []))
retiring = {item["deployableId"]: item for item in expected.get("retiring", [])} if discover else {}
cleaned, skipped, failures, retired, retired_paths = [], [], [], [], []
blocked = set()
log_drain_deadline = None
${buildkitCachePython}
${imageOwnershipPython}

def command(*args):
    return subprocess.run(args, check=False, capture_output=True, text=True)

def required(*args, failure="Unable to inspect cleanup state"):
    result = command(*args)
    if result.returncode: raise RuntimeError(failure + ": " + " ".join(args[:3]))
    return result.stdout

def inspect(kind, name):
    values = json.loads(required("docker", kind, "inspect", name))
    if not values: raise RuntimeError("Docker object disappeared during inspection")
    return values[0]

def labels_of(kind, value):
    return (value.get("Labels") or {}) if kind in ("volume", "network") else ((value.get("Config") or {}).get("Labels") or {})

def owner(labels, kind=None, name=None, value=None):
    if kind == "image" and value:
        recorded_owner = recorded_image_owner(name, value)
        if recorded_owner in owned:
            return recorded_owner
    deployable = labels.get("towbar.deployable")
    if deployable:
        if labels.get("towbar.managed") != "true" or not labels.get("towbar.source") or deployable not in owned:
            return None
        target = retiring.get(deployable)
        if target and labels["towbar.source"] not in {target["sourceId"], *target.get("previousSourceIds", [])}: return None
        return deployable
    # Older ingress and Compose objects omit Towbar's source/deployable labels.
    # Require the stored runtime/release identity and the original renderer's labels.
    matches = []
    for target_id, target in retiring.items():
        if labels.get("towbar.source") and labels["towbar.source"] not in {target["sourceId"], *target.get("previousSourceIds", [])}: continue
        if (kind == "container" and labels.get("towbar.managed") == "true"
            and labels.get("towbar.ingress") == "cloudflare-tunnel"
            and labels.get("towbar.app") in target["runtimeIds"]
            and name == "towbar-cloudflared-" + labels["towbar.app"]):
            matches.append(target_id)
        elif (kind in ("volume", "network") and labels.get("com.docker.compose.project") in target.get("composeProjects", [])
              and labels.get("com.docker.compose." + kind)):
            matches.append(target_id)
    return matches[0] if len(matches) == 1 else None

def containers():
    ids = required("docker", "ps", "-aq").splitlines()
    return [inspect("container", value) for value in ids]

protected_images = set()
for tag in expected["imageTags"]:
    result = command("docker", "image", "inspect", tag)
    if result.returncode == 0:
        protected_images.update(image["Id"] for image in json.loads(result.stdout))

if discover:
    items = []
    for kind, args in [
        ("container", ("ps", "-a", "--format", "{{.Names}}", "--filter", "label=towbar.managed=true")),
        ("volume", ("volume", "ls", "-q")),
        ("image", ("image", "ls", "--format", "{{.Repository}}:{{.Tag}}")),
    ]:
        for name in dict.fromkeys(required("docker", *args).splitlines()):
            if "<none>" in name: continue
            value = inspect(kind, name)
            if owner(labels_of(kind, value), kind, name, value):
                items.append({"kind": kind, "name": name, "reason": "Unused Towbar object"})
    for name in dict.fromkeys(required("docker", "image", "ls", "-q", "--no-trunc").splitlines()):
        value = inspect("image", name)
        if not has_image_tags(value) and owner(labels_of("image", value), "image", name, value):
            items.append({"kind": "image", "name": name, "reason": "Unused Towbar image"})

for item in sorted(items, key=lambda value: {"container": 0, "volume": 1, "image": 2}[value["kind"]]):
    kind, name = item["kind"], item["name"]
    value = inspect(kind, name)
    labels = labels_of(kind, value)
    deployable = owner(labels, kind, name, value)
    reason = None
    if not deployable: reason = "Ownership could not be verified"
    elif deployable in protected: reason = "Workload has pending work or a domain handoff"
    elif kind == "container":
        if (name in expected["containerNames"] or labels.get("com.docker.compose.project") in expected.get("composeProjects", [])
            or (deployable in active and value.get("State", {}).get("Running"))):
            reason = "Container is active or retained for rollback"
    elif kind == "volume":
        attached = required("docker", "ps", "-aq", "--filter", "volume=" + name).strip()
        host_logs = labels.get("towbar.storage") == "host-logs" and name == "towbar-host-logs-" + labels.get("towbar.runtime", "")
        if attached: reason = "Volume still has container references"
        elif deployable in active and not host_logs: reason = "Volume belongs to an active workload"
    elif kind == "image":
        if name in expected["imageTags"] or value["Id"] in protected_images:
            reason = "Image is retained for deployment or rollback"
        elif any(container.get("Image") == value["Id"] for container in containers()):
            reason = "Image still has container references"
    if reason:
        skipped.append({**item, "reason": reason})
        if deployable in retiring and kind in ("container", "volume"): blocked.add(deployable)
        continue
    if kind == "container" and Path("/usr/local/lib/towbar-logs/drain.py").is_file():
        if log_drain_deadline is None: log_drain_deadline = time.monotonic() + 8
        remaining = log_drain_deadline - time.monotonic()
        try:
            if remaining <= 0: raise subprocess.TimeoutExpired("log drain", 8)
            prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
            result = subprocess.run([*prefix, "python3", "/usr/local/lib/towbar-logs/drain.py", name], timeout=remaining, capture_output=True)
            if result.returncode: raise RuntimeError("Log drain was not confirmed")
        except (OSError, RuntimeError, subprocess.SubprocessError):
            print("Centralized logs could not confirm the final record before container cleanup.", file=sys.stderr)
    args = {"container": ("rm", "-f"), "volume": ("volume", "rm"), "image": ("image", "rm")}[kind]
    result = command("docker", *args, name)
    if kind == "image" and result.returncode == 0 and recorded_image_owner(name, value):
        remaining = command("docker", "image", "inspect", value["Id"])
        if remaining.returncode == 0 and not has_image_tags(json.loads(remaining.stdout)[0]):
            result = command("docker", "image", "rm", value["Id"])
    if result.returncode == 0: cleaned.append(item)
    else:
        failures.append({**item, "reason": "Docker refused removal; inspect usage and retry"})
        if deployable: blocked.add(deployable)

# Networks without per-workload ownership (including shared manifest networks) are retained.
if discover:
    for name in required("docker", "network", "ls", "-q").splitlines():
        value = inspect("network", name)
        deployable = owner(labels_of("network", value), "network", value["Name"])
        if deployable not in retiring or deployable in blocked: continue
        if value.get("Containers"):
            blocked.add(deployable)
            skipped.append({"kind": "network", "name": value["Name"], "reason": "Owned network still has container references"})
            continue
        result = command("docker", "network", "rm", name)
        if result.returncode:
            blocked.add(deployable)
            failures.append({"kind": "network", "name": value["Name"], "reason": "Owned network could not be removed"})
        else: retired_paths.append("docker-network:" + value["Name"])

def safe_path(path):
    for part in [path, *path.parents]:
        if part.is_symlink(): raise RuntimeError("Cleanup path traverses a symlink")
    return path

def apply_route_cleanup(candidates):
    routed = [candidate for candidate in candidates if candidate["routes"]]
    if not routed: return
    staged = []
    try:
        if not Path("/etc/caddy/Caddyfile").exists():
            raise RuntimeError("Caddy configuration is missing; route retirement cannot be verified")
        for candidate in routed:
            for path, backup in candidate["routes"]:
                if path.exists() and backup.exists():
                    raise RuntimeError("Route cleanup conflicts with an existing retirement backup")
                if path.exists(): os.replace(path, backup)
                elif not backup.exists(): raise RuntimeError("Route changed while preparing cleanup")
                staged.append((path, backup))
        # A .retiring file also requires a reload: a previous attempt may have
        # stopped after moving the route, before applying the new configuration.
        args = ["caddy", "validate", "--config", "/etc/caddy/Caddyfile"]
        if Path("/etc/caddy/towbar/cloudflare.env").exists():
            args += ["--envfile", "/etc/caddy/towbar/cloudflare.env"]
        required(*args, failure="Unable to validate Caddy route cleanup")
        # Cleanup does not change the service environment or rotate credentials.
        # ExecReload uses caddy.service's environment; no restart is needed.
        state = dict(line.split("=", 1) for line in required(
            "systemctl", "show", "caddy", "--property=ActiveState,Result",
            failure="Unable to inspect Caddy service state"
        ).splitlines() if "=" in line)
        if state.get("ActiveState") == "failed" and state.get("Result") == "start-limit-hit":
            # Earlier cleanup versions restarted per route and could exhaust the
            # service start limit. Recover that known failure once after validation.
            required("systemctl", "reset-failed", "caddy", failure="Unable to reset Caddy start limit")
            required("systemctl", "start", "caddy", failure="Unable to start Caddy after resetting its start limit")
        else:
            if state.get("ActiveState") in ("inactive", "failed"):
                raise RuntimeError("Caddy is " + state["ActiveState"] + "; start the Caddy service before retrying cleanup")
            required("systemctl", "reload", "caddy", failure="Unable to apply Caddy route cleanup")
    except Exception as error:
        rollback_failed = False
        for path, backup in reversed(staged):
            try:
                if backup.exists():
                    if path.exists(): raise RuntimeError("Route was replaced during cleanup")
                    os.replace(backup, path)
            except Exception:
                rollback_failed = True
        reason = str(error)
        if rollback_failed: reason += "; staged routes could not all be restored; resolve conflicting files before retrying"
        for candidate in routed:
            blocked.add(candidate["deployable"])
            failures.append({"kind": "route", "name": candidate["deployable"], "reason": reason[:500]})
        return
    for candidate in routed:
        try:
            for path, backup in candidate["routes"]:
                backup.unlink()
                retired_paths.append(str(path))
        except Exception:
            blocked.add(candidate["deployable"])
            failures.append({"kind": "route", "name": candidate["deployable"], "reason": "Caddy routes were applied, but retirement backups could not be removed; retry cleanup"})

candidates = []
for deployable, target in retiring.items():
    if deployable in blocked: continue
    try:
        if not re.fullmatch(r"[a-f0-9-]{36}", deployable): raise RuntimeError("Invalid workload identity")
        current = containers()
        if any(labels_of("container", container).get("towbar.deployable") == deployable
               or (labels_of("container", container).get("towbar.ingress") == "cloudflare-tunnel"
                   and labels_of("container", container).get("towbar.app") in target["runtimeIds"])
               for container in current):
            raise RuntimeError("Workload still has containers")
        paths = [Path("/var/lib/towbar/config-files") / deployable, Path("/var/lib/towbar/apps") / deployable, Path("/var/lib/towbar/resources") / deployable]
        for runtime in target["runtimeIds"]:
            if not re.fullmatch(re.escape(deployable) + r"(?:-preview-[a-f0-9]+)?", runtime): raise RuntimeError("Invalid runtime identity")
            paths += [Path("/var/lib/towbar/cloudflared") / runtime, Path("/var/lib/towbar/compose") / runtime]
            if runtime != deployable:
                paths += [Path("/var/lib/towbar/apps") / runtime, Path("/var/lib/towbar/resources") / runtime]
            paths += list(Path("/var/lib/towbar/compose").glob(runtime + ".*"))
        for path in paths:
            safe_path(path)
            if path.exists() and not path.is_dir(): raise RuntimeError("Expected a Towbar configuration directory")
            if any(mount.get("Source") == str(path) or mount.get("Source", "").startswith(str(path) + "/") or (mount.get("Source") and str(path).startswith(mount["Source"].rstrip("/") + "/"))
                   for container in current for mount in container.get("Mounts", [])):
                raise RuntimeError("Configuration path is still mounted")
        config_path = Path("/var/lib/towbar/config-files") / deployable
        if config_path.exists():
            for receipt in config_path.glob("*/receipt.json"):
                safe_path(receipt)
                identity = json.loads(receipt.read_text())
                if identity.get("deployableId") != deployable or identity.get("sourceId") not in {target["sourceId"], *target.get("previousSourceIds", [])}:
                    raise RuntimeError("Configuration receipt has different ownership")
        routes = []
        for runtime in dict.fromkeys(target["runtimeIds"]):
            path = safe_path(Path("/etc/caddy/towbar") / (runtime + ".caddy"))
            backup = safe_path(path.with_suffix(".caddy.retiring"))
            if any(value.exists() and not value.is_file() for value in (path, backup)):
                raise RuntimeError("Expected a Caddy route file")
            if path.exists() or backup.exists(): routes.append((path, backup))
        candidates.append({"deployable": deployable, "paths": paths, "routes": routes})
    except Exception as error:
        failures.append({"kind": "workload", "name": deployable, "reason": str(error)[:500]})

apply_route_cleanup(candidates)
for candidate in candidates:
    deployable = candidate["deployable"]
    if deployable in blocked: continue
    try:
        for path in candidate["paths"]:
            if path.exists():
                shutil.rmtree(path)
                retired_paths.append(str(path))
        retired.append(deployable)
    except Exception as error:
        failures.append({"kind": "workload", "name": deployable, "reason": str(error)[:500]})

result = {"cleaned": cleaned, "skipped": skipped, "failures": failures,
          "retiredDeployableIds": retired, "retiredPaths": retired_paths}
if clean_build_cache:
    try:
        result["buildCache"] = prune_buildkit_cache()
    except (OSError, subprocess.SubprocessError):
        result["buildCache"] = {"status": "failed", "message": "BuildKit cache cleanup failed; inspect Docker and retry cleanup."}
print(json.dumps(result, separators=(",", ":")))
PYTHON
`;
