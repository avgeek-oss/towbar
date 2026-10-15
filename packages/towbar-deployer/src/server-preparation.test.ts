import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";

import { CommandError } from "./process.js";

import {
  ServerPreparationError,
  preparationErrorMessage,
  prepareServer,
  serverPreparationScripts,
} from "./server-preparation.js";
import { SshSession } from "./ssh.js";
import type {
  ServerPreparationContext,
  ServerPreparationHooks,
} from "./types.js";

const preparationContext: ServerPreparationContext = {
  preparationId: "test-preparation",
  privateKeyName: "Production servers",
  config: {
    ip: "192.0.2.10",
    ssh: { host: "192.0.2.10", username: "deploy", port: 22 },
    buildConcurrency: 1,
  },
  login: { privateKey: "private-test-value" },
  trustedHostKeys: [],
};

void test("records useful results and terminal output for all preparation steps", async (t) => {
  const events: Parameters<ServerPreparationHooks["step"]>[0][] = [];
  const logs = new Map<string, string>();
  let closed = false;
  const outputs = [
    "Ubuntu 24.04 LTS",
    "Python 3.12.3",
    "28.3.3",
    "v2.11.4",
    "Towbar directories and Docker access configured",
    "Ubuntu 24.04 LTS\n28.3.3\nv2.11.4\nPython 3.12.3\nzstd command line interface 1.5.7\n26214400",
  ];
  t.mock.method(SshSession, "connect", () =>
    Promise.resolve({
      run: async (
        _script: string,
        _args: string[],
        options: Parameters<SshSession["run"]>[2],
      ) => {
        const stdout = `${outputs.shift()}\n`;
        await options?.onStderr?.("Actual command output\n");
        await options?.onStdout?.(stdout);
        return { stdout, stderr: "Actual command output\n" };
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    }),
  );
  const result = await prepareServer(preparationContext, {
    installLogCollector: () => {
      assert.equal(
        outputs.length,
        2,
        "collector runs after Caddy and before access verification",
      );
      assert.equal(events.at(-1)?.id, "installing_log_collector");
      return Promise.resolve("OTEL Logs Collector installed and enabled");
    },
    step: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    log: ({ id, log }) => {
      logs.set(id, log);
      return Promise.resolve();
    },
  });
  assert.equal(closed, true);
  assert.equal(
    events.filter((event) => event.status === "succeeded").length,
    8,
  );
  assert.equal(logs.size, 8);
  assert.match(
    events.find(
      (event) => event.id === "connecting" && event.status === "succeeded",
    )!.message,
    /Production servers/,
  );
  assert.match(
    events.find(
      (event) => event.id === "inspecting" && event.status === "succeeded",
    )!.message,
    /Ubuntu release.*passwordless sudo/,
  );
  assert.match(logs.get("installing_prerequisites")!, /Actual command output/);
  assert.match(logs.get("verifying")!, /26214400/);
  assert.equal(result.diskAvailableKb, 26214400);
});

void test("retains failure output, redacts secrets, and stops subsequent steps", async (t) => {
  const events: Parameters<ServerPreparationHooks["step"]>[0][] = [];
  const logs: string[] = [];
  let closed = false;
  let commands = 0;
  t.mock.method(SshSession, "connect", () =>
    Promise.resolve({
      run: async (
        _script: string,
        _args: string[],
        options: Parameters<SshSession["run"]>[2],
      ) => {
        commands++;
        await options?.onStderr?.("API token 'private-");
        await options?.onStderr?.("test-value' appears invalid\n");
        throw new CommandError(
          "bash failed",
          "",
          "API token 'private-test-value' appears invalid",
        );
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    }),
  );
  await assert.rejects(
    prepareServer(preparationContext, {
      installLogCollector: () => {
        return Promise.reject(
          new Error("must not run after inspection failure"),
        );
      },
      step: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      log: ({ log }) => {
        logs.push(log);
        return Promise.resolve();
      },
    }),
    (error: unknown) =>
      error instanceof ServerPreparationError &&
      error.stepId === "inspecting" &&
      !error.message.includes("private-test-value"),
  );
  assert.equal(commands, 1);
  assert.equal(closed, true);
  assert.equal(events.at(-1)!.status, "failed");
  assert.doesNotMatch(JSON.stringify({ events, logs }), /private-test-value/);
  assert.match(logs.at(-1)!, /appears invalid/);
});

void test("uses signed upstream package repositories and pinned Caddy inputs", () => {
  assert.match(
    serverPreparationScripts.installDocker,
    /https:\/\/download\.docker\.com\/linux\/ubuntu/,
  );
  assert.doesNotMatch(
    serverPreparationScripts.installDocker,
    /get\.docker\.com/,
  );
  assert.match(
    serverPreparationScripts.installCaddy,
    /https:\/\/dl\.cloudsmith\.io\/public\/caddy\/stable/,
  );
  assert.match(serverPreparationScripts.installCaddy, /caddy:2\.11\.4-builder/);
  assert.match(serverPreparationScripts.installCaddy, /build v2\.11\.4/);
  assert.match(
    serverPreparationScripts.installCaddy,
    /github\.com\/caddy-dns\/cloudflare@v0\.2\.4/,
  );
});

void test("Cloudflare DNS preparation is serialized and uses the Caddy module", () => {
  const syntax = spawnSync("bash", ["-n"], {
    encoding: "utf8",
    input: serverPreparationScripts.ensureCloudflareCaddy,
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(
    serverPreparationScripts.ensureCloudflareCaddy,
    /flock -w 900 \/var\/lock\/towbar-caddy-cloudflare\.lock/u,
  );
  assert.match(
    serverPreparationScripts.ensureCloudflareCaddy,
    /bash -s -- true/u,
  );
  assert.match(
    serverPreparationScripts.ensureCloudflareCaddy,
    /github\.com\/caddy-dns\/cloudflare@v0\.2\.4/u,
  );
});

void test("refuses conflicting installations instead of removing them", () => {
  assert.match(
    serverPreparationScripts.installDocker,
    /Remove the conflicting installation before continuing/,
  );
  assert.match(
    serverPreparationScripts.installCaddy,
    /Remove it or use a fresh server/,
  );
  assert.doesNotMatch(
    serverPreparationScripts.installDocker,
    /apt-get\s+(?:-\w+\s+)*remove/,
  );
  assert.doesNotMatch(
    serverPreparationScripts.installDocker,
    /apt-get\s+(?:-\w+\s+)*purge/,
  );
});

void test("missing Docker conflict packages do not stop fresh-server preparation", () => {
  const script = serverPreparationScripts.installDocker;
  const start = script.indexOf('conflicts="$({');
  const end = script.indexOf('\n  if test -n "$conflicts"', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const result = spawnSync(
    "bash",
    [
      "-c",
      String.raw`
set -euo pipefail
dpkg-query() { return 1; }
${script.slice(start, end)}
printf '%s' "$conflicts"
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

void test("requires pinned SSH trust and verifies the installed services", () => {
  assert.match(serverPreparationScripts.inspectServer, /Ubuntu 22\.04/);
  assert.match(
    serverPreparationScripts.inspectServer,
    /sudo -n true 2>\/dev\/null/,
  );
  assert.match(serverPreparationScripts.verifyServer, /systemctl is-active/);
  assert.match(serverPreparationScripts.verifyServer, /docker info/);
  assert.match(serverPreparationScripts.verifyServer, /caddy validate/);
  assert.match(serverPreparationScripts.verifyServer, /python3/);
});

void test("captures package-manager output on stderr without changing result parsing", () => {
  assert.match(
    serverPreparationScripts.installPrerequisites,
    /python3 sudo util-linux zstd unattended-upgrades >&2/,
  );
  assert.match(
    serverPreparationScripts.installDocker,
    /docker-compose-plugin \\\s+>&2/,
  );
  assert.match(serverPreparationScripts.installCaddy, /caddy >&2/);
});

void test("Caddy installation diagnostics do not pollute its recorded version", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      String.raw`
id() { printf '1000\n'; }
sudo() { shift; "$@"; }
CADDY_READY=false
caddy() {
  case "$1" in
    list-modules)
      if [[ "$CADDY_READY" == true ]]; then printf 'dns.providers.cloudflare\n'; fi
      return 0 ;;
    version) printf 'v2.11.4 build-info\n' ;;
  esac
}
dpkg-query() { printf 'install ok installed\n'; }
mktemp() { printf '/tmp/towbar-preparation-test-unused\n'; }
docker() { printf 'Building Caddy\n'; }
test() {
  if [[ "$1" == '-x' ]]; then return 0; fi
  builtin test "$@"
}
/tmp/towbar-preparation-test-unused/caddy() { printf 'dns.providers.cloudflare\n'; }
dpkg-divert() {
  if [[ "$1" == '--list' ]]; then return 0; fi
  printf 'Adding diversion of /usr/bin/caddy\n'
}
update-alternatives() { printf 'Using Caddy alternative\n'; }
install() { CADDY_READY=true; }
rm() { :; }
systemctl() { printf 'Enabled Caddy service\n'; }
${serverPreparationScripts.installCaddy}
`,
      "preparation-test",
      "true",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "v2.11.4\n");
  assert.match(result.stderr, /Building Caddy/);
  assert.match(result.stderr, /Adding diversion/);
  assert.match(result.stderr, /Using Caddy alternative/);
  assert.match(result.stderr, /Enabled Caddy service/);
});

void test("re-preparation cleanup only removes Towbar app containers selected by deployable id", () => {
  const script = serverPreparationScripts.cleanupExistingApps;
  assert.match(script, /label=towbar\.managed=true/);
  assert.match(script, /towbar\.deployable/);
  assert.match(script, /docker", "rm", "--force"/);
  assert.doesNotMatch(script, /docker", "volume"/);
});

void test("fully consumes Caddy module output under pipefail", () => {
  for (const script of [
    serverPreparationScripts.installCaddy,
    serverPreparationScripts.verifyServer,
  ]) {
    assert.match(script, /grep -Fx dns\.providers\.cloudflare >\/dev\/null/);
    assert.doesNotMatch(script, /grep -Fxq dns\.providers\.cloudflare/);
  }
});

void test("validates with the installed Caddy environment and supports a fresh server", () => {
  const script = serverPreparationScripts.verifyServer;
  const validation = script.slice(
    script.indexOf("validate_args="),
    script.indexOf("disk_available="),
  );
  for (const envExists of [true, false]) {
    const output = execFileSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
SUDO=(privileged)
privileged() {
  if test "$1" = test; then return ${envExists ? 0 : 1}; fi
  test "$1" = caddy
  test "$2" = validate
  test "$3" = --config
  test "$4" = /etc/caddy/Caddyfile
  test "$#" -eq ${envExists ? 6 : 4}
  ${envExists ? 'test "$5" = --envfile; test "$6" = /etc/caddy/towbar/cloudflare.env' : ":"}
}
${validation}
`,
      ],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    assert.equal(output, "");
  }
});

void test("preserves the Caddy failure after noisy startup output and redacts tokens", () => {
  const noise = Array.from({ length: 30 }, () =>
    JSON.stringify({ level: "info", msg: "starting certificate maintenance" }),
  ).join("\n");
  const error = new CommandError(
    "bash exited unsuccessfully",
    "",
    `${noise}\nError: loading DNS provider: API token 'sensitive-token' appears invalid`,
  );
  assert.equal(
    preparationErrorMessage(error),
    "Error: loading DNS provider: API token '[redacted]' appears invalid",
  );
});

void test("retains the end of long diagnostics and actual conflict guidance", () => {
  const message = preparationErrorMessage(
    new CommandError(
      "failed",
      "",
      `Error: ${"nested module: ".repeat(100)}certificate could not be loaded`,
    ),
  );
  assert.equal(message.length, 800);
  assert.ok(message.endsWith("certificate could not be loaded"));
  const conflict =
    "An incompatible Docker installation is already present. Remove the conflicting installation before continuing.";
  assert.equal(
    preparationErrorMessage(new CommandError("failed", "", conflict)),
    conflict,
  );
  assert.equal(
    preparationErrorMessage(new Error("SSH connection timed out")),
    "SSH connection timed out",
  );
});

void test("describes silent SSH preparation failures by step", () => {
  const error = new CommandError("ssh exited unsuccessfully", "", "");
  assert.equal(
    preparationErrorMessage(error, [], "connecting"),
    "The SSH connection failed before the server returned a diagnostic. Verify the selected private key, SSH username, SSH port, and firewall rules, then try again.",
  );
  assert.equal(
    preparationErrorMessage(error, [], "installing_docker"),
    "Docker setup stopped without reporting a reason. Check APT and the Docker service logs on the server, then retry.",
  );
});

void test("collector failure stops setup after Caddy and remains retryable from its own step", async (t) => {
  const events: Parameters<ServerPreparationHooks["step"]>[0][] = [];
  const outputs = ["Ubuntu 24.04 LTS", "Python 3.12.3", "29.0.0", "v2.11.4"];
  let closed = false;
  t.mock.method(SshSession, "connect", () =>
    Promise.resolve({
      run: () => {
        assert(
          outputs.length > 0,
          "access and verification must not run after collector failure",
        );
        return Promise.resolve({ stdout: `${outputs.shift()}\n`, stderr: "" });
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    }),
  );
  await assert.rejects(
    prepareServer(preparationContext, {
      step: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      installLogCollector: () =>
        Promise.reject(new Error("ClickHouse connection refused")),
    }),
    (error: unknown) =>
      error instanceof ServerPreparationError &&
      error.stepId === "installing_log_collector" &&
      /ClickHouse connection refused/.test(error.message),
  );
  assert.equal(outputs.length, 0);
  assert.equal(closed, true);
  assert.equal(events.at(-1)?.id, "installing_log_collector");
  assert.equal(events.at(-1)?.status, "failed");
});
