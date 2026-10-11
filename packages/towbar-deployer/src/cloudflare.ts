import { DomainHandoffRecoveryRequiredError } from "./domain-routing.js";
import { deploymentTunnelHostnames } from "@workspace/towbar-core";
import type { DomainHandoff } from "@workspace/towbar-core";
import { isIP } from "node:net";
/* eslint-disable max-lines -- Cloudflare DNS and Tunnel lifecycle logic shares one fail-closed API contract and rollback model. */
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  NormalizedDeployable,
  NormalizedServer,
} from "@workspace/towbar-core";
import type { SshSession } from "./ssh.js";
import {
  deploymentCloudflareDnsDomains,
  deploymentCloudflareDnsProxy,
} from "@workspace/towbar-core";

const cloudflareApiBaseUrl = "https://api.cloudflare.com/client/v4";
const managedCommentPrefix = "Managed by Towbar:";

type CloudflareFetch = typeof fetch;
type DomainDnsCredentials = Record<
  string,
  { apiToken: string; zoneId?: string }
>;

export type CloudflareTunnelTransition = {
  finalize: () => Promise<unknown>;
  rollback: () => Promise<void>;
  tunnelId: string;
  tunnelName: string;
};

type CloudflareRecord = {
  comment?: string;
  content: string;
  id: string;
  name: string;
  proxied?: boolean;
  type: string;
  ttl?: number;
};

export type CloudflareDnsExpectations = Record<string, CloudflareRecord | null>;
export type CloudflareDnsTransition = { rollback: () => Promise<void> };
export type CloudflareDnsChange = {
  zoneId: string;
  before?: CloudflareRecord;
  after: CloudflareRecord;
};

type CloudflareTunnel = {
  config_src?: string;
  deleted_at?: string;
  id: string;
  metadata?: Record<string, string>;
  name: string;
};

type CloudflareEnvelope<T> = {
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
  success?: boolean;
};

class CloudflareRequestRejectedError extends Error {}

const managedTunnelMetadata = "managed_by";

export { deploymentPublicHostnames } from "@workspace/towbar-core";
export async function reconcileCloudflareTunnelForDeployment(input: {
  onDnsChange?: (change: CloudflareDnsChange) => Promise<void>;
  handoffs?: DomainHandoff[];
  expectedRecords?: CloudflareDnsExpectations;
  access: boolean;
  accountId: string;
  apiToken: string;
  app: NormalizedDeployable;
  appId: string;
  fetcher?: CloudflareFetch;
  image: string;
  localDirectory: string;
  session: SshSession;
  tunnelName?: string;
  zoneId?: string;
}) {
  if (input.app.ingress?.type !== "cloudflare-tunnel") return;
  if (!input.app.domains)
    throw new Error("Cloudflare Tunnel ingress requires a primary domain");
  return await reconcileCloudflareTunnelRoutes({
    ...input,
    hostnames: [
      input.app.domains.primary,
      ...input.app.domains.redirects.map((redirect) => redirect.host),
    ],
  });
}

export async function reconcileCloudflareTunnelRoutes(input: {
  onDnsChange?: (change: CloudflareDnsChange) => Promise<void>;
  handoffs?: DomainHandoff[];
  expectedRecords?: CloudflareDnsExpectations;
  access: boolean;
  accountId: string;
  apiToken: string;
  appId: string;
  fetcher?: CloudflareFetch;
  hostnames: string[];
  image: string;
  localDirectory: string;
  session: SshSession;
  tunnelName?: string;
  zoneId?: string;
}) {
  const fetcher = input.fetcher ?? fetch;
  const requestedName = input.tunnelName ?? `towbar-${input.appId}`;
  const hostnames = [...new Set(input.hostnames.map(normalizeHostname))];
  if (!hostnames.length)
    throw new Error("Cloudflare Tunnel requires at least one hostname");
  if (input.access) {
    for (const hostname of hostnames)
      await requireCloudflareAccessApplication({
        accountId: input.accountId,
        apiToken: input.apiToken,
        fetcher,
        hostname,
      });
  }
  const { created: tunnelCreated, tunnel } = await findOrCreateManagedTunnel({
    accountId: input.accountId,
    apiToken: input.apiToken,
    appId: input.appId,
    fetcher,
    name: requestedName,
  });
  let previousConfiguration: { config?: unknown } | undefined;
  let configurationAttempted = false;
  let localTransition:
    Awaited<ReturnType<typeof installCloudflared>> | undefined;
  const dnsRollbacks: Array<() => Promise<void>> = [];
  try {
    previousConfiguration = await cloudflareRequest<{ config?: unknown }>(
      `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}/configurations`,
      input.apiToken,
      fetcher,
    );
    const configuration = {
      config: {
        ingress: [
          ...hostnames.map((hostname) => ({
            hostname,
            originRequest: { httpHostHeader: hostname },
            service: "http://host.docker.internal:80",
          })),
          { service: "http_status:404" },
        ],
      },
    };
    configurationAttempted = true;
    await cloudflareRequest(
      `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}/configurations`,
      input.apiToken,
      fetcher,
      { body: configuration, method: "PUT" },
    );
    const token = await cloudflareRequest<string>(
      `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}/token`,
      input.apiToken,
      fetcher,
    );
    const connection = await installCloudflared({
      appId: input.appId,
      image: input.image,
      localDirectory: input.localDirectory,
      session: input.session,
      token,
    });
    localTransition = connection;
    for (const hostname of hostnames) {
      dnsRollbacks.push(
        await reconcileCloudflareTunnelDns({
          apiToken: input.apiToken,
          appId: input.appId,
          onDnsChange: input.onDnsChange,
          handoffs: input.handoffs,
          expectedRecords: input.expectedRecords,
          fetcher,
          hostname,
          tunnelId: tunnel.id,
          zoneId: input.zoneId,
        }),
      );
    }
    return {
      tunnelId: tunnel.id,
      tunnelName: tunnel.name,
      finalize: connection.finalize,
      rollback: async () => {
        const failures: unknown[] = [];
        for (const rollback of [...dnsRollbacks].reverse())
          await rollback().catch((error) => failures.push(error));
        preserveUnrecoveredTunnel(failures[0], failures, input.handoffs);
        if (!tunnelCreated && previousConfiguration)
          await cloudflareRequest(
            `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}/configurations`,
            input.apiToken,
            fetcher,
            { body: { config: previousConfiguration.config }, method: "PUT" },
          ).catch((error) => failures.push(error));
        if (tunnelCreated)
          await cloudflareRequest(
            `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}`,
            input.apiToken,
            fetcher,
            { method: "DELETE" },
          ).catch((error) => failures.push(error));
        await connection.rollback().catch((error) => failures.push(error));
        if (failures.length)
          throw new Error("Cloudflare Tunnel rollback did not fully complete", {
            cause: failures[0],
          });
      },
    };
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    preserveUnrecoveredTunnel(error, rollbackFailures, input.handoffs);
    for (const rollback of [...dnsRollbacks].reverse())
      await rollback().catch((failure) => rollbackFailures.push(failure));
    preserveUnrecoveredTunnel(error, rollbackFailures, input.handoffs);
    if (!tunnelCreated && configurationAttempted && previousConfiguration)
      await cloudflareRequest(
        `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}/configurations`,
        input.apiToken,
        fetcher,
        { body: { config: previousConfiguration.config }, method: "PUT" },
      ).catch((failure) => rollbackFailures.push(failure));
    if (tunnelCreated)
      await cloudflareRequest(
        `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}`,
        input.apiToken,
        fetcher,
        { method: "DELETE" },
      ).catch((failure) => rollbackFailures.push(failure));
    await localTransition
      ?.rollback()
      .catch((failure) => rollbackFailures.push(failure));
    preserveUnrecoveredTunnel(error, rollbackFailures, input.handoffs);
    if (rollbackFailures.length)
      throw new Error(
        "Cloudflare Tunnel reconciliation failed and rollback did not fully complete",
        { cause: error },
      );
    throw error;
  }
}

