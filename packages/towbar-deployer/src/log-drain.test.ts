import assert from "node:assert/strict";
import { execFile as execCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { drainCentralizedLogsShell, logDrainScript } from "./log-drain.js";
import * as remoteScripts from "./remote-scripts.js";
import * as restoreScripts from "./resource-restore-scripts.js";
import { startRemoteScript } from "./app-runtime-scripts.js";

const execFile = promisify(execCallback);
void test("drain helper checks the final stopped-container record without reading outside Docker's log root", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "towbar-log-drain-"));
  try {
    const helper = path.join(directory, "drain.py");
    await writeFile(helper, logDrainScript);
    const probe = String.raw`
import hashlib, io, json, pathlib, runpy, sys, tempfile
from unittest.mock import patch
m = runpy.run_path(sys.argv[1])
container = "a" * 64
line = json.dumps({"time": "2026-10-15T12:00:00.123456789Z", "stream": "stdout", "log": "final message\n"}, separators=(",", ":")).encode() + b"\n"
expected = hashlib.sha256(json.dumps([container, "1792065600123456789", "stdout", "17"], separators=(",", ":")).encode()).hexdigest()
assert m["record_identity"](container, line, 17) == expected
with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root).resolve()
    log = root / "containers" / container / (container + "-json.log")
    log.parent.mkdir(parents=True)
    prefix = b"1234567890123456\n"
    log.write_bytes(prefix + line)
    calls = []
    inspected = {"Id": container, "Config": {"Labels": {"towbar.managed": "true", "towbar.deployable": "workload"}}, "State": {"Running": True}, "HostConfig": {"LogConfig": {"Type": "json-file"}}, "LogPath": str(log)}
    def docker(*args):
        calls.append(args)
        if args[0] == "inspect": return json.dumps([inspected])
        if args[0] == "info": return str(root)
        if args[0] == "stop": return container
        raise AssertionError(args)
    final = m["final_record"]
    final.__globals__["docker"] = docker
    assert final("managed-container") == expected
    assert ("stop", "--time", "2", "managed-container") in calls
    calls.clear()
    inspected["LogPath"] = "/etc/passwd"
    try:
        final("managed-container")
        raise AssertionError("escaped path was accepted")
    except ValueError: pass
    assert not any(call[0] == "stop" for call in calls)
    inspected["LogPath"] = str(log)
    inspected["Config"]["Labels"]["towbar.managed"] = "false"
    assert final("unmanaged") is None
    settings = root / "config.json"
    settings.write_text(json.dumps({"endpoint": "https://towbar.example.test/v1/logs", "token": "test-credential", "serverId": "test-server"}))
    main = m["main"]
    main.__globals__["CONFIG"] = settings
    main.__globals__["final_record"] = lambda name: expected
    class Response(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *args): self.close()
    class Opener:
        def open(self, request, timeout):
            assert request.full_url == "https://towbar.example.test/v1/logs/drain"
            assert request.get_header("Authorization") == "Bearer test-credential"
            assert json.loads(request.data) == {"eventIds": [expected]}
            return Response(json.dumps({"acceptedEventIds": [expected]}).encode())
    with patch("urllib.request.build_opener", return_value=Opener()):
        assert main(["managed-container"]) == 0
print("drain record identity, ownership, path, stop and acknowledgement verified")
`;
    const result = await execFile("python3", ["-c", probe, helper]);
    assert.match(result.stdout, /acknowledgement verified/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("cleanup shell composition remains valid with the bounded drain function", async () => {
  const scripts = [
    ...Object.values(remoteScripts),
    ...Object.values(restoreScripts),
    startRemoteScript,
    drainCentralizedLogsShell,
  ].filter(
    (value): value is string =>
      typeof value === "string" &&
      (value.includes("set -euo pipefail") ||
        value === drainCentralizedLogsShell),
  );
  for (const script of scripts) await execFile("bash", ["-n", "-c", script]);
  assert(scripts.length >= 10);
});
