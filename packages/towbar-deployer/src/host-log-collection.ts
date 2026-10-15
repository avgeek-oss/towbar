import { collectsHostDockerLogs } from "@workspace/towbar-core";
import type { DeploymentExecutionContext } from "./types.js";

export function validateHostLogCollection(context: DeploymentExecutionContext) {
  if (
    collectsHostDockerLogs(context.app) &&
    (!context.server.hostLogCollection || context.environment === "preview")
  )
    throw new Error(
      "Host Docker log collection requires an enabled server and a non-Preview deployment",
    );
}

export const readOnlyHostLogVolumePython = String.raw`
def ensure_read_only_host_log_volume(log_volume, log_directory, labels):
    options = {"type": "none", "device": str(log_directory), "o": "bind,ro,private"}
    existing = subprocess.run(["/usr/bin/docker", "volume", "ls", "-q"], check=True, capture_output=True, text=True)
    if log_volume in existing.stdout.splitlines():
        inspected = subprocess.run(["/usr/bin/docker", "volume", "inspect", log_volume], check=True, capture_output=True, text=True)
        volume = json.loads(inspected.stdout)[0]
        stored_options = volume.get("Options") or {}
        device = stored_options.get("device")
        if (volume.get("Driver") != "local"
            or any((volume.get("Labels") or {}).get(key) != value for key, value in labels.items())
            or set(stored_options) != set(options)
            or stored_options.get("type") != "none" or stored_options.get("o") != "bind,ro,private"
            or not isinstance(device, str) or not device.startswith("/") or not device.endswith("/containers")):
            raise SystemExit("Host log volume ownership or read-only source changed before startup")
        if stored_options != options:
            attached = subprocess.run(["/usr/bin/docker", "ps", "-aq", "--filter", "volume=" + log_volume], check=True, capture_output=True, text=True)
            if attached.stdout.strip():
                raise SystemExit("Host log volume still has container references to the previous Docker data-root")
            subprocess.run(["/usr/bin/docker", "volume", "rm", log_volume], check=True, capture_output=True, text=True)
    create = ["/usr/bin/docker", "volume", "create", "--driver", "local"]
    for key, value in options.items():
        create.extend(["--opt", key + "=" + value])
    for key, value in labels.items():
        create.extend(["--label", key + "=" + value])
    subprocess.run([*create, log_volume], check=True, capture_output=True, text=True)
    inspected = subprocess.run(["/usr/bin/docker", "volume", "inspect", log_volume], check=True, capture_output=True, text=True)
    volume = json.loads(inspected.stdout)[0]
    if volume.get("Driver") != "local" or volume.get("Options") != options or any((volume.get("Labels") or {}).get(key) != value for key, value in labels.items()):
        raise SystemExit("Host log volume ownership or read-only source changed before startup")
`;

export const hostLogRuntimeArgumentsScript = String.raw`
${readOnlyHostLogVolumePython}
if host_log_collection:
    inspected = subprocess.run(
        ["/usr/bin/docker", "info", "--format", "{{json .}}"],
        check=True, capture_output=True, text=True,
    )
    docker_info = json.loads(inspected.stdout)
    if any("rootless" in option or "userns" in option for option in docker_info.get("SecurityOptions", [])):
        raise SystemExit("Host log collection requires rootful Docker without user namespace remapping")
    docker_root = docker_info.get("DockerRootDir")
    if not isinstance(docker_root, str) or not docker_root.startswith("/") or any(character in docker_root for character in (",", "\n", "\r", "\x00")):
        raise SystemExit("Docker returned an unsafe data-root for host log collection")
    try:
        root = Path(docker_root).resolve(strict=True)
        log_directory = root / "containers"
        if not stat.S_ISDIR(log_directory.lstat().st_mode):
            raise SystemExit("Docker's container log directory must be a real directory under its data-root")
    except PermissionError:
        privileged = [] if os.geteuid() == 0 else ["/usr/bin/sudo", "-n"]
        def inspect_path(*arguments):
            try:
                return subprocess.run(
                    [*privileged, *arguments], capture_output=True, text=True,
                )
            except OSError:
                raise SystemExit("Host log collection could not inspect Docker's data-root; check passwordless sudo access") from None
        resolved_root = inspect_path("/usr/bin/readlink", "-e", "--", docker_root)
        if resolved_root.returncode:
            raise SystemExit("Host log collection could not inspect Docker's data-root; check passwordless sudo access")
        canonical_root = resolved_root.stdout.removesuffix("\n")
        if not canonical_root.startswith("/") or any(character in canonical_root for character in (",", "\n", "\r", "\x00")):
            raise SystemExit("Docker returned an unsafe data-root for host log collection")
        root = Path(canonical_root)
        log_directory = root / "containers"
        resolved_logs = inspect_path("/usr/bin/readlink", "-e", "--", str(log_directory))
        directory_check = inspect_path("/usr/bin/test", "-d", str(log_directory))
        if resolved_logs.returncode or directory_check.returncode or resolved_logs.stdout.removesuffix("\n") != str(log_directory):
            raise SystemExit("Docker's container log directory must be a real directory under its data-root")
    except (FileNotFoundError, NotADirectoryError):
        raise SystemExit("Docker's container log directory must be a real directory under its data-root") from None
    if any(character in str(root) for character in (",", "\n", "\r", "\x00")):
        raise SystemExit("Docker returned an unsafe data-root for host log collection")
    if root == Path("/"):
        raise SystemExit("Docker's container log directory must be a real directory under its data-root")
    # The local driver creates a non-recursive read-only bind. Docker then mounts
    # the volume privately, excluding existing and future host submounts.
    log_volume = "towbar-host-logs-" + runtime_identity["TOWBAR_APP_ID"]
    labels = {
        "towbar.managed": "true", "towbar.storage": "host-logs",
        "towbar.runtime": runtime_identity["TOWBAR_APP_ID"],
        "towbar.source": runtime_identity["TOWBAR_SOURCE_ID"],
        "towbar.deployable": runtime_identity["TOWBAR_DEPLOYABLE_ID"],
    }
    ensure_read_only_host_log_volume(log_volume, log_directory, labels)
    runtime_arguments.extend([
        "--mount", f"type=volume,src={log_volume},dst=/var/lib/docker/containers,readonly,volume-nocopy",
        "--user", "0:0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
        "--log-driver", "local", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
    ])
`;

export const reclaimHostLogVolumeScript = String.raw`
import json
import subprocess
import sys

runtime_id = sys.argv[1]
name = "towbar-host-logs-" + runtime_id
listed = subprocess.run(["docker", "volume", "ls", "-q"], check=True, capture_output=True, text=True)
if name not in listed.stdout.splitlines():
    sys.exit(0)
inspected = subprocess.run(["docker", "volume", "inspect", name], check=True, capture_output=True, text=True)
volume = json.loads(inspected.stdout)[0]
labels = volume.get("Labels") or {}
if (labels.get("towbar.managed") != "true" or labels.get("towbar.storage") != "host-logs"
    or labels.get("towbar.runtime") != runtime_id or labels.get("towbar.deployable") != runtime_id
    or not labels.get("towbar.source")):
    sys.exit(0)
attached = subprocess.run(["docker", "ps", "-aq", "--filter", "volume=" + name], check=True, capture_output=True, text=True)
if not attached.stdout.strip():
    subprocess.run(["docker", "volume", "rm", name], check=True, capture_output=True, text=True)
`;