function preserveUnrecoveredTunnel(
  error: unknown,
  failures: unknown[],
  handoffs?: DomainHandoff[],
) {
  if (error instanceof DomainHandoffRecoveryRequiredError) throw error;
  if (failures.length && handoffs?.length)
    throw new DomainHandoffRecoveryRequiredError(error);
}

async function findOrCreateManagedTunnel(input: {
  accountId: string;
  apiToken: string;
  appId: string;
  fetcher: CloudflareFetch;
  name: string;
}) {
  const path = `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel?name=${encodeURIComponent(input.name)}&is_deleted=false&per_page=100`;
  const tunnels = await cloudflareRequest<CloudflareTunnel[]>(
    path,
    input.apiToken,
    input.fetcher,
  );
  if (tunnels.length > 1)
    throw new Error(
      `Cloudflare returned multiple tunnels named '${input.name}'`,
    );
  const existing = tunnels[0];
  if (existing) {
    if (
      existing.config_src !== "cloudflare" ||
      existing.metadata?.[managedTunnelMetadata] !== "towbar" ||
      existing.metadata?.towbar_resource_id !== input.appId
    )
      throw new Error(
        `Cloudflare Tunnel '${input.name}' is not owned by this Towbar workload`,
      );
    return { created: false, tunnel: existing };
  }
  return {
    created: true,
    tunnel: await cloudflareRequest<CloudflareTunnel>(
      `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel`,
      input.apiToken,
      input.fetcher,
      {
        body: {
          config_src: "cloudflare",
          metadata: {
            [managedTunnelMetadata]: "towbar",
            towbar_resource_id: input.appId,
          },
          name: input.name,
        },
        method: "POST",
      },
    ),
  };
}

async function requireCloudflareAccessApplication(input: {
  accountId: string;
  apiToken: string;
  fetcher: CloudflareFetch;
  hostname: string;
}) {
  const applications = await cloudflareRequest<
    Array<{ domain?: string; id?: string; type?: string }>
  >(
    `/accounts/${encodeURIComponent(input.accountId)}/access/apps?domain=${encodeURIComponent(input.hostname)}&exact=true&per_page=100`,
    input.apiToken,
    input.fetcher,
  );
  const application = applications.find(
    (candidate) =>
      candidate.type === "self_hosted" &&
      normalizeHostname(candidate.domain ?? "") === input.hostname,
  );
  if (!application?.id)
    throw new Error(
      `Cloudflare Access is required but no exact self-hosted application protects '${input.hostname}'`,
    );
  const policies = await cloudflareRequest<Array<{ decision?: string }>>(
    `/accounts/${encodeURIComponent(input.accountId)}/access/apps/${encodeURIComponent(application.id)}/policies?per_page=100`,
    input.apiToken,
    input.fetcher,
  );
  if (
    policies.some((policy) => policy.decision === "bypass") ||
    !policies.some((policy) =>
      ["allow", "service_auth"].includes(policy.decision ?? ""),
    )
  )
    throw new Error(
      `Cloudflare Access application '${input.hostname}' must have an allow or service-auth policy and cannot contain a bypass policy`,
    );
}

