import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createFixtureApiServer, fixtureIds } from "./fixture-api.ts";

test("Preview history includes failed attempts, retries stay in Preview, and replay does not duplicate history", async (t) => {
  const server = createFixtureApiServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => (await fetch(base + path)).json();
  const path = `/v1/core/apps/${fixtureIds.stagingApp}`;
  const production = (await get(path + "/deployments")).deployments;
  const history = (await get(path + "/deployments?environment=preview"))
    .deployments;
  const failed = history.find((d) => d.state === "failed");
  assert(failed);
  assert(history.every((d) => d.environment === "preview"));
  assert(production.every((d) => d.environment === "production"));
  const request = () =>
    fetch(base + `/v1/core/deployments/${failed.id}/actions/retry`, {
      method: "POST",
      headers: { "Idempotency-Key": "fixture-preview-retry" },
    });
  const first = await request();
  assert.equal(first.status, 202);
  const result = await first.json();
  assert.equal(result.deployment.environment, "preview");
  assert.equal(result.deployment.hostname, failed.hostname);
  assert.equal(result.deployment.trigger, "manual");
  const replay = await request();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).deployment.id, result.deployment.id);
  assert.equal(
    (await get(path + "/deployments?environment=preview")).deployments.length,
    history.length + 1,
  );
  assert.deepEqual((await get(path + "/deployments")).deployments, production);
  const previews = (await get(path + "/previews")).previews;
  assert(
    previews.some(
      (p) =>
        p.latestDeploymentId === result.deployment.id && p.status === "healthy",
    ),
  );
});
