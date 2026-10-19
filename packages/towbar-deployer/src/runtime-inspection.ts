import { z } from "zod";

import { orphanItemSchema } from "@workspace/towbar-core";

import type { SshSession } from "./ssh.js";
import { imageOwnershipPython } from "./image-ownership.js";
import type {
  RuntimeExpectation,
  RuntimeInspection,
} from "@workspace/towbar-core";

const inspectionSchema = z
  .object({
    orphans: z.array(orphanItemSchema),
    storage: z
      .array(
        z.object({
          deployableId: z.string(),
          runtimeId: z.string(),
          name: z.string(),
          volumeName: z.string(),
          mountPath: z.string(),
          mounted: z.boolean(),
        }),
      )
      .default([]),
    runtime: z.array(
      z
        .object({
          cpuPercent: z.number().nonnegative().nullable(),
          deployableId: z.string().uuid(),
          driftReasons: z.array(z.string()),
          driftStatus: z.enum(["drifted", "in_sync", "unknown"]),
          healthStatus: z.enum([
            "healthy",
            "none",
            "starting",
            "unhealthy",
            "unknown",
          ]),
          ingressContainerName: z.string().nullable(),
          ingressImage: z.string().nullable(),
          ingressRestartCount: z.number().int().nonnegative().nullable(),
          ingressStatus: z.enum([
            "disabled",
            "missing",
            "ready",
            "reconnecting",
            "stopped",
            "unknown",
          ]),
          memoryLimitBytes: z.number().int().nonnegative().nullable(),
          memoryUsageBytes: z.number().int().nonnegative().nullable(),
          observedContainerName: z.string().nullable(),
          observedImage: z.string().nullable(),
          observedState: z.enum(["missing", "running", "stopped", "unknown"]),
          restartCount: z.number().int().nonnegative().nullable(),
          startedAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const runtimeInspectionScript = String.raw`
set -euo pipefail
expected_json="$1"
python3 - "$expected_json" <<'PYTHON'
import json
import subprocess
import sys
import urllib.request
import re

expected = json.loads(sys.argv[1])
owned_deployables = set(expected["ownedDeployableIds"])
${imageOwnershipPython}

def owned(labels):
    return labels.get("towbar.managed") == "true" and bool(labels.get("towbar.source")) and labels.get("towbar.deployable") in owned_deployables

def command(*args):
    return subprocess.run(args, check=False, capture_output=True, text=True)

def inspect(kind, name):
    result = command("docker", kind, "inspect", name)
    if result.returncode != 0:
        return None
    value = json.loads(result.stdout)
    return value[0] if value else None

def parse_bytes(value):
    match = re.fullmatch(r"\s*([0-9.]+)\s*([KMGTPE]?i?B)\s*", value or "", re.IGNORECASE)
    if not match:
        return None
    amount = float(match.group(1))
    unit = match.group(2).lower()
    powers = {"b": 0, "kb": 1, "kib": 1, "mb": 2, "mib": 2, "gb": 3, "gib": 3, "tb": 4, "tib": 4, "pb": 5, "pib": 5, "eb": 6, "eib": 6}
    base = 1024 if "i" in unit else 1000
    return int(amount * (base ** powers[unit]))

def collect_runtime_stats():
    # Query running containers once. Compose release names identify a project,
    # so their concrete service containers are selected later by labels.
    result = command("docker", "stats", "--no-stream", "--format", "{{json .}}")
    if result.returncode != 0:
        return {}
    stats_by_name = {}
    for line in result.stdout.splitlines():
        try:
            stats = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = stats.get("Name") or stats.get("Container")
        if name:
            stats_by_name[name] = stats
    return stats_by_name

def runtime_metrics(container_name, container, stats_by_name):
    started_at = (container.get("State") or {}).get("StartedAt")
    if not started_at or started_at.startswith("0001-"):
        started_at = None
    stats = stats_by_name.get(container_name)
    if not stats:
        return {
            "cpuPercent": None,
            "memoryLimitBytes": None,
            "memoryUsageBytes": None,
            "restartCount": int(container.get("RestartCount") or 0),
            "startedAt": started_at,
        }
    try:
        memory_usage, _, memory_limit = (stats.get("MemUsage") or "").partition("/")
        return {
            "cpuPercent": float((stats.get("CPUPerc") or "").strip().rstrip("%")),
            "memoryLimitBytes": parse_bytes(memory_limit),
            "memoryUsageBytes": parse_bytes(memory_usage),
            "restartCount": int(container.get("RestartCount") or 0),
            "startedAt": started_at,
        }
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return {
            "cpuPercent": None,
            "memoryLimitBytes": None,
            "memoryUsageBytes": None,
            "restartCount": int(container.get("RestartCount") or 0),
            "startedAt": started_at,
        }

def evaluate_health(item, container, running):
    if not running:
        return "none"
    health = item["health"]
    health_type = health["type"]
    timeout = min(float(health.get("timeoutSeconds", 5)), 5.0)
    if health_type == "command":
        try:
            result = subprocess.run(
                ["docker", "exec", container.get("Name", "").lstrip("/"), *health["command"]],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return "healthy" if result.returncode == 0 else "unhealthy"
        except (OSError, subprocess.TimeoutExpired):
            return "unhealthy"
    if health_type == "http":
        connectivity = item.get("connectivity") or {}
        container_port = health.get("port") or connectivity.get("containerPort")
        port_key = f"{container_port}/tcp"
        bindings = (container.get("NetworkSettings", {}).get("Ports") or {}).get(port_key) or []
        host_port = next((binding.get("HostPort") for binding in bindings if binding.get("HostPort")), None)
        if not host_port:
            return "unhealthy"
        try:
            with urllib.request.urlopen(
                f'http://127.0.0.1:{host_port}{health["path"]}',
                timeout=timeout,
            ) as response:
                return "healthy" if response.status < 400 else "unhealthy"
        except Exception:
            return "unhealthy"
    health_value = (container.get("State", {}).get("Health") or {}).get("Status")
    return (
        "healthy" if health_value == "healthy" else
        "starting" if health_value == "starting" else
        "unhealthy" if health_value == "unhealthy" else
        "none"
    )

def inspect_ingress(item):
    if not item.get("ingress"):
        return {
            "ingressContainerName": None,
            "ingressImage": None,
            "ingressRestartCount": None,
            "ingressStatus": "disabled",
        }
    deployable_id = item["deployableId"]
    result = command(
        "docker", "ps", "-aq",
        "--filter", "label=towbar.managed=true",
        "--filter", "label=towbar.ingress=cloudflare-tunnel",
        "--filter", "label=towbar.app=" + deployable_id,
    )
    identifiers = [value for value in result.stdout.splitlines() if value]
    if result.returncode != 0:
        return {
            "ingressContainerName": None,
            "ingressImage": None,
            "ingressRestartCount": None,
            "ingressStatus": "unknown",
        }
    if len(identifiers) != 1:
        return {
            "ingressContainerName": None,
            "ingressImage": None,
            "ingressRestartCount": None,
            "ingressStatus": "missing" if not identifiers else "unknown",
        }
    container = inspect("container", identifiers[0])
    if not container:
        return {
            "ingressContainerName": None,
            "ingressImage": None,
            "ingressRestartCount": None,
            "ingressStatus": "unknown",
        }
    name = container.get("Name", "").lstrip("/") or None
    image = (container.get("Config") or {}).get("Image")
    running = bool((container.get("State") or {}).get("Running"))
    registered = False
    if running and name:
        logs = command("docker", "logs", "--tail", "100", name)
        combined = logs.stdout + "\n" + logs.stderr
        registered = bool(re.search(
            r"Registered tunnel connection|Connection [a-f0-9-]+ registered",
            combined,
        ))
    return {
        "ingressContainerName": name,
        "ingressImage": image,
        "ingressRestartCount": int(container.get("RestartCount") or 0),
        "ingressStatus": "ready" if registered else "reconnecting" if running else "stopped",
    }

expected_containers = set(expected["containerNames"])
expected_compose_projects = {
    item["release"]["containerName"]
    for item in expected["deployables"]
    if item.get("release") and item["release"].get("kind") == "compose"
}
expected_deployables = {item["deployableId"] for item in expected["deployables"]}
expected_images = set(expected["imageTags"])
runtime_stats = collect_runtime_stats()
runtime = []

for item in expected["deployables"]:
    deployable_id = item["deployableId"]
    desired = item["desiredState"]
    release = item.get("release")
    ingress = inspect_ingress(item)
    if not release:
        runtime.append({
            "cpuPercent": None,
            "deployableId": deployable_id,
            "driftReasons": [],
            "driftStatus": "unknown",
            "healthStatus": "unknown",
            **ingress,
            "memoryLimitBytes": None,
            "memoryUsageBytes": None,
            "observedContainerName": None,
            "observedImage": None,
            "observedState": "unknown",
            "restartCount": None,
            "startedAt": None,
        })
        continue
    if release.get("kind") == "compose":
        project = release["containerName"]
        names = command("docker", "ps", "-a", "--filter", "label=com.docker.compose.project=" + project, "--format", "{{.Names}}")
        containers = [inspect("container", name) for name in names.stdout.splitlines()]
        containers = [container for container in containers if container]
        if not containers:
            runtime.append({
                "cpuPercent": None, "deployableId": deployable_id,
                "driftReasons": ["Current Compose project has no containers"],
                "driftStatus": "drifted", "healthStatus": "unknown",
                **ingress,
                "memoryLimitBytes": None, "memoryUsageBytes": None,
                "observedContainerName": None, "observedImage": None,
                "observedState": "missing", "restartCount": None, "startedAt": None,
            })
            continue
        states = [bool((container.get("State") or {}).get("Running")) for container in containers]
        health_values = [(container.get("State", {}).get("Health") or {}).get("Status") for container in containers]
        reasons = []
        if ingress["ingressStatus"] not in ("disabled", "ready"):
            reasons.append("Cloudflare Tunnel is not ready")
        if desired == "running" and not all(states): reasons.append("One or more Compose services are stopped")
        if desired == "stopped" and any(states): reasons.append("One or more Compose services are running")
        if any(value == "unhealthy" for value in health_values): reasons.append("A Compose service health check is failing")
        for container in containers:
            labels = container.get("Config", {}).get("Labels") or {}
            if labels.get("towbar.source") not in {item["sourceId"], *item.get("previousSourceIds", [])} or labels.get("towbar.deployable") != deployable_id:
                reasons.append("Compose service predates Towbar ownership labels; redeploy before cleanup")
                break
        metrics = [runtime_metrics(container.get("Name", "").lstrip("/"), container, runtime_stats) for container in containers]
        def total(field):
            values = [value[field] for value in metrics if value[field] is not None]
            return sum(values) if values else None
        started = [value["startedAt"] for value in metrics if value["startedAt"]]
        health = (
            "unhealthy" if any(value == "unhealthy" for value in health_values) else
            "starting" if any(value == "starting" for value in health_values) else
            "healthy" if all(states) else "none"
        )
        runtime.append({
            "cpuPercent": total("cpuPercent"), "deployableId": deployable_id,
            "driftReasons": sorted(set(reasons)),
            "driftStatus": "drifted" if reasons else "in_sync",
            "healthStatus": health,
            **ingress,
            "memoryLimitBytes": total("memoryLimitBytes"),
            "memoryUsageBytes": total("memoryUsageBytes"),
            "observedContainerName": project,
            "observedImage": ", ".join(sorted(set((container.get("Config") or {}).get("Image", "") for container in containers))),
            "observedState": "running" if all(states) else "stopped" if not any(states) else "unknown",
            "restartCount": sum(value["restartCount"] or 0 for value in metrics),
            "startedAt": min(started) if started else None,
        })
        continue
    container = inspect("container", release["containerName"])
    if not container:
        runtime.append({
            "cpuPercent": None,
            "deployableId": deployable_id,
            "driftReasons": ["Current release container is missing"],
            "driftStatus": "drifted",
            "healthStatus": "unknown",
            **ingress,
            "memoryLimitBytes": None,
            "memoryUsageBytes": None,
            "observedContainerName": None,
            "observedImage": None,
            "observedState": "missing",
            "restartCount": None,
            "startedAt": None,
        })
        continue
    labels = container.get("Config", {}).get("Labels") or {}
    running = bool(container.get("State", {}).get("Running"))
    health = evaluate_health(item, container, running)
    image = container.get("Config", {}).get("Image")
    metrics = runtime_metrics(release["containerName"], container, runtime_stats)
    reasons = []
    if ingress["ingressStatus"] not in ("disabled", "ready"):
        reasons.append("Cloudflare Tunnel is not ready")
    if image != release["imageTag"]:
        reasons.append("Container image differs from the current release")
    if desired == "running" and not running:
        reasons.append("Container is stopped but Towbar expects it to run")
    if desired == "stopped" and running:
        reasons.append("Container is running but Towbar expects it to be stopped")
    if health == "unhealthy":
        reasons.append("Container health check is failing")
    if labels.get("towbar.source") not in {item["sourceId"], *item.get("previousSourceIds", [])} or labels.get("towbar.deployable") != deployable_id:
        reasons.append("Container predates Source ownership labels; redeploy before cleanup")
    for volume in item.get("volumes", []):
        if not any(m.get("Type") == "volume" and m.get("Name") == volume["name"] and m.get("Destination") == volume["mountPath"] and m.get("RW") for m in container.get("Mounts", [])):
            reasons.append("Persistent storage is not mounted at " + volume["mountPath"])
    connectivity = item.get("connectivity")
    if connectivity:
        network_name = connectivity.get("network")
        network_alias = connectivity.get("networkAlias")
        if network_name:
            network = (container.get("NetworkSettings", {}).get("Networks") or {}).get(network_name)
            if not network:
                reasons.append("Container is not attached to the configured Docker network")
            elif network_alias and network_alias not in (network.get("Aliases") or []):
                reasons.append("Container is missing its configured Docker network alias")
        host_port = connectivity.get("hostPort")
        if host_port:
            port_key = f'{connectivity["containerPort"]}/tcp'
            bindings = (container.get("NetworkSettings", {}).get("Ports") or {}).get(port_key) or []
            if not any(
                binding.get("HostIp") == "127.0.0.1"
                and binding.get("HostPort") == str(host_port)
                for binding in bindings
            ):
                reasons.append("Container is missing its configured loopback host port")
    runtime.append({
        **metrics,
        "deployableId": deployable_id,
        "driftReasons": reasons,
        "driftStatus": "drifted" if reasons else "in_sync",
        "healthStatus": health if running else "none",
        **ingress,
        "observedContainerName": container.get("Name", "").lstrip("/") or None,
        "observedImage": image,
        "observedState": "running" if running else "stopped",
    })

orphans = []
containers = command("docker", "ps", "-aq", "--filter", "label=towbar.managed=true")
for name in containers.stdout.splitlines():
    container = inspect("container", name)
    if not container:
        continue
    labels = container.get("Config", {}).get("Labels") or {}
    container_name = container.get("Name", "").lstrip("/")
    compose_project = labels.get("com.docker.compose.project")
    if owned(labels) and container_name not in expected_containers and compose_project not in expected_compose_projects:
        orphans.append({
            "kind": "container",
            "name": container_name,
            "reason": "Towbar container is not a current release",
        })

storage = []
volumes = command("docker", "volume", "ls", "-q", "--filter", "label=towbar.managed=true")
for name in volumes.stdout.splitlines():
    volume = inspect("volume", name)
    if not volume:
        continue
    labels = volume.get("Labels") or {}
    if owned(labels) and labels.get("towbar.storage") == "app":
        attached = command("docker", "ps", "-q", "--filter", "volume=" + name)
        mount_path = labels.get("towbar.mount-path", "")
        mounted = False
        for container_id in attached.stdout.splitlines():
            container = inspect("container", container_id)
            if not container:
                continue
            container_labels = (container.get("Config") or {}).get("Labels") or {}
            if not owned(container_labels) or container_labels.get("towbar.app") != labels.get("towbar.runtime"):
                continue
            for mount in container.get("Mounts", []):
                if mount.get("Name") == name and mount.get("Type") == "volume" and mount.get("RW"):
                    mount_path = mount.get("Destination", mount_path)
                    mounted = True
        storage.append({"deployableId": labels.get("towbar.deployable", ""),
                        "runtimeId": labels.get("towbar.runtime", ""),
                        "name": labels.get("towbar.volume", ""), "volumeName": name,
                        "mountPath": mount_path, "mounted": mounted})
    unused_host_logs = False
    if owned(labels) and labels.get("towbar.storage") == "host-logs" and name == "towbar-host-logs-" + labels.get("towbar.runtime", ""):
        attached = command("docker", "ps", "-aq", "--filter", "volume=" + name)
        unused_host_logs = attached.returncode == 0 and not attached.stdout.strip()
    if owned(labels) and (unused_host_logs or labels.get("towbar.deployable") not in expected_deployables):
        orphans.append({
            "kind": "volume",
            "name": name,
            "reason": "Host log volume has no container references" if unused_host_logs else "Persistent volume belongs to a removed deployable",
        })

protected_images = {image["Id"] for tag in expected_images if (image := inspect("image", tag))}
images = command("docker", "image", "ls", "-q", "--no-trunc")
for identifier in dict.fromkeys(images.stdout.splitlines()):
    image = inspect("image", identifier)
    if not image: continue
    name = next((tag for tag in image.get("RepoTags") or [] if tag.startswith("towbar/")), identifier)
    labels = (image.get("Config") or {}).get("Labels") or {}
    ledger_owned = recorded_image_owner(name, image) in owned_deployables
    if (owned(labels) or ledger_owned) and name not in expected_images and image["Id"] not in protected_images:
        orphans.append({
            "kind": "image",
            "name": name,
            "reason": "Towbar image is not retained by a current or previous release",
        })

orphans.sort(key=lambda item: (item["kind"], item["name"]))
print(json.dumps({"orphans": orphans, "runtime": runtime, "storage": storage}, separators=(",", ":")))
PYTHON
`;

export async function inspectServerRuntime(input: {
  containerNames: string[];
  deployables: RuntimeExpectation[];
  imageTags: string[];
  imageOwners?: Record<string, string>;
  ownedDeployableIds?: string[];
  session: SshSession;
}) {
  const { stdout } = await input.session.run(
    runtimeInspectionScript,
    [
      JSON.stringify({
        containerNames: input.containerNames,
        deployables: input.deployables,
        imageTags: input.imageTags,
        imageOwners: input.imageOwners,
        ownedDeployableIds:
          input.ownedDeployableIds ??
          input.deployables.map((item) => item.deployableId),
      }),
    ],
    { timeoutMs: 60_000 },
  );
  return parseRuntimeInspectionOutput(stdout);
}

export function parseRuntimeInspectionOutput(value: string) {
  return inspectionSchema.parse(JSON.parse(value)) as {
    orphans: z.infer<typeof orphanItemSchema>[];
    runtime: RuntimeInspection[];
    storage: Array<{
      deployableId: string;
      runtimeId: string;
      name: string;
      volumeName: string;
      mountPath: string;
      mounted: boolean;
    }>;
  };
}
