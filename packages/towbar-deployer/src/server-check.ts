import { HostKeyNotTrustedError, SshSession, scanHostKeys } from "./ssh.js";
import { inspectServerRuntime } from "./runtime-inspection.js";
import {
  instanceMetadataScript,
  parseInstanceMetadata,
} from "./instance-metadata.js";

import type {
  ServerCheckContext,
  ServerCheckResult,
  ServerCredentialVerificationResult,
} from "./types.js";

const preflightScript = String.raw`
set -euo pipefail
requires_cloudflare="$1"
. /etc/os-release
test "$ID" = ubuntu
command -v docker >/dev/null
docker version --format '{{.Server.Version}}' >/tmp/towbar-docker-version
command -v caddy >/dev/null
if test "$requires_cloudflare" = true; then caddy list-modules | grep -Fx dns.providers.cloudflare >/dev/null; fi
sudo -n /usr/bin/test -d /etc/caddy
read -r _ cpu_user cpu_nice cpu_system cpu_idle cpu_iowait cpu_irq cpu_softirq cpu_steal _ < /proc/stat
cpu_total_before=$((cpu_user + cpu_nice + cpu_system + cpu_idle + cpu_iowait + cpu_irq + cpu_softirq + cpu_steal))
cpu_idle_before=$((cpu_idle + cpu_iowait))
sleep 0.2
read -r _ cpu_user cpu_nice cpu_system cpu_idle cpu_iowait cpu_irq cpu_softirq cpu_steal _ < /proc/stat
cpu_total_after=$((cpu_user + cpu_nice + cpu_system + cpu_idle + cpu_iowait + cpu_irq + cpu_softirq + cpu_steal))
cpu_idle_after=$((cpu_idle + cpu_iowait))
cpu_usage="$(awk -v total="$((cpu_total_after - cpu_total_before))" -v idle="$((cpu_idle_after - cpu_idle_before))" 'BEGIN { if (total <= 0) print 0; else printf "%.2f", (total-idle)*100/total }')"
printf '%s\n' \
  "$PRETTY_NAME" \
  "$(cat /tmp/towbar-docker-version)" \
  "$(caddy version | awk '{print $1}')" \
  "$(df -Pk /var/lib/docker | awk 'NR==2 {print $4}')" \
  "$(df -Pk /var/lib/docker | awk 'NR==2 {print $2}')" \
  "$(getconf _NPROCESSORS_ONLN)" \
  "$cpu_usage" \
  "$(awk '{print $1}' /proc/loadavg)" \
  "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)" \
  "$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)" \
  "$(awk '{printf "%d", $1}' /proc/uptime)"
rm -f /tmp/towbar-docker-version
`;

export async function checkServer(
  context: ServerCheckContext,
): Promise<ServerCheckResult | ServerCredentialVerificationResult> {
  const discovered = await scanHostKeys(context.config);
  if (context.trustedHostKeys.length === 0) {
    throw new HostKeyNotTrustedError(discovered);
  }
  const session = await SshSession.connect({
    login: context.login,
    server: context.config,
    trustedHostKeys: context.trustedHostKeys,
  });
  try {
    if (context.purpose === "credential-verification") {
      return { hostKey: context.trustedHostKeys[0]! };
    }
    const { stdout } = await session.run(preflightScript, ["false"], {
      timeoutMs: 30_000,
    });
    const [
      operatingSystem,
      dockerVersion,
      caddyVersion,
      diskAvailable,
      diskTotal,
      cpuLogicalCount,
      cpuUsagePercent,
      loadAverage1m,
      memoryAvailable,
      memoryTotal,
      uptimeSeconds,
    ] = stdout.trim().split("\n");
    if (
      !operatingSystem ||
      !dockerVersion ||
      !caddyVersion ||
      !diskAvailable ||
      !diskTotal ||
      !cpuLogicalCount ||
      !cpuUsagePercent ||
      !loadAverage1m ||
      !memoryAvailable ||
      !memoryTotal ||
      !uptimeSeconds
    ) {
      throw new Error("Server preflight returned an incomplete result");
    }
    const instance = await session
      .run(instanceMetadataScript, [], { timeoutMs: 5_000 })
      .then(({ stdout }) => parseInstanceMetadata(stdout))
      .catch(() => null);
    const inspection = await inspectServerRuntime({
      containerNames: context.expectedContainerNames,
      deployables: context.expectedDeployables,
      imageTags: context.expectedImageTags,
      imageOwners: context.imageOwners,
      ownedDeployableIds: context.ownedDeployableIds,
      session,
    });
    return {
      caddyVersion,
      diskAvailableKb: Number(diskAvailable),
      dockerVersion,
      hostKey: context.trustedHostKeys[0]!,
      host: {
        instance,
        cpuLogicalCount: Number(cpuLogicalCount),
        cpuUsagePercent: Number(cpuUsagePercent),
        diskAvailableKb: Number(diskAvailable),
        diskTotalKb: Number(diskTotal),
        loadAverage1m: Number(loadAverage1m),
        memoryAvailableKb: Number(memoryAvailable),
        memoryTotalKb: Number(memoryTotal),
        uptimeSeconds: Number(uptimeSeconds),
      },
      operatingSystem,
      ...inspection,
    };
  } finally {
    await session.close();
  }
}
