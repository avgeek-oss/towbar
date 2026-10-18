import assert from "node:assert/strict";
import test from "node:test";
import { secretReferenceAt } from "./secret-reference";

test("finds repository and workspace references at the pointer or cursor", () => {
  const line = 'URL="{{repo.DATABASE_URL}} / {{ globals.TOKEN }}"';
  assert.deepEqual(secretReferenceAt(line, line.indexOf("DATABASE")), {
    from: 5,
    to: 26,
    scope: "repo",
    key: "DATABASE_URL",
  });
  assert.equal(
    secretReferenceAt(line, line.indexOf("TOKEN"))?.scope,
    "globals",
  );
  assert.equal(
    secretReferenceAt("export X={{repo._TOKEN2}}", 18)?.key,
    "_TOKEN2",
  );
});

test("only previews references, not names, plain values or unsupported namespaces", () => {
  for (const line of [
    "TOKEN=literal",
    "# TOKEN={{repo.TOKEN}}",
    "{{repo.TOKEN}}",
    "TOKEN={{env.TOKEN}}",
    "TOKEN={{repo.bad-key}}",
    "TOKEN={{repo.1KEY}}",
    "TOKEN={{repo.TOKEN}",
  ])
    assert.equal(secretReferenceAt(line, 15), undefined);
  assert.equal(secretReferenceAt("TOKEN={{repo.TOKEN}}", 2), undefined);
});

test("respects character boundaries and the hovered side", () => {
  const line = "X={{repo.KEY}}";
  assert.equal(secretReferenceAt(line, 2, -1), undefined);
  assert.equal(secretReferenceAt(line, 2, 1)?.key, "KEY");
  assert.equal(secretReferenceAt(line, line.length, 1), undefined);
  assert.equal(secretReferenceAt(line, line.length, -1)?.key, "KEY");
});
