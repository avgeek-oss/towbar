import assert from "node:assert/strict";
import test from "node:test";

import { CommandError, runCommand } from "./process.js";
import { rollingMemoryHeadroomScript } from "./rolling-headroom.js";

async function checkHeadroom(availableKiB: number, containers = 1) {
  // Emulate a two-core host whose running containers have 4.975 CPU limits.
  const host = String.raw`
awk() {
  if test "$2" = /proc/meminfo; then
    printf '%s\n' "${availableKiB}"
  else
    command awk "$@"
  fi
}
nproc() { printf '2\n'; }
docker() {
  if test "$1" = ps; then
    printf 'running-container\n'
  else
    printf '4975000000\n'
  fi
}
export -f docker
`;
  return await runCommand("bash", ["-s", "--", "256m", String(containers)], {
    input: host + rollingMemoryHeadroomScript,
  });
}

void test("allows rolling candidates when aggregate CPU limits exceed host capacity", async () => {
  await checkHeadroom(1_048_576);
});

void test("requires memory for every additional rolling candidate", async () => {
  await checkHeadroom(786_432, 3);
  await assert.rejects(checkHeadroom(786_431, 3), (error: unknown) => {
    assert.ok(error instanceof CommandError);
    assert.match(error.stderr, /Insufficient memory headroom/u);
    return true;
  });
});
