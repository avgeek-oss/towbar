import assert from "node:assert/strict";
import test from "node:test";
import { app } from "./routes-test-app.js";

void test("only browser Admins can reach host upgrades", async () => {
  for (const role of ["member", "viewer"] as const) {
    for (const path of ["/", "/plan", "/jobs"]) {
      const response = await app(role).request(path, {
        method: path === "/" ? "GET" : "POST",
      });
      assert.equal(response.status, 403);
    }
  }
  assert.equal((await app("admin", true).request("/")).status, 404);
  assert.equal(
    (await app("admin", true).request("/jobs", { method: "POST" })).status,
    404,
  );
});
void test("upgrade mutations require recent browser authentication", async () => {
  for (const path of ["/plan", "/jobs"])
    assert.equal(
      (await app("admin").request(path, { method: "POST" })).status,
      401,
    );
});
void test("unsupported installations retain the CLI path", async () => {
  delete process.env.TOWBAR_HOST_UPGRADES;
  const response = await app("admin").request("/");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    supported: boolean;
    reason: string;
  };
  assert.equal(body.supported, false);
  assert.match(body.reason, /sudo towbar upgrade/u);
});
