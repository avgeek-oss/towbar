export const buildkitCachePython = String.raw`
def prune_buildkit_cache():
    root = subprocess.run(
        ["docker", "info", "--format", "{{.DockerRootDir}}"],
        capture_output=True, text=True, timeout=20, check=True,
    ).stdout.strip()
    capacity = shutil.disk_usage(root).total
    budget = min(5 * 1024**3, capacity // 10)
    headroom = min(10 * 1024**3, capacity // 5)
    result = subprocess.run([
        "docker", "buildx", "prune", "--builder", "default", "--all", "--force",
        "--filter", "inuse=false", "--max-used-space", str(budget),
        "--min-free-space", str(headroom), "--reserved-space", "0",
    ], capture_output=True, text=True, timeout=120, check=True)
    summary = next((line.strip() for line in reversed(result.stdout.splitlines())
                    if line.strip().startswith("Total:")), "Unused cache checked")
    return {"status": "succeeded", "message": summary +
            f"; cache limit {budget // 1024**2} MiB; free-space target {headroom // 1024**2} MiB"}
`;

export const maintainBuildkitCacheScript = String.raw`
maintain_buildkit_cache() {
  python3 - <<'PYTHON'
import shutil, subprocess, sys
${buildkitCachePython}
try:
    print("BuildKit cache: " + prune_buildkit_cache()["message"], file=sys.stderr)
except (OSError, subprocess.SubprocessError):
    print("BuildKit cache maintenance failed; retry from server Docker cleanup.", file=sys.stderr)
PYTHON
}
maintain_buildkit_cache
trap maintain_buildkit_cache EXIT
`;

export const installBuildkitCacheTimerScript = String.raw`
"${"$"}{SUDO[@]}" install -d -m 0755 /usr/local/lib/towbar
"${"$"}{SUDO[@]}" tee /usr/local/lib/towbar/buildkit-cache.py >/dev/null <<'PYTHON'
import shutil, subprocess
${buildkitCachePython}
print(prune_buildkit_cache()["message"])
PYTHON
"${"$"}{SUDO[@]}" chmod 0644 /usr/local/lib/towbar/buildkit-cache.py
"${"$"}{SUDO[@]}" tee /etc/systemd/system/towbar-buildkit-cache.service >/dev/null <<'UNIT'
[Unit]
Description=Bound Towbar Docker BuildKit cache
After=docker.service
ConditionPathExists=/var/run/docker.sock

[Service]
Type=oneshot
ExecStart=/usr/bin/flock -n -E 0 /run/lock/towbar-buildkit-cache.lock /usr/bin/python3 /usr/local/lib/towbar/buildkit-cache.py
TimeoutStartSec=3min
Nice=10
IOSchedulingClass=idle
UNIT
"${"$"}{SUDO[@]}" tee /etc/systemd/system/towbar-buildkit-cache.timer >/dev/null <<'UNIT'
[Unit]
Description=Check Towbar BuildKit cache hourly

[Timer]
OnCalendar=hourly
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
"${"$"}{SUDO[@]}" chmod 0644 /etc/systemd/system/towbar-buildkit-cache.service /etc/systemd/system/towbar-buildkit-cache.timer
"${"$"}{SUDO[@]}" systemctl daemon-reload
"${"$"}{SUDO[@]}" systemctl enable --now towbar-buildkit-cache.timer >&2
`;
