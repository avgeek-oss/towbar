import assert from "node:assert/strict";
import test from "node:test";
import { TowbarApiError } from "@workspace/towbar-web-client";
import { secretReferenceAt, secretReferenceError } from "./secret-reference";

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

test("shared preview failures identify the store without exposing server payloads", () => {
  const repository = { scope: "repo", key: "TOKEN" } as const;
  const workspace = { scope: "globals", key: "TOKEN" } as const;
  assert.match(
    secretReferenceError(
      new TowbarApiError(404, "NOT_FOUND", "Secret was not found"),
      repository,
    ),
    /Repository secret TOKEN.*current repository/,
  );
  assert.match(
    secretReferenceError(
      new TowbarApiError(404, "NOT_FOUND", "Secret was not found"),
      workspace,
    ),
    /Workspace secret TOKEN.*workspace secret store/,
  );
  assert.match(
    secretReferenceError(
      new TowbarApiError(403, "REAUTHENTICATION_REQUIRED", "Confirm identity"),
      repository,
    ),
    /Confirm your identity/,
  );
  assert.match(
    secretReferenceError(
      new TowbarApiError(403, "FORBIDDEN", "Hidden internal detail"),
      repository,
    ),
    /permission/,
  );
  assert.match(
    secretReferenceError(
      new TowbarApiError(429, "RATE_LIMITED", "Hidden internal detail"),
      repository,
    ),
    /Wait a moment/,
  );
  for (const error of [
    new Error("sensitive-value"),
    new TowbarApiError(500, "INTERNAL_ERROR", "sensitive-value"),
  ]) {
    const message = secretReferenceError(error, repository);
    assert.match(message, /hover again to retry/);
    assert(!message.includes("sensitive-value"));
  }
});
