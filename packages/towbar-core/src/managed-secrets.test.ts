import { parseResolvedManifest } from "./manifest-test-helper.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applySecretMutation,
  resolveSecretReferences,
  secretMutationSchema,
  secretReferenceDependencies,
  validateSecretReferences,
} from "./managed-secrets.js";

void test("write-only mutations preserve unspecified keys, allow empty values, and remove keys without restoring inheritance", () => {
  const shared = { TOKEN: "shared", COMMON: "common" };
  const local = { TOKEN: "local", REMOVE: "old" };
  const changed = applySecretMutation(local, {
    set: { EMPTY: "" },
    delete: ["TOKEN", "REMOVE"],
  });
  assert.deepEqual(resolveSecretReferences(changed, shared), {
    EMPTY: "",
  });
  assert.equal(local.TOKEN, "local");
});
void test("rejects ambiguous mutations, invalid names, null bytes and missing revisions", () => {
  for (const input of [
    { set: { TOKEN: "value" } },
    { expectedRevision: null, set: { "bad-name": "value" } },
    { expectedRevision: null, set: { TOKEN: "value\0" } },
    { expectedRevision: null, set: { TOKEN: "value" }, delete: ["TOKEN"] },
    { expectedRevision: null, delete: ["TOKEN", "TOKEN"] },
  ])
    assert.equal(secretMutationSchema.safeParse(input).success, false);
});
void test("prototype-shaped keys cannot alter object prototypes or silently disappear", () => {
  assert.equal(
    secretMutationSchema.safeParse(
      JSON.parse(
        '{"expectedRevision":null,"set":{"__proto__":"safe","TOKEN":"safe"}}',
      ),
    ).success,
    false,
  );
  const result = applySecretMutation(
    {},
    {
      set: JSON.parse('{"__proto__":"safe","constructor":"safe"}') as Record<
        string,
        string
      >,
      delete: [],
    },
  );
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(result["__proto__"], "safe");
});
void test("manifests reject secret assignments at every former scope", () => {
  const base =
    "version: 2\napps:\n  - id: demo\n    name: Demo\n    server: 192.0.2.10\n    dockerfile: Dockerfile\n    context: .\n    container:\n      port: 3000\n";
  assert.doesNotThrow(() => parseResolvedManifest(base));
  for (const manifest of [
    `${base}secrets:\n  build: [aws:old]\n`,
    `${base}servers:\n  - ip: 192.0.2.10\n    ssh:\n      username: deploy\n    secrets:\n      login: aws:old\n`,
    `${base}    secrets:\n      build: aws:old\n`,
    `${base}    hooks:\n      preDeploy:\n        command: [node, migrate.js]\n        secrets: aws:old\n`,
    `${base}    preview:\n      enabled: true\n      domain: preview.example.com\n      secrets: {}\n`,
  ])
    assert.throws(() => parseResolvedManifest(manifest));
});

void test("only explicit global references add shared values", () => {
  const globals = { TOKEN: "global$&", EMPTY: "", UNUSED: "hidden" };
  assert.deepEqual(resolveSecretReferences({}, globals), {});
  assert.deepEqual(
    resolveSecretReferences(
      {
        TOKEN: "local",
        AUTH: "Bearer {{globals.TOKEN}}",
        EMPTY: "{{globals.EMPTY}}",
      },
      globals,
    ),
    { TOKEN: "local", AUTH: "Bearer global$&", EMPTY: "" },
  );
  assert.throws(
    () => resolveSecretReferences({ SECRET: "{{globals.MISSING}}" }, globals),
    /unavailable globals reference/,
  );
  assert.throws(
    () => resolveSecretReferences({ SECRET: "{{globals.toString}}" }, globals),
    /unavailable globals reference/,
  );
  assert.deepEqual(secretReferenceDependencies({ AUTH: "{{globals.TOKEN}}" }), {
    global: true,
    repository: false,
  });
  assert.deepEqual(secretReferenceDependencies({ TOKEN: "literal" }), {
    global: false,
    repository: false,
  });
});
void test("reference syntax respects scope and errors do not contain values", () => {
  assert.doesNotThrow(() =>
    validateSecretReferences({ TOKEN: "{{globals.KEY}}" }, "app"),
  );
  for (const [scope, value] of [
    ["workspace", "{{globals.KEY}}"],
    ["workspace", "{{repo.KEY}}"],
    ["repository", "{{repo.KEY}}"],
    ["repository", "{{globals.KEY}}"],
    ["app", "{{repo.bad-name}}"],
    ["app", "{{globals.bad-name}}"],
    ["app", "{{source.KEY}}"],
    ["app", "{{source.SECRET"],
  ] as const)
    assert.throws(
      () => validateSecretReferences({ TOKEN: value }, scope),
      /Secret TOKEN/,
    );
  assert.throws(
    () =>
      resolveSecretReferences(
        { AUTH: "{{globals.KEY}}{{globals.KEY}}" },
        { KEY: "x".repeat(40_000) },
      ),
    /size limit/,
  );
});

void test("masked placeholders cannot replace stored secrets", () => {
  for (const value of ["••••••••", "********"])
    assert.equal(
      secretMutationSchema.safeParse({
        expectedRevision: null,
        set: { TOKEN: value },
      }).success,
      false,
    );
});

void test("repository references are explicit, scoped, and replaced once", () => {
  const globals = { TOKEN: "workspace", UNUSED: "not injected" };
  const repository = {
    TOKEN: "$&repo",
    EMPTY: "",
    LITERAL: "{{globals.TOKEN}}",
  };
  assert.doesNotThrow(() =>
    validateSecretReferences({ TOKEN: "{{repo.TOKEN}}" }, "app"),
  );
  assert.deepEqual(
    resolveSecretReferences(
      {
        AUTH: "{{globals.TOKEN}} / {{ repo.TOKEN }}",
        EMPTY: "{{repo.EMPTY}}",
        LITERAL: "{{repo.LITERAL}}",
      },
      globals,
      repository,
    ),
    { AUTH: "workspace / $&repo", EMPTY: "", LITERAL: "{{globals.TOKEN}}" },
  );
  assert.deepEqual(
    secretReferenceDependencies({ AUTH: "{{globals.TOKEN}} {{repo.TOKEN}}" }),
    { global: true, repository: true },
  );
  assert.deepEqual(resolveSecretReferences({}, globals, repository), {});
  for (const key of ["MISSING", "toString", "bad-name"]) {
    assert.throws(
      () =>
        resolveSecretReferences(
          { TOKEN: `{{repo.${key}}}` },
          globals,
          repository,
        ),
      /unavailable repo reference/,
    );
  }
  assert.throws(
    () =>
      resolveSecretReferences(
        { TOKEN: "{{repo.TOKEN}}{{repo.TOKEN}}" },
        {},
        { TOKEN: "x".repeat(40_000) },
      ),
    /size limit/,
  );
});
