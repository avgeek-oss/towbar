import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  cleanupCloudflareDnsTransition,
  reconcileCloudflareDns,
  reconcileCloudflareForDeployment,
} from "./cloudflare.js";
import { type DnsRecord, dnsFixture } from "./cloudflare-dns-test-helper.js";

const owned: DnsRecord = {
  id: "owned",
  name: "api.example.com",
  type: "A",
  content: "192.0.2.20",
  comment: "Managed by Towbar: stack",
  proxied: false,
  ttl: 300,
};
const input = {
  apiToken: "test-token",
  appId: "stack",
  domains: ["api.example.com"],
  serverIp: "192.0.2.10",
};

void test("mixed Compose routes reconcile every DNS hostname and skip direct/Tunnel routes", async (t) => {
  const fixture = dnsFixture();
  t.mock.method(globalThis, "fetch", fixture.fetcher);
  const app = normalizeDeploymentManifest({
    version: 2,
    compose: [
      {
        id: "stack",
        name: "Stack",
        server: "192.0.2.10",
        file: "compose.yml",
        services: {
          api: {
            port: 3000,
            domains: ["api.example.com", "ingest.example.com"],
            tls: { mode: "cloudflare-dns" },
          },
          console: {
            port: 8080,
            domains: ["console.example.com"],
            ingress: { type: "proxy" },
            tls: { mode: "cloudflare-dns" },
          },
          direct: {
            port: 80,
            domains: ["direct.example.com"],
            tls: { mode: "direct" },
          },
          tunnel: {
            port: 80,
            domains: ["tunnel.example.com"],
            ingress: { type: "cloudflare-tunnel", integration: "cloudflare" },
          },
        },
      },
    ],
  }).compose![0]!;
  const transition = await reconcileCloudflareForDeployment({
    app,
    credentials: { apiToken: "test-token" },
    server: normalizeServerConfiguration({
      ip: "192.0.2.10",
      ssh: { username: "ubuntu" },
    }),
  });
  assert.deepEqual(
    fixture.mutations.map(({ name }) => name),
    ["api.example.com", "ingest.example.com", "console.example.com"],
  );
  assert(
    [...fixture.records.values()].every(
      ({ comment, proxied }) =>
        comment === "Managed by Towbar: stack" && proxied,
    ),
  );
  await transition!.rollback();
  assert.equal(fixture.records.size, 0);
});

void test("DNS rollback restores an owned record and removes a newly created sibling", async () => {
  const fixture = dnsFixture([owned]);
  const transition = await reconcileCloudflareDns({
    ...input,
    domains: ["api.example.com", "new.example.com"],
    fetcher: fixture.fetcher,
  });
  await transition.rollback();
  assert.deepEqual([...fixture.records.values()], [owned]);
});

void test("a later collision rolls back earlier writes without touching unrelated records", async () => {
  const unrelated = {
    ...owned,
    id: "foreign",
    name: "foreign.example.com",
    comment: "Managed by Towbar: other",
  };
  const fixture = dnsFixture([owned, unrelated]);
  await assert.rejects(
    reconcileCloudflareDns({
      ...input,
      domains: [owned.name, "new.example.com", unrelated.name],
      fetcher: fixture.fetcher,
    }),
    /owned by another/,
  );
  assert.deepEqual([...fixture.records.values()], [owned, unrelated]);
});

void test("rollback restores same-target adoption and preserves later external edits", async () => {
  const manual = {
    ...owned,
    content: input.serverIp,
    comment: "Operator note",
  };
  const fixture = dnsFixture([manual]);
  const transition = await reconcileCloudflareDns({
    ...input,
    allowUnmanagedAdoption: true,
    fetcher: fixture.fetcher,
  });
  await transition.rollback();
  assert.deepEqual(fixture.records.get(owned.id), manual);
  const changed = await reconcileCloudflareDns({
    ...input,
    allowUnmanagedAdoption: true,
    fetcher: fixture.fetcher,
  });
  fixture.records.get(owned.id)!.content = "192.0.2.99";
  await assert.rejects(changed.rollback(), /operator attention/);
  assert.equal(fixture.records.get(owned.id)!.content, "192.0.2.99");
});