async function reconcileCloudflareTunnelDns(input: {
  onDnsChange?: (change: CloudflareDnsChange) => Promise<void>;
  handoffs?: DomainHandoff[];
  expectedRecords?: CloudflareDnsExpectations;
  apiToken: string;
  appId: string;
  fetcher: CloudflareFetch;
  hostname: string;
  tunnelId: string;
  zoneId?: string;
}) {
  const zoneId =
    input.zoneId ??
    (await findZoneId(
      input.hostname,
      input.apiToken,
      input.fetcher,
      new Map(),
    ));
  const records = await cloudflareRequest<CloudflareRecord[]>(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(input.hostname)}&per_page=100`,
    input.apiToken,
    input.fetcher,
  );
  const addressRecords = records.filter((record) =>
    ["A", "AAAA", "CNAME"].includes(record.type),
  );
  if (addressRecords.length > 1)
    throw new Error(
      `Cloudflare has multiple address records for '${input.hostname}'`,
    );
  const previous = addressRecords[0];
  const expectedComment = `${managedCommentPrefix} ${input.appId}`;
  assertExpectedRecord(input.hostname, previous, input.expectedRecords);
  if (
    previous &&
    previous.comment !== expectedComment &&
    !permittedDomainHandoff(input.hostname, previous, input.handoffs)
  )
    throw new Error(
      `Cloudflare record '${input.hostname}' is not owned by this Towbar workload`,
    );
  const body = {
    comment: expectedComment,
    content: `${input.tunnelId}.cfargotunnel.com`,
    name: input.hostname,
    proxied: true,
    ttl: 1,
    type: "CNAME",
  };
  const change: CloudflareDnsChange = {
    zoneId,
    before: previous,
    after: { ...body, id: previous?.id ?? "" },
  };
  await input.onDnsChange?.(change);
  try {
    const result = await cloudflareRequest<CloudflareRecord>(
      previous
        ? `/zones/${zoneId}/dns_records/${previous.id}`
        : `/zones/${zoneId}/dns_records`,
      input.apiToken,
      input.fetcher,
      { body, method: previous ? "PUT" : "POST" },
    );
    change.after.id = result.id;
    await input.onDnsChange?.(change);
    return async () =>
      rollbackCloudflareDns(
        { apiToken: input.apiToken, fetcher: input.fetcher },
        [change],
      );
  } catch (error) {
    try {
      await rollbackCloudflareDns(
        { apiToken: input.apiToken, fetcher: input.fetcher },
        [change],
      );
    } catch (rollbackError) {
      if (input.handoffs?.length)
        throw new DomainHandoffRecoveryRequiredError(error);
      throw new AggregateError(
        [error, rollbackError],
        "Cloudflare Tunnel DNS rollback needs reconciliation",
      );
    }
    throw error;
  }
}

const cloudflaredInstallScript = String.raw`set -euo pipefail
stage="$1"
runtime="$2"
image="$3"
app_id="$4"
base="/var/lib/towbar/cloudflared/$runtime"
name="towbar-cloudflared-$runtime"
sudo -n install -d -m 0700 "$base"
exec 9>"/tmp/towbar-cloudflared-$runtime.lock"
flock -w 30 9
digest="$(sha256sum "$stage/token" | awk '{print $1}')"
registered() {
  for attempt in $(seq 1 30); do
    test "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = true || return 1
    docker logs "$name" 2>&1 | tail -100 | grep -Eq 'Registered tunnel connection|Connection [a-f0-9-]+ registered' && return 0
    sleep 1
  done
  return 1
}
run_tunnel() {
  selected_image="$1"
  docker image inspect "$selected_image" >/dev/null 2>&1 || docker pull "$selected_image" >/dev/null
  docker run -d --name "$name" --add-host host.docker.internal:host-gateway --label towbar.managed=true --label towbar.ingress=cloudflare-tunnel --label "towbar.app=$app_id" --restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges --memory 192m --cpus 0.5 --pids-limit 96 --log-driver local --log-opt max-size=2m --log-opt max-file=2 --mount "type=bind,src=$base/token,dst=/run/secrets/tunnel-token,readonly" "$selected_image" tunnel --no-autoupdate --loglevel info --metrics 127.0.0.1:20241 run --token-file /run/secrets/tunnel-token >/dev/null
}
if sudo -n test -s "$base/digest" && test "$(sudo -n cat "$base/digest")" = "$digest" && sudo -n test -s "$base/image" && test "$(sudo -n cat "$base/image")" = "$image" && test "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = true && docker logs "$name" 2>&1 | tail -100 | grep -Eq 'Registered tunnel connection|Connection [a-f0-9-]+ registered'; then sudo -n rm -rf -- "$base/previous"; exit 0; fi
sudo -n rm -rf -- "$base/previous"
sudo -n install -d -m 0700 "$base/previous"
if sudo -n test -s "$base/token"; then sudo -n cp "$base/token" "$base/previous/token"; fi
if sudo -n test -s "$base/digest"; then sudo -n cp "$base/digest" "$base/previous/digest"; fi
if sudo -n test -s "$base/image"; then sudo -n cp "$base/image" "$base/previous/image"; fi
sudo -n install -m 0600 "$stage/token" "$base/token"
docker rm -f "$name" >/dev/null 2>&1 || true
if ! run_tunnel "$image" || ! registered; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  if sudo -n test -s "$base/previous/token" && sudo -n test -s "$base/previous/image"; then
    sudo -n cp "$base/previous/token" "$base/token"
    if sudo -n test -s "$base/previous/digest"; then sudo -n cp "$base/previous/digest" "$base/digest"; else sudo -n rm -f "$base/digest"; fi
    sudo -n cp "$base/previous/image" "$base/image"
    previous_image="$(sudo -n cat "$base/previous/image")"
    run_tunnel "$previous_image" && registered || true
  else
    sudo -n rm -f "$base/token" "$base/digest" "$base/image"
  fi
  sudo -n rm -rf -- "$base/previous"
  exit 1
fi
printf '%s' "$digest" | sudo -n tee "$base/digest" >/dev/null
printf '%s' "$image" | sudo -n tee "$base/image" >/dev/null
sudo -n chmod 0600 "$base/digest"
sudo -n chmod 0600 "$base/image"
rm -rf -- "$stage"
`;

const cloudflaredRollbackScript = String.raw`set -euo pipefail
runtime="$1"
app_id="$2"
base="/var/lib/towbar/cloudflared/$runtime"
name="towbar-cloudflared-$runtime"
docker rm -f "$name" >/dev/null 2>&1 || true
if ! sudo -n test -s "$base/previous/token" || ! sudo -n test -s "$base/previous/image"; then
  sudo -n rm -rf -- "$base"
  exit 0
fi
sudo -n cp "$base/previous/token" "$base/token"
sudo -n cp "$base/previous/image" "$base/image"
if sudo -n test -s "$base/previous/digest"; then sudo -n cp "$base/previous/digest" "$base/digest"; else sudo -n rm -f "$base/digest"; fi
image="$(sudo -n cat "$base/image")"
docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null
docker run -d --name "$name" --add-host host.docker.internal:host-gateway --label towbar.managed=true --label towbar.ingress=cloudflare-tunnel --label "towbar.app=$app_id" --restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges --memory 192m --cpus 0.5 --pids-limit 96 --log-driver local --log-opt max-size=2m --log-opt max-file=2 --mount "type=bind,src=$base/token,dst=/run/secrets/tunnel-token,readonly" "$image" tunnel --no-autoupdate --loglevel info --metrics 127.0.0.1:20241 run --token-file /run/secrets/tunnel-token >/dev/null
ready=false
for attempt in $(seq 1 30); do
  if test "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = true && docker logs "$name" 2>&1 | tail -100 | grep -Eq 'Registered tunnel connection|Connection [a-f0-9-]+ registered'; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
sudo -n rm -rf -- "$base/previous"
`;

const cloudflaredFinalizeScript = String.raw`set -euo pipefail
runtime="$1"
sudo -n rm -rf -- "/var/lib/towbar/cloudflared/$runtime/previous"
`;

async function installCloudflared(input: {
  appId: string;
  image: string;
  localDirectory: string;
  session: SshSession;
  token: string;
}) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(input.appId))
    throw new Error("Cloudflare Tunnel runtime identity is invalid");
  const runtime = input.appId;
  const stage = (
    await input.session.run(
      "umask 077; mktemp -d /tmp/towbar-cloudflared.XXXXXXXX",
      [],
      {
        timeoutMs: 10_000,
      },
    )
  ).stdout.trim();
  if (!/^\/tmp\/towbar-cloudflared\.[A-Za-z0-9]{8}$/u.test(stage))
    throw new Error("Unable to stage Cloudflare Tunnel token");
  const tokenFile = path.join(
    input.localDirectory,
    `cloudflared-${runtime}.token`,
  );
  try {
    await writeFile(tokenFile, input.token, { mode: 0o600 });
    await input.session.upload(tokenFile, `${stage}/token`, {
      timeoutMs: 30_000,
    });
    await input.session.run(
      cloudflaredInstallScript,
      [stage, runtime, input.image, input.appId],
      {
        timeoutMs: 180_000,
      },
    );
    return {
      finalize: async () =>
        input.session.run(cloudflaredFinalizeScript, [runtime], {
          timeoutMs: 30_000,
        }),
      rollback: async () =>
        input.session.run(cloudflaredRollbackScript, [runtime, input.appId], {
          timeoutMs: 180_000,
        }),
    };
  } finally {
    await rm(tokenFile, { force: true });
    await input.session
      .run('rm -rf -- "$1"', [stage], { timeoutMs: 10_000 })
      .catch(() => undefined);
  }
}

export async function reconcileCloudflareForDeployment(input: {
  app: NormalizedDeployable;
  appId?: string;
  onDnsChange?: (change: CloudflareDnsChange) => Promise<void>;
  handoffs?: DomainHandoff[];
  expectedRecords?: CloudflareDnsExpectations;
  credentials: { apiToken: string } | null;
  handoffDns?: DomainDnsCredentials;
  server: NormalizedServer;
}) {
  const proxiedDomains = deploymentCloudflareDnsProxy(input.app);
  const dnsDomains = Object.keys(proxiedDomains);
  const domains = [
    ...new Set([
      ...dnsDomains,
      ...handoffDnsDomains(input.app, input.handoffs),
    ]),
  ];
  if (!domains.length) return;
  if (dnsDomains.length) {
    if (!input.credentials)
      throw new Error("Cloudflare DNS credentials were not resolved");
    await verifyCloudflareTlsMode({
      apiToken: input.credentials.apiToken,
      domains: dnsDomains.filter((hostname) => proxiedDomains[hostname]),
    });
  }
  return await reconcileCloudflareDns({
    apiToken: input.credentials?.apiToken ?? "",
    handoffDns: input.handoffDns,
    allowUnmanagedAdoption: true,
    appId: input.appId ?? input.app.id,
    onDnsChange: input.onDnsChange,
    handoffs: input.handoffs,
    expectedRecords: input.expectedRecords,
    domains,
    releaseOwnershipDomains: domains.filter(
      (hostname) => !dnsDomains.includes(hostname),
    ),
    serverIp: input.server.ip,
    proxiedDomains,
  });
}

export async function reconcileCloudflareDns(input: {
  apiToken: string;
  handoffDns?: DomainDnsCredentials;
  releaseOwnershipDomains?: string[];
  allowUnmanagedAdoption?: boolean;
  onDnsChange?: (change: CloudflareDnsChange) => Promise<void>;
  handoffs?: DomainHandoff[];
  expectedRecords?: CloudflareDnsExpectations;
  appId: string;
  domains: string[];
  fetcher?: CloudflareFetch;
  serverIp: string;
  proxiedDomains?: Record<string, boolean>;
}) {
  const changes: CloudflareDnsChange[] = [];
  const rollback = () => rollbackCloudflareDns(input, changes);
  try {
    await reconcileCloudflareDnsRecords(input, changes);
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      if (input.handoffs?.length)
        throw new DomainHandoffRecoveryRequiredError(error);
      throw new AggregateError(
        [error, rollbackError],
        "Cloudflare DNS reconciliation failed; rollback needs operator attention",
      );
    }
    throw error;
  }
  return { rollback } satisfies CloudflareDnsTransition;
}

async function domainDnsCredential(
  input: { apiToken: string; handoffDns?: DomainDnsCredentials },
  hostname: string,
  fetcher: CloudflareFetch,
  zoneCache: Map<string, string>,
) {
  const credential = input.handoffDns?.[hostname];
  const apiToken = credential?.apiToken ?? input.apiToken;
  if (!apiToken)
    throw new Error("Cloudflare DNS credentials were not resolved");
  return {
    apiToken,
    zoneId:
      credential?.zoneId ??
      (await findZoneId(hostname, apiToken, fetcher, zoneCache)),
  };
}

async function recordPendingDnsCreate(
  change: CloudflareDnsChange,
  changes: CloudflareDnsChange[],
  onDnsChange?: (change: CloudflareDnsChange) => Promise<void>,
) {
  changes.push(change);
  try {
    await onDnsChange?.(change);
  } catch (error) {
    changes.pop();
    throw error;
  }
}

async function reconcileCloudflareDnsRecords(
  input: {
    apiToken: string;
    handoffDns?: DomainDnsCredentials;
    releaseOwnershipDomains?: string[];
    allowUnmanagedAdoption?: boolean;
    onDnsChange?: (change: CloudflareDnsChange) => Promise<void>;
    handoffs?: DomainHandoff[];
    expectedRecords?: CloudflareDnsExpectations;
    appId: string;
    domains: string[];
    fetcher?: CloudflareFetch;
    serverIp: string;
    proxiedDomains?: Record<string, boolean>;
  },
  changes: CloudflareDnsChange[],
) {
  const fetcher = input.fetcher ?? fetch;
  const recordType = isIP(input.serverIp) === 6 ? "AAAA" : "A";
  const zoneCache = new Map<string, string>();
  for (const hostname of new Set(input.domains.map(normalizeHostname))) {
    const { apiToken, zoneId } = await domainDnsCredential(
      input,
      hostname,
      fetcher,
      zoneCache,
    );
    const records = await cloudflareRequest<CloudflareRecord[]>(
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
      apiToken,
      fetcher,
    );
    const conflicting = records.filter(
      (record) =>
        record.type === "A" ||
        record.type === "AAAA" ||
        record.type === "CNAME",
    );
    if (conflicting.length > 1) {
      throw new Error(
        `Cloudflare has multiple address records for '${hostname}'; resolve the conflict before deploying`,
      );
    }

    const existing = conflicting[0];
    assertExpectedRecord(hostname, existing, input.expectedRecords);
    const transfer = permittedDomainHandoff(hostname, existing, input.handoffs);
    const expectedComment = `${managedCommentPrefix} ${input.appId}`;
    const body = {
      comment: input.releaseOwnershipDomains?.includes(hostname)
        ? ""
        : expectedComment,
      content: input.serverIp,
      name: hostname,
      proxied: input.proxiedDomains?.[hostname] ?? true,
      ttl: 1,
      type: recordType,
    };
    if (!existing) {
      const change = { zoneId, after: { ...body, id: "" } };
      await recordPendingDnsCreate(change, changes, input.onDnsChange);
      try {
        const created = await cloudflareRequest<CloudflareRecord>(
          `/zones/${zoneId}/dns_records`,
          apiToken,
          fetcher,
          { body, method: "POST" },
        );
        if (!created.id)
          throw new Error(
            "Cloudflare did not return the created DNS record identity",
          );
        change.after.id = created.id;
        await input.onDnsChange?.(change);
      } catch (error) {
        if (error instanceof CloudflareRequestRejectedError) changes.pop();
        throw error;
      }
      continue;
    }
    if (
      existing.comment?.startsWith(managedCommentPrefix) &&
      existing.comment !== expectedComment &&
      !transfer
    ) {
      throw new Error(
        `Cloudflare record '${hostname}' is owned by another Towbar app`,
      );
    }
    if (
      existing.comment !== expectedComment &&
      !transfer &&
      !canAdoptDnsRecord(input, existing, recordType)
    ) {
      throw new Error(
        `Cloudflare record '${hostname}' is not managed by Towbar for this app`,
      );
    }
    if (!sameDnsTarget(existing, body)) {
      changes.push({
        zoneId,
        before: existing,
        after: { ...body, id: existing.id },
      });
      await input.onDnsChange?.(changes[changes.length - 1]!);
      await cloudflareRequest(
        `/zones/${zoneId}/dns_records/${existing.id}`,
        apiToken,
        fetcher,
        { body, method: "PATCH" },
      );
    }
  }
}

export async function rollbackCloudflareDns(
  input: {
    apiToken: string;
    handoffDns?: DomainDnsCredentials;
    fetcher?: CloudflareFetch;
  },
  changes: CloudflareDnsChange[],
) {
  const fetcher = input.fetcher ?? fetch;
  const errors: unknown[] = [];
  for (const change of [...changes].reverse()) {
    try {
      const apiToken =
        input.handoffDns?.[normalizeHostname(change.after.name)]?.apiToken ??
        input.apiToken;
      if (!apiToken)
        throw new Error("DNS credentials are unavailable for domain recovery");
      if (!change.after.id)
        throw new Error("The DNS write outcome is uncertain");
      const records = await cloudflareRequest<CloudflareRecord[]>(
        `/zones/${change.zoneId}/dns_records?name=${encodeURIComponent(change.after.name)}&per_page=100`,
        apiToken,
        fetcher,
      );
      const current = records.find(({ id }) => id === change.after.id);
      if (!current) {
        if (change.before)
          throw new Error(
            `DNS record '${change.after.name}' was removed after reconciliation`,
          );
        continue;
      }
      if (sameDnsRecord(current, change.before)) continue;
      if (!sameDnsRecord(current, change.after))
        throw new Error(
          `DNS record '${change.after.name}' changed after reconciliation`,
        );
      await cloudflareRequest(
        `/zones/${change.zoneId}/dns_records/${current.id}`,
        apiToken,
        fetcher,
        change.before
          ? {
              method: "PATCH",
              body: {
                comment: change.before.comment ?? "",
                content: change.before.content,
                name: change.before.name,
                proxied: change.before.proxied ?? false,
                ttl: change.before.ttl ?? 1,
                type: change.before.type,
              },
            }
          : { method: "DELETE" },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Cloudflare DNS rollback needs operator attention",
    );
}

function sameDnsRecord(left: CloudflareRecord, right?: CloudflareRecord) {
  return (
    right !== undefined &&
    left.id === right.id &&
    normalizeHostname(left.name) === normalizeHostname(right.name) &&
    sameDnsTarget(left, right) &&
    (left.ttl ?? 1) === (right.ttl ?? 1)
  );
}

function sameDnsTarget(
  left: CloudflareRecord,
  right: Pick<CloudflareRecord, "type" | "content" | "comment" | "proxied">,
) {
  return (
    left.type === right.type &&
    left.content === right.content &&
    (left.comment ?? "") === (right.comment ?? "") &&
    (left.proxied ?? false) === (right.proxied ?? false)
  );
}

export async function cleanupCloudflareDnsTransition(input: {
  appId: string;
  previous: { apiToken: string; hostnames: string[] } | null;
  protectedHostnames: string[];
  managedHostnames: string[];
  fetcher?: CloudflareFetch;
}) {
  if (!input.previous) return;
  const protectedHostnames = new Set(
    input.protectedHostnames.map(normalizeHostname),
  );
  const managedHostnames = new Set(
    input.managedHostnames.map(normalizeHostname),
  );
  const fetcher = input.fetcher ?? fetch;
  const zoneCache = new Map<string, string>();
  for (const hostname of new Set(
    input.previous.hostnames.map(normalizeHostname),
  )) {
    if (managedHostnames.has(hostname)) continue;
    const zoneId = await findZoneId(
      hostname,
      input.previous.apiToken,
      fetcher,
      zoneCache,
    );
    const records = await cloudflareRequest<CloudflareRecord[]>(
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
      input.previous.apiToken,
      fetcher,
    );
    for (const record of records) {
      if (
        record.comment !== `${managedCommentPrefix} ${input.appId}` ||
        (record.type !== "A" && record.type !== "AAAA")
      )
        continue;
      await cloudflareRequest(
        `/zones/${zoneId}/dns_records/${record.id}`,
        input.previous.apiToken,
        fetcher,
        protectedHostnames.has(hostname)
          ? { method: "PATCH", body: { name: record.name, comment: "" } }
          : { method: "DELETE" },
      );
    }
  }
}

export async function deleteCloudflarePreviewDns(input: {
  apiToken: string;
  appId: string;
  fetcher?: CloudflareFetch;
  hostname: string;
}) {
  const fetcher = input.fetcher ?? fetch;
  const hostname = normalizeHostname(input.hostname);
  const zoneId = await findZoneId(hostname, input.apiToken, fetcher, new Map());
  const records = await cloudflareRequest<CloudflareRecord[]>(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
    input.apiToken,
    fetcher,
  );
  const expectedComment = `${managedCommentPrefix} ${input.appId}`;
  for (const record of records) {
    if (record.comment !== expectedComment) continue;
    await cloudflareRequest(
      `/zones/${zoneId}/dns_records/${record.id}`,
      input.apiToken,
      fetcher,
      { method: "DELETE" },
    );
  }
}

export async function deleteCloudflareTunnelDeployment(input: {
  accountId: string;
  apiToken: string;
  appId: string;
  fetcher?: CloudflareFetch;
  hostname: string;
  tunnelName?: string;
  zoneId?: string;
}) {
  const fetcher = input.fetcher ?? fetch;
  const name = input.tunnelName ?? `towbar-${input.appId}`;
  await deleteOwnedCloudflareTunnelDns({
    apiToken: input.apiToken,
    appId: input.appId,
    fetcher,
    hostnames: [input.hostname],
    zoneId: input.zoneId,
  });
  await deleteManagedCloudflareTunnel({
    accountId: input.accountId,
    apiToken: input.apiToken,
    appId: input.appId,
    fetcher,
    name,
  });
}

export async function cleanupCloudflareTunnelTransition(input: {
  appId: string;
  current: {
    accountId: string;
    tunnelName?: string;
  } | null;
  previous: {
    accountId: string;
    apiToken: string;
    hostnames: string[];
    tunnelName?: string;
    zoneId?: string;
  } | null;
  protectedHostnames: string[];
  session: SshSession;
}) {
  if (!input.previous) return;
  const previousName = input.previous.tunnelName ?? `towbar-${input.appId}`;
  const currentName = input.current?.tunnelName ?? `towbar-${input.appId}`;
  const sameTunnel =
    input.current?.accountId === input.previous.accountId &&
    currentName === previousName;
  const protectedHostnames = new Set(
    input.protectedHostnames.map(normalizeHostname),
  );
  await deleteOwnedCloudflareTunnelDns({
    apiToken: input.previous.apiToken,
    appId: input.appId,
    fetcher: fetch,
    hostnames: input.previous.hostnames.filter(
      (hostname) => !protectedHostnames.has(normalizeHostname(hostname)),
    ),
    zoneId: input.previous.zoneId,
  });
  if (!sameTunnel)
    await deleteManagedCloudflareTunnel({
      accountId: input.previous.accountId,
      apiToken: input.previous.apiToken,
      appId: input.appId,
      fetcher: fetch,
      name: previousName,
    });
  if (!input.current)
    await input.session.run(
      'set -euo pipefail\nruntime="$1"\ndocker rm -f "towbar-cloudflared-$runtime" >/dev/null 2>&1 || true\nsudo -n rm -rf -- "/var/lib/towbar/cloudflared/$runtime"',
      [input.appId],
      { timeoutMs: 30_000 },
    );
}

async function deleteManagedCloudflareTunnel(input: {
  accountId: string;
  apiToken: string;
  appId: string;
  fetcher: CloudflareFetch;
  name: string;
}) {
  const tunnels = await cloudflareRequest<CloudflareTunnel[]>(
    `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel?name=${encodeURIComponent(input.name)}&is_deleted=false&per_page=100`,
    input.apiToken,
    input.fetcher,
  );
  if (!tunnels.length) return;
  if (tunnels.length > 1)
    throw new Error(
      `Cloudflare returned multiple tunnels named '${input.name}'`,
    );
  const tunnel = tunnels[0]!;
  if (
    tunnel.metadata?.[managedTunnelMetadata] !== "towbar" ||
    tunnel.metadata?.towbar_resource_id !== input.appId
  )
    throw new Error(
      `Cloudflare Tunnel '${input.name}' is not owned by this Towbar workload`,
    );
  await cloudflareRequest(
    `/accounts/${encodeURIComponent(input.accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}`,
    input.apiToken,
    input.fetcher,
    { method: "DELETE" },
  );
}

async function deleteOwnedCloudflareTunnelDns(input: {
  apiToken: string;
  appId: string;
  fetcher: CloudflareFetch;
  hostnames: string[];
  zoneId?: string;
}) {
  const expectedComment = `${managedCommentPrefix} ${input.appId}`;
  const zoneCache = new Map<string, string>();
  for (const hostnameValue of new Set(input.hostnames.map(normalizeHostname))) {
    const zoneId =
      input.zoneId ??
      (await findZoneId(
        hostnameValue,
        input.apiToken,
        input.fetcher,
        zoneCache,
      ));
    const records = await cloudflareRequest<CloudflareRecord[]>(
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostnameValue)}&per_page=100`,
      input.apiToken,
      input.fetcher,
    );
    for (const record of records) {
      if (record.comment !== expectedComment) continue;
      await cloudflareRequest(
        `/zones/${zoneId}/dns_records/${record.id}`,
        input.apiToken,
        input.fetcher,
        { method: "DELETE" },
      );
    }
  }
}

