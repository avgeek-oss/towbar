import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildLogCollectorConfiguration,
  logCollectorImage,
  normalizeServerConfiguration,
} from "../../packages/towbar-core/dist/index.js";
import {
  reconcileLogCollector,
  scanHostKeys,
} from "../../packages/towbar-deployer/dist/index.js";
import { startTestTarget } from "./target.mjs";

const target = await startTestTarget({ systemd: true });
const serverId = randomUUID(),
  workloadId = randomUUID();
const token = `twlg_${randomBytes(32).toString("hex")}`;
const encoded = (value) => Buffer.from(value).toString("base64");
async function until(check, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  assert(Number(target.ssh("id -u")) > 0);
  const container = target.ssh(
    `docker run -d --name log-source --label towbar.managed=true --label towbar.deployable=${workloadId} --log-driver json-file postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 sh -c 'sleep 900'`,
  );
  const gateway = target.ssh(
    "docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'",
  );
  const endpoint = `http://${gateway}:18743/v1/logs`;
  const configuration = buildLogCollectorConfiguration({
    endpoint: `${endpoint}/ingest`,
    token,
    serverId,
    sources: [{ containerId: container, startAt: "end" }],
  });
  const python = String.raw`import json, pathlib
from http.server import BaseHTTPRequestHandler, HTTPServer
root = pathlib.Path('/var/lib/towbar-log-test')
settings = json.loads((root / 'configuration.json').read_text())
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        if self.headers.get('Authorization') != 'Bearer ' + settings['token'] or self.headers.get('X-Towbar-Server') != settings['serverId']:
            self.send_response(401); self.end_headers(); return
        length = int(self.headers.get('Content-Length', '0'))
        if length > 4194304:
            self.send_response(413); self.end_headers(); return
        data = json.loads(self.rfile.read(length))
        if self.path == '/v1/logs/sources':
            matches = [source for source in data['sources'] if source['containerId'] == settings['containerId'] and source['workloadId'] == settings['workloadId']]
            assert len(matches) == 1
            (root / 'report.json').write_text(json.dumps(data))
            output = {'allowedContainerIds': [settings['containerId']], 'configuration': settings['collector']}
        elif self.path == '/v1/logs/ingest':
            with (root / 'packets.jsonl').open('a') as out:
                out.write(json.dumps(data) + '\n')
            output = {}
        else:
            self.send_response(404); self.end_headers(); return
        body = json.dumps(output).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
HTTPServer(('0.0.0.0', 18743), Handler).serve_forever()
`;
  const settings = {
    token,
    serverId,
    workloadId,
    containerId: container,
    collector: configuration,
  };
  target.ssh(`sudo install -d -m 700 /var/lib/towbar-log-test
printf '%s' '${encoded(JSON.stringify(settings))}' | base64 -d | sudo tee /var/lib/towbar-log-test/configuration.json >/dev/null
printf '%s' '${encoded(python)}' | base64 -d | sudo tee /var/lib/towbar-log-test/api.py >/dev/null
sudo systemd-run --unit=towbar-log-test-api /usr/bin/python3 /var/lib/towbar-log-test/api.py`);
  const server = normalizeServerConfiguration({
    ip: "127.0.0.1",
    ssh: { username: "deploy", port: target.port },
    hostLogCollection: true,
  });
  const context = {
    serverId,
    generation: randomUUID(),
    desiredState: "enabled",
    config: server,
    login: { privateKey: readFileSync(target.key, "utf8") },
    trustedHostKeys: await scanHostKeys(server),
    endpoint,
    token,
  };
  await reconcileLogCollector(context);
  await until(
    () =>
      target.ssh(
        "docker ps --filter name=^/towbar-log-collector$ --format '{{.Names}}'",
      ) === "towbar-log-collector",
    "managed collector starts",
  );
  assert.equal(
    target.ssh("sudo systemctl is-active towbar-log-discovery"),
    "active",
  );
  assert.equal(
    target.ssh("sudo stat -c '%a:%u' /etc/towbar-logs/config.json"),
    "600:0",
  );
  const inspect = JSON.parse(
    target.ssh("docker inspect towbar-log-collector"),
  )[0];
  assert.equal(inspect.Config.Image, logCollectorImage);
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(inspect.HostConfig.NanoCpus, 250000000);
  assert(inspect.HostConfig.CapDrop.includes("ALL"));
  assert(!inspect.Mounts.some((mount) => mount.Source.includes("docker.sock")));
  assert(
    inspect.Mounts.some(
      (mount) =>
        mount.Destination === "/var/lib/docker/containers" && !mount.RW,
    ),
  );
  const emit = (text) =>
    target.ssh(
      `docker exec log-source sh -c 'printf "%s\\n" "$1" > /proc/1/fd/1' sh '${text}'`,
    );
  const packets = () =>
    target.ssh(
      "sudo cat /var/lib/towbar-log-test/packets.jsonl 2>/dev/null || true",
    );
  // A running container may not have discovered its start-at-end log file yet.
  async function waitForReceiver(marker) {
    await until(() => {
      emit(marker);
      return packets().includes(marker);
    }, "collector receiver is reading the managed log file");
  }
  await waitForReceiver("collector-readiness-probe");
  emit("first-managed-record");
  await until(
    () => packets().includes("first-managed-record"),
    "discovery and managed collector export",
  );
  const first = inspect.Id;
  await reconcileLogCollector({ ...context, generation: randomUUID() });
  await until(
    () =>
      target.ssh(
        "docker inspect --format '{{.Id}}' towbar-log-collector 2>/dev/null || true",
      ) !== first &&
      target.ssh(
        "docker ps --filter name=^/towbar-log-collector$ --format '{{.Names}}'",
      ) === "towbar-log-collector",
    "update replaces owned collector",
  );
  await waitForReceiver("collector-update-readiness-probe");
  emit("record-after-managed-update");
  await until(
    () => packets().includes("record-after-managed-update"),
    "updated collector resumes",
  );
  const after = packets();
  assert.equal((after.match(/first-managed-record/gu) ?? []).length, 1);
  await reconcileLogCollector({
    ...context,
    desiredState: "disabled",
    token: null,
  });
  assert.equal(
    target.ssh(
      "docker ps -a --filter name=^/towbar-log-collector$ --format '{{.Names}}'",
    ),
    "",
  );
  assert.equal(
    target.ssh("sudo systemctl is-active towbar-log-discovery || true"),
    "inactive",
  );
  assert.equal(
    target.ssh(
      "sudo test ! -f /etc/towbar-logs/config.json && sudo test -d /var/lib/towbar-logs/checkpoints && echo retained",
    ),
    "retained",
  );
  emit("record-after-managed-disable");
  await delay(1500);
  assert(!packets().includes("record-after-managed-disable"));
  console.log(
    "Managed log collector lifecycle passed: trusted non-root SSH, real Ubuntu systemd, discovery, pinned container constraints, ingestion, checkpoint-preserving update and disable.",
  );
} catch (error) {
  console.error(
    target.ssh(
      "sudo journalctl -u towbar-log-discovery -u towbar-log-test-api --no-pager -n 30",
    ),
  );
  console.error(
    target.ssh("docker logs --tail 30 towbar-log-collector 2>&1 || true"),
  );
  throw error;
} finally {
  target.close();
}
