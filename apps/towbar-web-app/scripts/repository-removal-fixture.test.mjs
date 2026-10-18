import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createFixtureApiServer, fixtureIds } from "./fixture-api.ts";

test("fixture repository removal hides an empty connection and protects workloads", async () => {
  const server = createFixtureApiServer({ role: "admin" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const request = (path, init) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/core/${path}`, init);
  try {
    assert.equal(
      (await request(`sources/${fixtureIds.source}`, { method: "DELETE" }))
        .status,
      409,
    );
    assert.equal(
      (await request(`sources/${fixtureIds.sandboxSource}`)).status,
      200,
    );
    assert.equal(
      (
        await request(`sources/${fixtureIds.sandboxSource}`, {
          method: "DELETE",
        })
      ).status,
      204,
    );
    assert.equal(
      (await request(`sources/${fixtureIds.sandboxSource}`)).status,
      404,
    );
    assert.equal(
      (
        await request(`sources/${fixtureIds.sandboxSource}`, {
          method: "DELETE",
        })
      ).status,
      204,
    );
    const list = await (await request("sources")).json();
    assert(
      !list.sources.some((source) => source.id === fixtureIds.sandboxSource),
    );
    assert(list.sources.some((source) => source.id === fixtureIds.source));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fixture repository removal requires an administrator", async () => {
  const server = createFixtureApiServer({ role: "member" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/core/sources/${fixtureIds.source}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
