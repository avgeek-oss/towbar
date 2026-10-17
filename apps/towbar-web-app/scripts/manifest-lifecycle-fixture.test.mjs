import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createFixtureApiServer } from "./fixture-api.ts";
async function fixture(t, role = "admin") {
  const server = createFixtureApiServer({ role });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
test("lifecycle fixtures expose distinct repository claims and confirmed idempotent retirement", async (t) => {
  const base = await fixture(t);
  const conflicts = await (
    await fetch(`${base}/v1/core/manifest-lifecycle?tab=conflicts`)
  ).json();
  assert.equal(conflicts.counts.conflicts, 2);
  assert.equal(
    new Set(conflicts.items[0].declarations.map((claim) => claim.sourceId))
      .size,
    2,
  );
  const retired = (
    await (
      await fetch(`${base}/v1/core/manifest-lifecycle?tab=retirements`)
    ).json()
  ).items[0];
  const path = `${base}/v1/core/retirements/${retired.workloads[0].id}/actions/remove`;
  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "fixture-retire",
    },
    body: JSON.stringify({
      expectedRevision: retired.workloads[0].revision,
      confirmManifestId: retired.manifestId,
      reason: "Retire fixture",
    }),
  };
  assert.equal(
    (
      await fetch(path, {
        ...request,
        body: JSON.stringify({ confirmManifestId: "wrong" }),
      })
    ).status,
    409,
  );
  const queued = await fetch(path, request);
  assert.equal(queued.status, 202);
  assert.deepEqual(
    await (await fetch(path, request)).json(),
    await queued.json(),
  );
});
test("viewer can inspect conflicts and retirements but cannot remove", async (t) => {
  const base = await fixture(t, "viewer");
  assert.equal((await fetch(`${base}/v1/core/manifest-lifecycle`)).status, 200);
  assert.equal(
    (
      await fetch(
        `${base}/v1/core/retirements/31111111-1111-4111-8111-aaaaaaaaaaaa/actions/remove`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      )
    ).status,
    403,
  );
});

test("retirement fixtures progress from queued to running and disappear after completion", async () => {
  const { createManifestLifecycleFixture } =
    await import("./manifest-lifecycle-fixture.ts");
  let now = 0;
  const api = createManifestLifecycleFixture(
    "source",
    "server",
    "workload",
    () => now,
  );
  const query = new URLSearchParams("tab=retirements");
  const item = api.list(query).items[0];
  const input = {
    confirmManifestId: item.manifestId,
    expectedRevision: item.workloads[0].revision,
    reason: "Retire fixture",
  };
  const accepted = api.remove(item.workloads[0].id, input, "attempt");
  assert(accepted);
  assert.equal(api.list(query).counts.removing, 1);
  assert.equal(api.list(query).items[0].operations[0].state, "queued");
  now = 3_000;
  assert.equal(api.list(query).items[0].operations[0].state, "running");
  now = 9_000;
  assert.equal(api.list(query).total, 0);
  assert.equal(api.list(query).counts.removing, 0);
  assert.deepEqual(
    api.remove(item.workloads[0].id, input, "attempt"),
    accepted,
  );
});
