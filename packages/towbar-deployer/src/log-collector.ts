import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type NormalizedServer,
  logCollectorImage,
  logCollectorVersion,
} from "@workspace/towbar-core";
import { SshSession } from "./ssh.js";
import type { SshLoginSecret, TrustedHostKey } from "./types.js";
import { logDrainScript } from "./log-drain.js";
import { logDiscoveryScript } from "./log-discovery.js";

export type LogCollectorExecutionContext = {
  serverId: string;
  generation: string;
  desiredState: "enabled" | "disabled";
  config: NormalizedServer;
  login: SshLoginSecret;
  trustedHostKeys: TrustedHostKey[];
  endpoint: string;
  token: string | null;
};
export const logDiscoveryUnit = `[Unit]
Description=Towbar log discovery and collection
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=simple
User=root
UMask=0077
ExecStart=/usr/bin/python3 /usr/local/lib/towbar-logs/discovery.py
Restart=on-failure
RestartPreventExitStatus=77
RestartSec=15
CPUQuota=5%
MemoryMax=96M
TasksMax=32
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
PrivateTmp=true
ReadWritePaths=/var/lib/towbar-logs /run/docker.sock /var/run/docker.sock
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=60s
LogRateLimitBurst=5

[Install]
WantedBy=multi-user.target
`;
const stopOwnedCollectorScript = `
if docker container inspect towbar-log-collector >/dev/null 2>&1; then
  test "$(docker inspect --format '{{index .Config.Labels "towbar.component"}}' towbar-log-collector)" = log-collector
  test "$(docker inspect --format '{{index .Config.Labels "towbar.managed"}}' towbar-log-collector)" = true
  docker stop --time 20 towbar-log-collector >/dev/null
  docker rm towbar-log-collector >/dev/null
fi
`;
const validateCollectorPathsScript = `
for directory in /etc/towbar-logs /var/lib/towbar-logs /usr/local/lib/towbar-logs; do
  test ! -L "$directory"
  if test -e "$directory"; then
    test -d "$directory"
    test "$(stat -c '%u' "$directory")" = 0
    test -z "$(find "$directory" -maxdepth 0 -perm /022 -print -quit)"
  fi
done
`;
export const installLogCollectorScript = `set -euo pipefail
staging="$1"
image="$2"
install -d -m 0700 /run/towbar-logs-install
exec 9>/run/towbar-logs-install/lock
flock -w 120 9
command -v systemctl >/dev/null
command -v python3 >/dev/null
docker info >/dev/null
case "$(uname -m)" in x86_64|aarch64) ;; *) exit 1 ;; esac
${validateCollectorPathsScript}
systemctl stop towbar-log-discovery.service 2>/dev/null || true
${stopOwnedCollectorScript}
docker pull "$image" >/dev/null
install -d -m 0700 /etc/towbar-logs /var/lib/towbar-logs
install -d -m 0755 /usr/local/lib/towbar-logs
install -m 0600 "$staging/config.json" /etc/towbar-logs/config.json
install -m 0700 "$staging/discovery.py" /usr/local/lib/towbar-logs/discovery.py
install -m 0700 "$staging/drain.py" /usr/local/lib/towbar-logs/drain.py
install -m 0644 "$staging/discovery.service" /etc/systemd/system/towbar-log-discovery.service
systemctl daemon-reload
systemctl enable --now towbar-log-discovery.service
systemctl is-active --quiet towbar-log-discovery.service
`;
export const disableLogCollectorScript = `set -euo pipefail
install -d -m 0700 /run/towbar-logs-install
exec 9>/run/towbar-logs-install/lock
flock -w 120 9
${validateCollectorPathsScript}
systemctl disable --now towbar-log-discovery.service 2>/dev/null || true
${stopOwnedCollectorScript}
rm -f /etc/towbar-logs/config.json /var/lib/towbar-logs/collector.json
`;

export async function reconcileLogCollector(
  context: LogCollectorExecutionContext,
  signal?: AbortSignal,
) {
  const session = await SshSession.connect({
    server: context.config,
    login: context.login,
    trustedHostKeys: context.trustedHostKeys,
  });
  let staging: string | undefined, local: string | undefined;
  try {
    if (context.desiredState === "disabled") {
      await session.run(
        `sudo -n bash <<'TOWBAR_DISABLE_LOGS'\n${disableLogCollectorScript}\nTOWBAR_DISABLE_LOGS`,
        [],
        { signal, timeoutMs: 180000 },
      );
      return;
    }
    if (!context.config.hostLogCollection || !context.token)
      throw new Error("Log collection access is not available");
    staging = (
      await session.run("umask 077; mktemp -d /tmp/towbar-logs.XXXXXXXX", [], {
        signal,
        timeoutMs: 10000,
      })
    ).stdout.trim();
    if (!/^\/tmp\/towbar-logs\.[A-Za-z0-9]{8}$/u.test(staging))
      throw new Error("Unable to stage log collection installation");
    local = await mkdtemp(path.join(tmpdir(), "towbar-logs-"));
    const files = {
      "config.json": JSON.stringify({
        serverId: context.serverId,
        token: context.token,
        endpoint: context.endpoint,
        image: logCollectorImage,
        version: logCollectorVersion,
      }),
      "discovery.py": logDiscoveryScript,
      "drain.py": logDrainScript,
      "discovery.service": logDiscoveryUnit,
      "install.sh": installLogCollectorScript,
    };
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(local, name);
      await writeFile(file, content, { mode: 0o600 });
      await session.upload(file, `${staging}/${name}`, {
        signal,
        timeoutMs: 30000,
      });
    }
    await session.run(
      'sudo -n bash "$1/install.sh" "$1" "$2"',
      [staging, logCollectorImage],
      { signal, timeoutMs: 300000 },
    );
  } finally {
    if (staging)
      await session
        .run('rm -rf -- "$1"', [staging], { timeoutMs: 10000 })
        .catch(() => undefined);
    if (local) await rm(local, { recursive: true, force: true });
    await session.close();
  }
}
