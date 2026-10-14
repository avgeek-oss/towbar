import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GET } from "../app/favicon.ico/route";

void test("the public canonical favicon redirects to packaged PNG artwork", () => {
  const response = GET();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/brand/towbar-favicon.png");
  const artwork = readFileSync(
    new URL("../../public/brand/towbar-favicon.png", import.meta.url),
  );
  assert.equal(artwork.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual(
    readFileSync(
      new URL(
        "../../../towbar-api/public/brand/towbar-favicon.png",
        import.meta.url,
      ),
    ),
    artwork,
  );
});
