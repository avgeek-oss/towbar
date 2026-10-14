export const cleanupOrphansScript = String.raw`
set -euo pipefail
python=(python3)
if test "${"$"}{3:-false}" = true; then python=(sudo python3); fi
"${"$"}{python[@]}" - "$1" "$2" "${"$"}{3:-false}" <<'PYTHON'
import json, os, re, shutil, subprocess, sys
from pathlib import Path

items = json.loads(sys.argv[1])
expected = json.loads(sys.argv[2])
discover = sys.argv[3] == "true"
owned = set(expected.get("ownedDeployableIds", []))
active = set(expected["deployableIds"])
protected = set(expected.get("protectedDeployableIds", []))
retiring = {item["deployableId"]: item for item in expected.get("retiring", [])} if discover else {}
cleaned, skipped, failures, retired, retired_paths = [], [], [], [], []
blocked = set()

def command(*args):
    return subprocess.run(args, check=False, capture_output=True, text=True)

def required(*args):
    result = command(*args)
    if result.returncode: raise RuntimeError("Unable to inspect cleanup state: " + " ".join(args[:3]))
    return result.stdout

def inspect(kind, name):
    values = json.loads(required("docker", kind, "inspect", name))
    if not values: raise RuntimeError("Docker object disappeared during inspection")
    return values[0]

def labels_of(kind, value):
    return (value.get("Labels") or {}) if kind in ("volume", "network") else ((value.get("Config") or {}).get("Labels") or {})

def owner(labels, kind=None, name=None):
    deployable = labels.get("towbar.deployable")
    if deployable:
        if labels.get("towbar.managed") != "true" or not labels.get("towbar.source") or deployable not in owned:
            return None
        target = retiring.get(deployable)
        if target and target["sourceId"] != labels["towbar.source"]: return None
        return deployable
    # Older ingress and Compose objects omit Towbar's source/deployable labels.
    # Require the stored runtime/release identity and the original renderer's labels.
    matches = []
    for target_id, target in retiring.items():
        if labels.get("towbar.source") and labels["towbar.source"] != target["sourceId"]: continue
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
        ("image", ("image", "ls", "--format", "{{.Repository}}:{{.Tag}}", "--filter", "label=towbar.managed=true")),
    ]:
        for name in dict.fromkeys(required("docker", *args).splitlines()):
            if "<none>" in name: continue
            value = inspect(kind, name)
            if owner(labels_of(kind, value), kind, name):
                items.append({"kind": kind, "name": name, "reason": "Unused Towbar object"})
    for name in dict.fromkeys(required("docker", "image", "ls", "-q", "--no-trunc", "--filter", "dangling=true", "--filter", "label=towbar.managed=true").splitlines()):
        if owner(labels_of("image", inspect("image", name)), "image", name):
            items.append({"kind": "image", "name": name, "reason": "Unused Towbar image"})

for item in sorted(items, key=lambda value: {"container": 0, "volume": 1, "image": 2}[value["kind"]]):
    kind, name = item["kind"], item["name"]
    value = inspect(kind, name)
    labels = labels_of(kind, value)
    deployable = owner(labels, kind, name)
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
    args = {"container": ("rm", "-f"), "volume": ("volume", "rm"), "image": ("image", "rm")}[kind]
    result = command("docker", *args, name)
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
            skipped.append({"kind": "container", "name": value["Name"], "reason": "Owned network still has container references"})
            continue
        result = command("docker", "network", "rm", name)
        if result.returncode:
            blocked.add(deployable)
            failures.append({"kind": "container", "name": deployable, "reason": "Owned network could not be removed"})
        else: retired_paths.append("docker-network:" + value["Name"])

def safe_path(path):
    for part in [path, *path.parents]:
        if part.is_symlink(): raise RuntimeError("Cleanup path traverses a symlink")
    return path

def retire_route(runtime):
    path = safe_path(Path("/etc/caddy/towbar") / (runtime + ".caddy"))
    backup = safe_path(path.with_suffix(".caddy.retiring"))
    if not Path("/etc/caddy/Caddyfile").exists() and (path.exists() or backup.exists() or command("systemctl", "is-active", "--quiet", "caddy").returncode == 0):
        raise RuntimeError("Caddy configuration is missing; route retirement cannot be verified")
    if path.exists(): os.replace(path, backup)
    # Reload even on retry: a previous worker may have stopped after moving the file.
    if Path("/etc/caddy/Caddyfile").exists():
        args = ["caddy", "validate", "--config", "/etc/caddy/Caddyfile"]
        cloudflare = Path("/etc/caddy/towbar/cloudflare.env").exists()
        if cloudflare: args += ["--envfile", "/etc/caddy/towbar/cloudflare.env"]
        try:
            required(*args)
            required("systemctl", "restart" if cloudflare else "reload", "caddy")
        except Exception:
            if backup.exists(): os.replace(backup, path)
            raise
    if backup.exists(): backup.unlink()
    retired_paths.append(str(path))

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
            if any(mount.get("Source") == str(path) or mount.get("Source", "").startswith(str(path) + "/") or (mount.get("Source") and str(path).startswith(mount["Source"].rstrip("/") + "/"))
                   for container in current for mount in container.get("Mounts", [])):
                raise RuntimeError("Configuration path is still mounted")
        config_path = Path("/var/lib/towbar/config-files") / deployable
        if config_path.exists():
            for receipt in config_path.glob("*/receipt.json"):
                safe_path(receipt)
                identity = json.loads(receipt.read_text())
                if identity.get("deployableId") != deployable or identity.get("sourceId") != target["sourceId"]:
                    raise RuntimeError("Configuration receipt has different ownership")
        for runtime in target["runtimeIds"]: retire_route(runtime)
        for path in paths:
            if path.exists():
                if not path.is_dir(): raise RuntimeError("Expected a Towbar configuration directory")
                shutil.rmtree(path)
                retired_paths.append(str(path))
        retired.append(deployable)
    except Exception as error:
        failures.append({"kind": "container", "name": deployable, "reason": str(error)[:500]})

print(json.dumps({"cleaned": cleaned, "skipped": skipped, "failures": failures,
                  "retiredDeployableIds": retired, "retiredPaths": retired_paths}, separators=(",", ":")))
PYTHON
`;
