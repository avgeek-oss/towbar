import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createFixtureApiServer, fixtureIds } from "./fixture-api.ts";
async function fixture(role, run) {
  const server = createFixtureApiServer({ role });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run((path) =>
      fetch(`http://127.0.0.1:${server.address().port}/v1/core/${path}`),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
test("fixture deliveries preserve status metadata and paginate", async () => {
  await fixture("admin", async (request) => {
    const all = await (await request("notifications/deliveries")).json();
    assert.equal(all.items.length, 25);
    assert(all.nextCursor);
    const failed = await (
      await request("notifications/deliveries?provider=discord&state=failed")
    ).json();
    assert(failed.items.length > 0);
    assert(
      failed.items.every(
        (item) =>
          item.provider === "discord" &&
          item.state === "failed" &&
          item.errorCode,
      ),
    );
    const categories = await (
      await request(
        "notifications/deliveries?category=backupsAndRestores&limit=100",
      )
    ).json();
    assert(categories.items.length > 0);
    assert.deepEqual(
      [...new Set(categories.items.map((item) => item.category))].sort(),
      ["backups", "restores"],
    );
    const deploymentFailures = await (
      await request("notifications/deliveries?category=deploymentFailures")
    ).json();
    assert(deploymentFailures.items.length > 0);
    assert(
      deploymentFailures.items.every((item) =>
        ["deployment.failed", "preview.failed"].includes(item.type),
      ),
    );
    const combined = await (
      await request(
        "notifications/deliveries?category=backupsAndRestores&provider=discord&state=failed",
      )
    ).json();
    assert(combined.items.length > 0);
    assert(
      combined.items.every(
        (item) =>
          item.provider === "discord" &&
          item.state === "failed" &&
          ["backups", "restores"].includes(item.category),
      ),
    );
    const tests = await (
      await request("notifications/deliveries?category=test")
    ).json();
    assert.equal(tests.items.length, 1);
    assert.equal(tests.items[0].type, "notification.test");
    assert.equal(
      (await request("notifications/deliveries?category=invalid")).status,
      400,
    );
    assert(!JSON.stringify(all).includes("webhookUrl"));
  });
});
test("members and viewers cannot read team-wide histories", async () => {
  for (const role of ["member", "viewer"])
    await fixture(role, async (request) => {
      for (const path of ["notifications/deliveries"])
        assert.equal((await request(path)).status, 403);
    });
});
test("global delivery history filters apps, resources, and servers", async () => {
  await fixture("admin", async (request) => {
    for (const entityId of [
      fixtureIds.app,
      fixtureIds.resource,
      fixtureIds.server,
    ]) {
      const result = await (
        await request(`notifications/deliveries?entityId=${entityId}`)
      ).json();
      assert(result.items.length > 0);
      assert(result.items.every((item) => item.targetId === entityId));
    }
  });
});
