import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeServerConfiguration } from "../../packages/towbar-core/dist/index.js";
import {
  executeResourceOperation,
  scanHostKeys,
} from "../../packages/towbar-deployer/dist/index.js";
import { startTestTarget } from "./target.mjs";

const target = await startTestTarget({ systemd: true });
try {
  const removed = randomUUID(),
    shared = randomUUID(),
    active = randomUUID(),
    pending = randomUUID(),
    foreign = randomUUID();
  const server = normalizeServerConfiguration({
    ip: "127.0.0.1",
    ssh: { username: "deploy", port: target.port },
  });
  const write = (file, value) =>
    target.ssh(
      `printf '%s' '${Buffer.from(value).toString("base64")}' | base64 -d | sudo tee '${file}' >/dev/null`,
    );
  const labels = (id) =>
    `--label towbar.managed=true --label towbar.source=source --label towbar.deployable=${id}`;
  target.ssh("docker pull alpine:3.22");
  for (const [name, id] of [
    ["removed", removed],
    ["shared", shared],
    ["active", active],
    ["pending", pending],
    ["foreign", foreign],
  ]) {
    target.ssh(`docker volume create ${labels(id)} ${name}-data`);
    target.ssh(
      `docker run -d --name ${name} ${labels(id)} -v ${name}-data:/data alpine:3.22 sleep infinity`,
    );
  }
  target.ssh(
    "docker run -d --name external -v shared-data:/shared alpine:3.22 sleep infinity",
  );
  const danglingImage = target.ssh(
    "docker commit removed cleanup-dangling:current",
  );
  target.ssh("docker tag alpine:3.22 cleanup-dangling:current");
  target.ssh(`docker network create ${labels(removed)} removed-network`);
  target.ssh(
    `docker network create --label towbar.managed=true shared-network`,
  );
  const project = `towbar-${removed}`;
  target.ssh(
    `docker volume create --label com.docker.compose.project=${project} --label com.docker.compose.volume=data compose-data`,
  );
  target.ssh(
    `docker network create --label com.docker.compose.project=${project} --label com.docker.compose.network=default compose-network`,
  );
  target.ssh(
    `docker volume create --label com.docker.compose.project=foreign --label com.docker.compose.volume=data foreign-compose-data`,
  );
  target.ssh(
    `docker run -d --name towbar-cloudflared-${removed} --label towbar.managed=true --label towbar.ingress=cloudflare-tunnel --label towbar.app=${removed} alpine:3.22 sleep infinity`,
  );
  target.ssh(
    `sudo mkdir -p /var/lib/towbar/config-files/${removed}/release /var/lib/towbar/resources/${removed}/volumes`,
  );
  write(
    `/var/lib/towbar/config-files/${removed}/release/receipt.json`,
    JSON.stringify({ deployableId: removed, sourceId: "source" }),
  );
  write(
    `/etc/caddy/towbar/${removed}.caddy`,
    ':8089 {\n respond "retiring"\n}\n',
  );
  write(`/etc/caddy/towbar/${active}.caddy`, ':8088 {\n respond "active"\n}\n');
  target.ssh("sudo systemctl reload caddy");
  const input = {
    context: {
      operationId: randomUUID(),
      server,
      trustedHostKeys: await scanHostKeys(server),
      deployable: null,
      deployableId: null,
      sourceId: null,
      currentRelease: null,
      retentionBackups: [],
      restoreBackup: null,
      request: { type: "cleanup_orphans", trigger: "manual", items: [] },
      cleanupExpected: {
        ownedDeployableIds: [removed, shared, active, pending],
        deployableIds: [active],
        protectedDeployableIds: [pending],
        containerNames: ["active"],
        imageTags: [],
        retiring: [
          {
            deployableId: removed,
            sourceId: "source",
            runtimeIds: [removed],
            composeProjects: [project],
          },
          { deployableId: shared, sourceId: "source", runtimeIds: [shared] },
        ],
      },
    },
    secrets: {
      login: { privateKey: readFileSync(target.key, "utf8") },
      runtime: {},
      sensitiveValues: [],
    },
  };
  // A reload failure must retain the route file and withhold retirement receipts.
  write(
    "/etc/caddy/towbar/broken.caddy",
    "broken {\n definitely_not_a_caddy_directive\n}\n",
  );
  await assert.rejects(executeResourceOperation(input), (error) => {
    assert(error.cleanupResult.failures.length > 0);
    assert(!error.cleanupResult.retiredDeployableIds.includes(removed));
    return true;
  });
  target.ssh(`sudo test -f /etc/caddy/towbar/${removed}.caddy`);
  target.ssh("sudo rm /etc/caddy/towbar/broken.caddy");
  const result = await executeResourceOperation(input);
  assert(result.retiredDeployableIds.includes(removed));
  assert(
    !result.retiredDeployableIds.includes(shared),
    "an externally referenced owned volume prevents full retirement",
  );
  target.ssh(`sudo test ! -e /var/lib/towbar/config-files/${removed}`);
  target.ssh(`sudo test ! -e /var/lib/towbar/resources/${removed}`);
  target.ssh(`sudo test ! -e /etc/caddy/towbar/${removed}.caddy`);
  assert.equal(
    target.ssh("curl --fail --silent http://127.0.0.1:8088"),
    "active",
  );
  assert.deepEqual(
    new Set(target.ssh("docker ps -a --format '{{.Names}}'").split("\n")),
    new Set(["active", "pending", "foreign", "external"]),
  );
  assert.equal(
    target
      .ssh("docker volume ls --format '{{.Name}}'")
      .includes("removed-data"),
    false,
  );
  for (const name of [
    "active-data",
    "pending-data",
    "foreign-data",
    "shared-data",
  ])
    target.ssh(`docker volume inspect ${name} >/dev/null`);
  assert.equal(
    target
      .ssh("docker network ls --format '{{.Name}}'")
      .includes("removed-network"),
    false,
  );
  target.ssh("docker network inspect shared-network >/dev/null");
  target.ssh("docker volume inspect foreign-compose-data >/dev/null");
  assert(
    !target
      .ssh("docker image ls -q --no-trunc")
      .split("\n")
      .includes(danglingImage),
  );
  assert(
    !target
      .ssh("docker volume ls --format '{{.Name}}'")
      .split("\n")
      .includes("compose-data"),
  );
  assert(
    !target
      .ssh("docker network ls --format '{{.Name}}'")
      .includes("compose-network"),
  );
  await executeResourceOperation(input);
  assert.equal(
    target.ssh("curl --fail --silent http://127.0.0.1:8088"),
    "active",
  );
  console.log(
    "Server cleanup: non-root SSH, Docker volumes and ownership, external references, pending work, route reload failure/retry, configuration retirement, shared networks and idempotency passed.",
  );
} finally {
  target.close();
}
