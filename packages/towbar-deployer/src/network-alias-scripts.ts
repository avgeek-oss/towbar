// Keep descriptor 9 open in the calling shell until Docker has attached the
// candidate. Apps and Resources use the same host lock, including across Sources.
// Python's flock locks the inherited open file description; exiting the helper
// does not release it while the shell still holds that descriptor.
export const dockerNetworkLockScript = String.raw`
if test -n "$network_alias"; then
  sudo install -d -m 0755 -o "$(id -u)" -g "$(id -g)" /var/lib/towbar/locks
  exec 9>/var/lib/towbar/locks/network-alias.lock
  python3 - <<'PYTHON'
import fcntl
import time

deadline = time.monotonic() + 60
while True:
    try:
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            raise SystemExit("Timed out waiting for Docker network alias ownership")
        time.sleep(0.1)
PYTHON
fi
`;

export const validateNetworkAliasScript = String.raw`
if test -n "$network_alias"; then
  test -n "$network_name"
  python3 - "$network_name" "$network_alias" "$previous_container" <<'PYTHON'
import json
import os
import subprocess
import sys

network_name, network_alias, previous_container = sys.argv[1:]
containers = subprocess.run(["docker", "ps", "-aq"], check=True, capture_output=True, text=True).stdout.splitlines()
for container_id in containers:
    result = subprocess.run(["docker", "container", "inspect", container_id], check=False, capture_output=True, text=True)
    if result.returncode != 0:
        continue
    container = json.loads(result.stdout)[0]
    name = container.get("Name", "").lstrip("/")
    network = (container.get("NetworkSettings", {}).get("Networks") or {}).get(network_name) or {}
    if network_alias not in (network.get("Aliases") or []) or name == previous_container:
        continue
    labels = (container.get("Config") or {}).get("Labels") or {}
    state = container.get("State") or {}
    owned = (
        labels.get("towbar.managed") == "true"
        and labels.get("towbar.deployable") == os.environ["TOWBAR_DEPLOYABLE_ID"]
        and labels.get("towbar.source") in {os.environ["TOWBAR_SOURCE_ID"], *json.loads(os.environ.get("TOWBAR_PREVIOUS_SOURCE_IDS_JSON", "[]"))}
    )
    if owned and state.get("Status") == "exited" and not state.get("Running") and not state.get("Restarting"):
        # A previous successful promotion may have deferred cleanup. Reclaim
        # only our obsolete, stopped container; preserve images and volumes.
        subprocess.run(["docker", "container", "rm", container_id], check=True, capture_output=True, text=True)
        continue
    raise SystemExit(f"Docker network alias '{network_alias}' is already used by container '{name}'")
PYTHON
fi
`;