void test("uncertain DNS writes fail with a visible rollback warning", async () => {
  const fixture = dnsFixture();
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fixture.fetcher(url, init);
    if (init?.method === "POST") throw new Error("Lost provider response");
    return response;
  };
  await assert.rejects(
    reconcileCloudflareDns({ ...input, fetcher }),
    /rollback needs operator attention/,
  );
  assert.equal(fixture.records.size, 1);
  assert.equal(
    fixture.mutations.some(({ method }) => method === "DELETE"),
    false,
  );
});

void test("rejected DNS creates preserve the provider error and roll back earlier writes", async (t) => {
  for (const status of [403, 200]) {
    await t.test(`provider rejection with HTTP ${status}`, async () => {
      const fixture = dnsFixture([owned]);
      const fetcher: typeof fetch = (url, init) =>
        init?.method === "POST"
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  success: false,
                  errors: [{ code: 10000, message: "Authentication error" }],
                }),
                { status },
              ),
            )
          : fixture.fetcher(url, init);
      await assert.rejects(
        reconcileCloudflareDns({
          ...input,
          domains: [owned.name, "new.example.com"],
          fetcher,
        }),
        (error: unknown) => {
          assert(error instanceof Error);
          assert(!(error instanceof AggregateError));
          assert.match(error.message, /Cloudflare rejected.*10000/u);
          return true;
        },
      );
      assert.deepEqual([...fixture.records.values()], [owned]);
    });
  }
});

void test("a server error after a DNS create remains an uncertain write", async () => {
  const fixture = dnsFixture();
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fixture.fetcher(url, init);
    return init?.method === "POST"
      ? new Response(JSON.stringify({ success: false }), { status: 503 })
      : response;
  };
  await assert.rejects(
    reconcileCloudflareDns({ ...input, fetcher }),
    /rollback needs operator attention/u,
  );
  assert.equal(fixture.records.size, 1);
  assert.equal(fixture.mutations.length, 1);
});

void test("rollback reports a missing preexisting DNS record without recreating it", async () => {
  const fixture = dnsFixture([owned]);
  const transition = await reconcileCloudflareDns({
    ...input,
    fetcher: fixture.fetcher,
  });
  fixture.records.delete(owned.id);
  await assert.rejects(transition.rollback(), (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.match(error.message, /operator attention/u);
    const rollbackError: unknown = error.errors[0];
    assert(rollbackError instanceof Error);
    assert.match(rollbackError.message, /removed after reconciliation/u);
    return true;
  });
  assert.equal(fixture.records.size, 0);
  assert.deepEqual(fixture.mutations, [{ method: "PATCH", name: owned.name }]);
});

void test("rollback accepts an already removed record created by this transition", async () => {
  const fixture = dnsFixture();
  const transition = await reconcileCloudflareDns({
    ...input,
    fetcher: fixture.fetcher,
  });
  fixture.records.clear();
  await transition.rollback();
  assert.equal(fixture.records.size, 0);
  assert.deepEqual(fixture.mutations, [{ method: "POST", name: owned.name }]);
});

void test("cleanup deletes only obsolete owned address records and protects current routes", async () => {
  const live = { ...owned, id: "live", name: "live.example.com" };
  const foreign = { ...owned, id: "foreign", comment: "Operator note" };
  const tunnel = {
    ...owned,
    id: "tunnel",
    type: "CNAME",
    content: "tunnel.cfargotunnel.com",
  };
  const fixture = dnsFixture([owned, live, foreign, tunnel]);
  await cleanupCloudflareDnsTransition({
    appId: "stack",
    previous: {
      apiToken: "test-token",
      hostnames: [owned.name, live.name, owned.name],
    },
    protectedHostnames: ["LIVE.EXAMPLE.COM"],
    managedHostnames: [live.name],
    fetcher: fixture.fetcher,
  });
  assert.deepEqual([...fixture.records.values()], [live, foreign, tunnel]);
  assert.deepEqual(fixture.mutations, [{ method: "DELETE", name: owned.name }]);
});