export async function verifyCloudflareTlsMode(input: {
  apiToken: string;
  domains: string[];
  fetcher?: CloudflareFetch;
}) {
  const fetcher = input.fetcher ?? fetch;
  const zoneCache = new Map<string, string>();
  const checkedZones = new Set<string>();
  for (const hostname of new Set(input.domains.map(normalizeHostname))) {
    const zoneId = await findZoneId(
      hostname,
      input.apiToken,
      fetcher,
      zoneCache,
    );
    if (checkedZones.has(zoneId)) continue;
    checkedZones.add(zoneId);
    const setting = await cloudflareRequest<{ value?: string }>(
      `/zones/${zoneId}/settings/ssl`,
      input.apiToken,
      fetcher,
    );
    if (setting.value !== "strict") {
      throw new Error(
        `Cloudflare zone for '${hostname}' must use Full (strict) SSL/TLS mode`,
      );
    }
  }
}

async function findZoneId(
  hostname: string,
  token: string,
  fetcher: CloudflareFetch,
  cache: Map<string, string>,
) {
  const labels = hostname.split(".");
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const candidate = labels.slice(index).join(".");
    const cached = cache.get(candidate);
    if (cached) return cached;
    const zones = await cloudflareRequest<Array<{ id: string; name: string }>>(
      `/zones?name=${encodeURIComponent(candidate)}&status=active&per_page=1`,
      token,
      fetcher,
    );
    const zone = zones.find(
      (value) => normalizeHostname(value.name) === candidate,
    );
    if (zone) {
      cache.set(candidate, zone.id);
      return zone.id;
    }
  }
  throw new Error(`Cloudflare has no active zone for '${hostname}'`);
}

