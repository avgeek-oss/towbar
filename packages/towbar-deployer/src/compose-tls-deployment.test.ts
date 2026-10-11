import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  normalizeDeploymentManifest,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  type DeploymentState,
  assertDeploymentTransition,
} from "@workspace/towbar-core/temporal";
import {
  executeComposeDeployment,
  renderComposeCaddy,
} from "./compose-deployment.js";
import { dnsFixture } from "./cloudflare-dns-test-helper.js";
import {
  DeploymentCommitUncertainError,
  DeploymentCommittedError,
} from "./promotion-boundary.js";
import { SshSession } from "./ssh.js";
import type {
  DeploymentExecutionContext,
  DeploymentSecrets,
  ExecutorHooks,
} from "./types.js";

async function deploymentFixture(
  t: TestContext,
  failure?: "routing" | "finalize",
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "towbar-compose-tls-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  const localDirectory = path.join(directory, "deployment");
  await mkdir(repository);
  await mkdir(localDirectory);
  await writeFile(
    path.join(repository, "compose.yml"),
    `services:\n  api:\n    image: nginx@sha256:${"a".repeat(64)}\n  console:\n    image: nginx@sha256:${"a".repeat(64)}\n  direct:\n    image: nginx@sha256:${"a".repeat(64)}\n`,
  );
  const archive = path.join(directory, "source.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", directory, "repository"]);
  const archiveBytes = await readFile(archive);
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
            domains: ["api.example.com"],
            ingress: { type: "proxy" },
            tls: { mode: "cloudflare-dns" },
          },
          console: {
            port: 8080,
            domains: ["console.example.com"],
            tls: { mode: "cloudflare-dns", proxied: false },
          },
          direct: {
            port: 80,
            domains: ["direct.example.com"],
            tls: { mode: "direct" },
          },
        },
      },
    ],
  }).compose![0]!;
  const context: DeploymentExecutionContext = {
    app,
    commitSha: "a".repeat(40),
    deploymentId: "deployment",
    deployableId: "stack",
    environmentName: "production",
    sourceId: "source",
    workspaceId: "workspace",
    runtimeId: "stack",
    serverId: "server",
    kind: "deploy",
    repositoryName: "repository",
    repositoryOwner: "owner",
    sourceCredential: {
      provider: "github",
      apiUrl: "https://source.example.com",
      token: "source-token",
    },
    server: normalizeServerConfiguration({
      ip: app.server,
      ssh: { username: "ubuntu" },
    }),
    trustedHostKeys: [],
    rollbackRelease: null,
    currentRelease: null,
  };
  const secrets: DeploymentSecrets = {
    build: {},
    runtime: {},
    hooks: { preDeploy: {}, postDeploy: {} },
    login: { privateKey: "ssh-test-key" },
    cloudflare: { apiToken: "test-token" },
    cloudflareTunnel: null,
    previousCloudflareTunnel: null,
    previousCloudflareTunnelCleanupBlocked: false,
  };
  const fixture = dnsFixture([
    {
      id: "obsolete",
      name: "obsolete.example.com",
      type: "A",
      content: app.server,
      comment: "Managed by Towbar: stack",
      proxied: true,
      ttl: 1,
    },
  ]);
  secrets.previousCloudflareDns = {
    apiToken: "test-token",
    hostnames: ["obsolete.example.com", "api.example.com"],
  };
  const actions: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(url).startsWith("https://source.example.com/")) {
        actions.push("source_fetch");
        return Promise.resolve(new Response(archiveBytes));
      }
      return fixture.fetcher(url, init);
    },
  );
  const commands: string[] = [];
  const uploads = new Map<string, string>();
  t.mock.method(SshSession, "connect", () => {
    actions.push("server_connect");
    return Promise.resolve({
      upload: async (local: string, remote: string) => {
        actions.push("upload");
        if (remote.endsWith("cloudflare.env"))
          assert.equal((await stat(local)).mode & 0o777, 0o600);
        if (remote.endsWith("app.caddy") || remote.endsWith("cloudflare.env"))
          uploads.set(remote, await readFile(local, "utf8"));
      },
      run: (script: string) => {
        commands.push(script);
        if (script.includes("TOWBAR_ROUTING=")) {
          actions.push("compose_run");
          const routes = Object.entries(app.services).map(
            ([service, policy], index) => ({
              service,
              domains: policy.domains,
              ingress: policy.ingress ?? { type: "proxy" },
              tls: policy.tls,
              upstreams: [`127.0.0.1:${40000 + index}`],
            }),
          );
          return Promise.resolve({
            stdout: `TOWBAR_ROUTING=${JSON.stringify(routes)}\nTOWBAR_SERVICES=["api","console","direct"]\n${"a".repeat(64)}\n`,
            stderr: "",
          });
        }
        if (failure === "routing" && script.includes("sudo caddy fmt"))
          throw new Error("Caddy rejected routing");
        if (failure === "finalize" && script.includes('stable="$2"'))
          throw new Error("Finalize failed");
        return Promise.resolve({ stdout: "", stderr: "" });
      },
      close: () => Promise.resolve(),
    });
  });
  return {
    ...fixture,
    actions,
    commands,
    uploads,
    context,
    secrets,
    localDirectory,
  };
}