void test("authorized same-environment DNS handoffs retain a guarded rollback", async () => {
  const fixture = dnsFixture([owned]);
  const handoffs = [
    {
      hostname: owned.name,
      previousAppId: "stack",
      previousAppName: "Stack",
      previousServerId: "previous-server",
      previousServerIp: owned.content,
      previousDeploymentId: "previous-deployment",
      previousManagedDns: true,
    },
  ];
  const transition = await reconcileCloudflareDns({
    ...input,
    appId: "ui",
    handoffs,
    expectedRecords: { [owned.name]: owned },
    fetcher: fixture.fetcher,
  });
  assert.equal(fixture.records.get(owned.id)?.comment, "Managed by Towbar: ui");
  await transition.rollback();
  assert.deepEqual(fixture.records.get(owned.id), owned);
  await assert.rejects(
    reconcileCloudflareDns({
      ...input,
      appId: "ui",
      handoffs: [{ ...handoffs[0]!, previousAppId: "foreign" }],
      fetcher: fixture.fetcher,
    }),
    /owned by another/,
  );
  await assert.rejects(
    reconcileCloudflareDns({
      ...input,
      appId: "ui",
      handoffs: [{ ...handoffs[0]!, previousServerIp: "192.0.2.99" }],
      fetcher: fixture.fetcher,
    }),
    /owned by another/,
  );
  fixture.records.get(owned.id)!.content = "192.0.2.99";
  await assert.rejects(
    reconcileCloudflareDns({
      ...input,
      appId: "ui",
      handoffs,
      expectedRecords: { [owned.name]: owned },
      fetcher: fixture.fetcher,
    }),
    /changed after preflight/,
  );
});

void test("a managed hostname handed to direct TLS relinquishes its comment after preparation", async () => {
  const fixture = dnsFixture([owned]);
  const receipts: unknown[] = [];
  const transition = await reconcileCloudflareDns({
    ...input,
    appId: "ui",
    releaseOwnershipDomains: [owned.name],
    handoffs: [
      {
        hostname: owned.name,
        previousAppId: "stack",
        previousAppName: "Stack",
        previousServerId: "old-server",
        previousServerIp: owned.content,
        previousDeploymentId: "old-deployment",
        previousManagedDns: true,
      },
    ],
    fetcher: fixture.fetcher,
    onDnsChange: (change) => {
      receipts.push({
        receipt: structuredClone(change),
        live: structuredClone(fixture.records.get(owned.id)),
      });
      return Promise.resolve();
    },
  });
  assert.equal(fixture.records.get(owned.id)?.comment, "");
  assert.equal(fixture.records.get(owned.id)?.content, input.serverIp);
  assert.deepEqual(
    (receipts[0] as { live: unknown }).live,
    owned,
    "the recovery receipt must be persisted before mutation",
  );
  await transition.rollback();
  assert.deepEqual(fixture.records.get(owned.id), owned);
});

void test("handoffs resolve and restore each hostname with its own zone credential", async () => {
  const second = { ...owned, id: "second", name: "second.example.com" };
  const fixture = dnsFixture([owned, second]);
  const fetcher: typeof fetch = (url, init) => {
    const endpoint = new URL(String(url));
    const firstZone = endpoint.pathname.includes("/zones/first-zone/");
    assert.match(endpoint.pathname, /\/zones\/(first|second)-zone\//);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      firstZone ? "Bearer first-token" : "Bearer second-token",
    );
    const headers = new Headers(init?.headers);
    headers.set("authorization", "Bearer test-token");
    return fixture.fetcher(url, { ...init, headers });
  };
  const handoffs = [owned, second].map((record) => ({
    hostname: record.name,
    previousAppId: "stack",
    previousAppName: "Stack",
    previousServerId: "old",
    previousServerIp: record.content,
    previousDeploymentId: "old-deployment",
    previousManagedDns: true,
  }));
  const transition = await reconcileCloudflareDns({
    ...input,
    apiToken: "",
    domains: [owned.name, second.name],
    appId: "ui",
    handoffs,
    handoffDns: {
      [owned.name]: { apiToken: "first-token", zoneId: "first-zone" },
      [second.name]: { apiToken: "second-token", zoneId: "second-zone" },
    },
    fetcher,
  });
  assert.equal(
    fixture.records.get(second.id)?.comment,
    "Managed by Towbar: ui",
  );
  await transition.rollback();
  assert.deepEqual([...fixture.records.values()], [owned, second]);
});