async function cloudflareRequest<T = unknown>(
  path: string,
  token: string,
  fetcher: CloudflareFetch,
  mutation?:
    { body: unknown; method: "POST" | "PUT" | "PATCH" } | { method: "DELETE" },
) {
  let response: Response;
  try {
    response = await fetcher(`${cloudflareApiBaseUrl}${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(mutation && "body" in mutation
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(mutation
        ? {
            ...(mutation.method === "DELETE"
              ? {}
              : { body: JSON.stringify(mutation.body) }),
            method: mutation.method,
          }
        : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error("Cloudflare could not be reached", { cause: error });
  }
  const maximumBytes = 4 * 1_024 * 1_024;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("Cloudflare returned an oversized response");
  }
  let body = "";
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maximumBytes)
          throw new Error("Cloudflare returned an oversized response");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    body = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      received,
    ).toString("utf8");
  }
  let value: CloudflareEnvelope<T> | null = null;
  try {
    value = JSON.parse(body) as CloudflareEnvelope<T>;
  } catch {
    value = null;
  }
  if (!response.ok || !value?.success || value.result === undefined)
    throw cloudflareResponseError(response, value);
  return value.result as T;
}

function cloudflareResponseError(
  response: Response,
  value: CloudflareEnvelope<unknown> | null,
) {
  const code = value?.errors?.[0]?.code;
  const ErrorType =
    (response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408) ||
    (response.ok && value?.success === false)
      ? CloudflareRequestRejectedError
      : Error;
  return new ErrorType(
    code
      ? `Cloudflare rejected the DNS change (error ${code})`
      : "Cloudflare rejected the DNS change",
  );
}

function normalizeHostname(value: string) {
  return value.trim().replace(/\.$/u, "").toLowerCase();
}

function permittedDomainHandoff(
  hostname: string,
  record: CloudflareRecord | undefined,
  handoffs: DomainHandoff[] = [],
) {
  if (!record) return false;
  return handoffs.some(
    (handoff) =>
      normalizeHostname(handoff.hostname) === normalizeHostname(hostname) &&
      record.comment === `${managedCommentPrefix} ${handoff.previousAppId}` &&
      ((["A", "AAAA"].includes(record.type) &&
        record.content === handoff.previousServerIp) ||
        (record.type === "CNAME" &&
          /^[a-f0-9-]{36}\.cfargotunnel\.com$/i.test(record.content))),
  );
}

function assertExpectedRecord(
  hostname: string,
  record: CloudflareRecord | undefined,
  expected?: CloudflareDnsExpectations,
) {
  const key = normalizeHostname(hostname);
  if (!expected || !Object.hasOwn(expected, key)) return;
  const before = expected[key];
  if (
    before
      ? !record || before.id !== record.id || !sameDnsRecord(before, record)
      : record
  )
    throw new Error(
      `Cloudflare record '${hostname}' changed after preflight. Retry the deployment.`,
    );
}

export async function inspectCloudflareDeploymentDns(input: {
  app: NormalizedDeployable;
  appId: string;
  serverIp: string;
  onDnsChange?: (change: CloudflareDnsChange) => Promise<void>;
  handoffs?: DomainHandoff[];
  dns: { apiToken: string } | null;
  handoffDns?: DomainDnsCredentials;
  tunnel: { apiToken: string; zoneId?: string } | null;
  fetcher?: CloudflareFetch;
}): Promise<CloudflareDnsExpectations> {
  const expected: CloudflareDnsExpectations = {};
  const dnsDomains = [
    ...new Set([
      ...deploymentCloudflareDnsDomains(input.app),
      ...handoffDnsDomains(input.app, input.handoffs),
    ]),
  ];
  const tunnelDomains = deploymentTunnelHostnames(input.app);
  const fetcher = input.fetcher ?? fetch;
  for (const hostname of [...dnsDomains, ...tunnelDomains]) {
    const tunnel = tunnelDomains.includes(hostname);
    const credential = tunnel
      ? input.tunnel
      : (input.handoffDns?.[hostname] ?? input.dns);
    if (!credential)
      throw new Error("Cloudflare credentials were not resolved");
    const zoneId =
      credential && "zoneId" in credential && credential.zoneId
        ? credential.zoneId
        : await findZoneId(hostname, credential.apiToken, fetcher, new Map());
    const records = await cloudflareRequest<CloudflareRecord[]>(
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
      credential.apiToken,
      fetcher,
    );
    const address = records.filter((record) =>
      ["A", "AAAA", "CNAME"].includes(record.type),
    );
    if (address.length > 1)
      throw new Error(
        `Cloudflare has multiple address records for '${hostname}'; resolve the conflict before deploying`,
      );
    const record = address[0];
    if (
      record &&
      record.comment !== `${managedCommentPrefix} ${input.appId}` &&
      !permittedDomainHandoff(hostname, record, input.handoffs) &&
      !(
        !tunnel &&
        !record.comment?.startsWith(managedCommentPrefix) &&
        record.content === input.serverIp &&
        record.type === (input.serverIp.includes(":") ? "AAAA" : "A")
      )
    )
      throw new Error(
        `Domain '${hostname}' has a conflicting Cloudflare owner. Remove its previous Towbar assignment and sync before retrying; externally managed records require explicit reconciliation.`,
      );
    expected[normalizeHostname(hostname)] = record ?? null;
  }
  return expected;
}

function handoffDnsDomains(
  app: NormalizedDeployable,
  handoffs: DomainHandoff[] = [],
) {
  const tunnel = new Set(deploymentTunnelHostnames(app));
  return handoffs
    .filter(
      (handoff) => handoff.previousManagedDns && !tunnel.has(handoff.hostname),
    )
    .map((handoff) => handoff.hostname);
}

function canAdoptDnsRecord(
  input: { allowUnmanagedAdoption?: boolean; serverIp: string },
  existing: CloudflareRecord,
  recordType: string,
) {
  return (
    input.allowUnmanagedAdoption === true &&
    existing.type === recordType &&
    existing.content === input.serverIp
  );
}