function validatedTransitions(actions: string[]) {
  const states: DeploymentState[] = [];
  let previous: DeploymentState = "waiting_for_server";
  const hooks: ExecutorHooks = {
    transition: (state) => {
      assertDeploymentTransition(previous, state, "compose");
      states.push(state);
      actions.push(state);
      previous = state;
      return Promise.resolve();
    },
  };
  return {
    hooks,
    states,
    fail: () => assertDeploymentTransition(previous, "failed", "compose"),
  };
}

const successfulComposeStates: DeploymentState[] = [
  "preparing",
  "validating_credentials",
  "checking_server",
  "fetching_source",
  "resolving_secrets",
  "transferring",
  "building",
  "starting_candidate",
  "checking_health",
  "configuring_routing",
  "provisioning_tls",
  "switching_traffic",
  "cleaning_up",
  "succeeded",
];

void test("Compose emits a valid, work-aligned deployment sequence with DNS TLS", async (t) => {
  const fixture = await deploymentFixture(t);
  const recorder = validatedTransitions(fixture.actions);
  await executeComposeDeployment({ ...fixture, hooks: recorder.hooks });
  assert.deepEqual(recorder.states, successfulComposeStates);
  const position = (step: string) => fixture.actions.indexOf(step);
  assert(position("checking_server") < position("server_connect"));
  assert(position("server_connect") < position("fetching_source"));
  assert(position("fetching_source") < position("source_fetch"));
  assert(position("resolving_secrets") < position("transferring"));
  assert(position("transferring") < position("upload"));
  assert(position("building") < position("compose_run"));
});

void test("Compose validates the same sequence without Cloudflare DNS, including rollback", async (t) => {
  for (const kind of ["deploy", "rollback"] as const) {
    await t.test(kind, async (caseContext) => {
      const fixture = await deploymentFixture(caseContext);
      const app = fixture.context.app;
      assert(app.kind === "compose");
      fixture.context.kind = kind;
      for (const service of Object.values(app.services))
        service.tls = { mode: "direct" };
      fixture.secrets.cloudflare = null;
      const recorder = validatedTransitions(fixture.actions);
      await executeComposeDeployment({ ...fixture, hooks: recorder.hooks });
      assert.deepEqual(recorder.states, successfulComposeStates);
      assert(
        !fixture.commands.some((script) =>
          script.includes("dns.providers.cloudflare"),
        ),
      );
    });
  }
});

void test("Compose failures retain a valid transition to failed before and after startup", async (t) => {
  await t.test("source failure", async (caseContext) => {
    const fixture = await deploymentFixture(caseContext);
    fixture.context.sourceCredential = null;
    const recorder = validatedTransitions(fixture.actions);
    await assert.rejects(
      executeComposeDeployment({ ...fixture, hooks: recorder.hooks }),
      /Repository credentials are required/u,
    );
    recorder.fail();
    assert.deepEqual(recorder.states, [
      "preparing",
      "validating_credentials",
      "checking_server",
      "fetching_source",
    ]);
  });
  await t.test("routing failure", async (caseContext) => {
    const fixture = await deploymentFixture(caseContext, "routing");
    const recorder = validatedTransitions(fixture.actions);
    await assert.rejects(
      executeComposeDeployment({ ...fixture, hooks: recorder.hooks }),
      /Caddy rejected routing/u,
    );
    recorder.fail();
    assert.deepEqual(recorder.states, successfulComposeStates.slice(0, 11));
    assert(fixture.commands.some((script) => script.includes('runtime="$6"')));
  });
});