void test("a failed pre-write receipt does not make an unwritten DNS create uncertain", async () => {
  for (const initial of [[], [owned]]) {
    const fixture = dnsFixture(initial);
    const error = new Error("receipt upload failed");
    const hostname = "new.example.com";
    const handoffs = [owned.name, hostname].map((name) => ({
      hostname: name,
      previousAppId: "stack",
      previousAppName: "Stack",
      previousServerId: "old",
      previousServerIp: owned.content,
      previousDeploymentId: "old-deployment",
      previousManagedDns: true,
    }));
    await assert.rejects(
      reconcileCloudflareDns({
        ...input,
        appId: "ui",
        domains: [...initial.map(({ name }) => name), hostname],
        handoffs,
        fetcher: fixture.fetcher,
        onDnsChange: (change) =>
          change.after.name === hostname
            ? Promise.reject(error)
            : Promise.resolve(),
      }),
      (failure) => failure === error,
    );
    assert.deepEqual([...fixture.records.values()], initial);
    assert(!fixture.mutations.some(({ method }) => method === "POST"));
  }
});

void test("DNS-only updates are idempotent and rollback restores the proxy setting", async () => {
  const proxied = { ...owned, content: input.serverIp, proxied: true };
  const fixture = dnsFixture([proxied]);
  const dnsOnly = {
    ...input,
    domains: [owned.name, "new.example.com"],
    proxiedDomains: { [owned.name]: false, "new.example.com": false },
    fetcher: fixture.fetcher,
  };
  const transition = await reconcileCloudflareDns(dnsOnly);
  assert([...fixture.records.values()].every(({ proxied }) => !proxied));
  assert.deepEqual(fixture.mutations, [
    { method: "PATCH", name: owned.name },
    { method: "POST", name: "new.example.com" },
  ]);
  await reconcileCloudflareDns(dnsOnly);
  assert.equal(fixture.mutations.length, 2);
  await transition.rollback();
  assert.deepEqual([...fixture.records.values()], [proxied]);
});

void test("DNS-only routes skip edge SSL settings while proxied routes still require strict mode", async (t) => {
  const fixture = dnsFixture();
  let sslRequests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(url).endsWith("/settings/ssl")) {
        sslRequests += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({ success: true, result: { value: "flexible" } }),
          ),
        );
      }
      return fixture.fetcher(url, init);
    },
  );
  const app = normalizeDeploymentManifest({
    version: 2,
    apps: [
      {
        id: "stack",
        name: "Stack",
        dockerfile: "Dockerfile",
        server: input.serverIp,
        container: { port: 8080 },
        domains: { primary: owned.name },
        tls: { mode: "cloudflare-dns", proxied: false },
      },
    ],
  }).apps[0]!;
  const deployment = {
    app,
    credentials: { apiToken: input.apiToken },
    server: normalizeServerConfiguration({
      ip: input.serverIp,
      ssh: { username: "ubuntu" },
    }),
  };
  await reconcileCloudflareForDeployment(deployment);
  assert.equal(sslRequests, 0);
  assert.equal([...fixture.records.values()][0]?.proxied, false);
  await assert.rejects(
    reconcileCloudflareForDeployment({
      ...deployment,
      app: { ...app, tls: { mode: "cloudflare-dns" } },
    }),
    /Full \(strict\)/,
  );
  assert.equal(sslRequests, 1);
  assert.equal(fixture.mutations.length, 1);
});