void test("Compose DNS TLS prepares Caddy, transfers its token privately and cleans obsolete DNS after commit", async (t) => {
  const fixture = await deploymentFixture(t);
  let committed = false;
  const result = await executeComposeDeployment({
    ...fixture,
    hooks: {
      commitRelease: () => {
        assert(fixture.records.has("obsolete"));
        committed = true;
        return Promise.resolve({ retainedImageTags: [] });
      },
    },
  });
  assert(committed);
  assert.equal(fixture.records.has("obsolete"), false);
  assert.equal(
    [...fixture.records.values()].find(
      ({ name }) => name === "console.example.com",
    )?.proxied,
    false,
  );
  assert.equal(
    [...fixture.records.values()].find(({ name }) => name === "api.example.com")
      ?.proxied,
    true,
  );
  assert.deepEqual(
    [...fixture.records.values()].map(({ name }) => name),
    ["api.example.com", "console.example.com"],
  );
  const caddy = fixture.uploads.get("/var/lib/towbar/compose/stack/app.caddy")!;
  assert.equal(caddy.match(/dns cloudflare/g)?.length, 2);
  assert.match(caddy, /direct\.example\.com \{/u);
  assert(!caddy.includes("test-token"));
  assert.equal(
    fixture.uploads.get("/var/lib/towbar/compose/stack/cloudflare.env"),
    "CLOUDFLARE_API_TOKEN=test-token\n",
  );
  assert(
    fixture.commands.some((script) =>
      script.includes("dns.providers.cloudflare"),
    ),
  );
  assert.deepEqual(result.warnings, []);
});

void test("routing failure rolls DNS and Compose back before commit without deleting the previous DNS", async (t) => {
  const fixture = await deploymentFixture(t, "routing");
  await assert.rejects(executeComposeDeployment(fixture), /Caddy rejected/);
  assert.deepEqual(
    [...fixture.records.values()].map(({ name }) => name),
    ["obsolete.example.com"],
  );
  assert(fixture.commands.some((script) => script.includes('runtime="$6"')));
});

void test("switching a Compose route to direct TLS relinquishes DNS ownership after commit", async (t) => {
  const fixture = await deploymentFixture(t);
  const app = fixture.context.app;
  assert(app.kind === "compose");
  const record = {
    id: "api",
    name: "api.example.com",
    type: "A",
    content: app.server,
    comment: "Managed by Towbar: stack",
    proxied: true,
    ttl: 1,
  };
  fixture.records.set(record.id, { ...record });
  app.services.api!.tls = { mode: "direct" };
  const result = await executeComposeDeployment({
    ...fixture,
    hooks: {
      commitRelease: () => {
        assert.deepEqual(fixture.records.get(record.id), record);
        return Promise.resolve({ retainedImageTags: [] });
      },
    },
  });
  assert.deepEqual(result.warnings, []);
  const releasedRecord = { ...record, comment: "" };
  assert.deepEqual(fixture.records.get(record.id), releasedRecord);

  fixture.secrets.previousCloudflareDns!.hostnames = ["console.example.com"];
  delete app.services.api;
  const nextDirectory = path.join(fixture.localDirectory, "next");
  await mkdir(nextDirectory);
  fixture.context.deploymentId = "next-deployment";
  await executeComposeDeployment({ ...fixture, localDirectory: nextDirectory });
  assert.deepEqual(fixture.records.get(record.id), releasedRecord);
});

void test("an uncertain release commit preserves the candidate DNS and rollback state", async (t) => {
  const fixture = await deploymentFixture(t);
  await assert.rejects(
    executeComposeDeployment({
      ...fixture,
      hooks: {
        commitRelease: () => Promise.reject(new Error("Lost commit response")),
      },
    }),
    DeploymentCommitUncertainError,
  );
  assert.equal(fixture.records.size, 3);
  assert(!fixture.commands.some((script) => script.includes('runtime="$6"')));
  assert(!fixture.mutations.some(({ method }) => method === "DELETE"));
});

void test("post-commit finalization failure preserves the live DNS and runtime", async (t) => {
  const fixture = await deploymentFixture(t, "finalize");
  await assert.rejects(
    executeComposeDeployment(fixture),
    DeploymentCommittedError,
  );
  assert.equal(fixture.records.size, 2);
  assert(!fixture.commands.some((script) => script.includes('runtime="$6"')));
});

void test("missing previous credentials produce a cleanup warning after a successful release", async (t) => {
  const fixture = await deploymentFixture(t);
  fixture.secrets.previousCloudflareDnsCleanupBlocked = true;
  const result = await executeComposeDeployment(fixture);
  assert(
    result.warnings.some((warning) =>
      warning.includes("DNS records need cleanup"),
    ),
  );
  assert.equal(fixture.records.size, 3);
});

void test("Compose renders Tunnel HTTP and legacy direct TLS alongside DNS TLS", () => {
  const caddy = renderComposeCaddy([
    {
      domains: ["tunnel.example.com"],
      ingress: { type: "cloudflare-tunnel" },
      upstreams: ["127.0.0.1:40001"],
    },
    {
      domains: ["legacy.example.com"],
      ingress: { type: "proxy" },
      upstreams: ["127.0.0.1:40002"],
    },
    {
      domains: ["dns.example.com"],
      ingress: { type: "proxy" },
      upstreams: ["127.0.0.1:40003"],
      tls: { mode: "cloudflare-dns", proxied: false },
    },
  ]);
  assert.match(caddy, /http:\/\/tunnel\.example\.com/u);
  assert.equal(caddy.match(/dns cloudflare/g)?.length, 1);
});
