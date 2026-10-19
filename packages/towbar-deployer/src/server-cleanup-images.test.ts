import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { serverCleanupResultSchema } from "@workspace/towbar-core";
import { cleanupOrphansScript } from "./server-cleanup.js";
const execute = promisify(execFile);

for (const cacheFails of [false, true]) {
  void test(`cleans ledger-owned OCI images while preserving releases, aliases, containers and protected workloads (cache failure: ${cacheFails})`, async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "towbar-image-cleanup-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixtures = Object.fromEntries(
      [
        "current",
        "previous",
        "alias",
        "obsolete",
        "untagged",
        "referenced",
        "retired",
        "foreign",
      ].map((name) => [
        name,
        {
          Id: name === "alias" ? "current" : name,
          RepoTags:
            name === "untagged"
              ? [`ghcr.io/test/app@sha256:${name}`]
              : [`towbar/${name}:release`],
          RepoDigests: [`ghcr.io/test/app@sha256:${name}`],
          Config: { Labels: {} },
        },
      ]),
    );
    await writeFile(
      path.join(directory, "images.json"),
      JSON.stringify(fixtures),
    );
    await writeFile(
      path.join(directory, "docker"),
      `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root=Path(os.environ['IMAGE_TEST_DIRECTORY'])
file=root/'images.json'
images=json.loads(file.read_text())
a=sys.argv[1:]
if a[:2]==['image','inspect']:
    image=next((v for v in images.values() if a[2]==v['Id'] or a[2] in v['RepoTags']),None)
    if not image: sys.exit(1)
    print(json.dumps([image]))
elif a[:2]==['container','inspect']:
    print(json.dumps([{'Id':'container','Image':'referenced','Config':{'Labels':{}}}]))
elif a[0]=='ps': print('container')
elif a[:2]==['image','ls']:
    if '--format' in a: print('\\n'.join(tag if '@' not in tag else tag.split('@')[0]+':<none>' for v in images.values() for tag in v['RepoTags']))
    else: print('\\n'.join(dict.fromkeys(v['Id'] for v in images.values())))
elif a[:2]==['image','rm']:
    for k,v in list(images.items()):
        if a[2]==v['Id']: del images[k]
        elif a[2] in v['RepoTags']: v['RepoTags'].remove(a[2])
    file.write_text(json.dumps(images))
elif a[0]=='info': print(root)
elif a[:2]==['buildx','prune']:
    if os.environ.get('IMAGE_TEST_CACHE_FAIL'): sys.exit(1)
    print('Total: 2GB')
elif a[0] not in ['volume','network']: sys.exit(9)
`,
      { mode: 0o700 },
    );
    const expected = {
      ownedDeployableIds: ["app", "pending"],
      deployableIds: ["app", "pending"],
      protectedDeployableIds: ["pending"],
      containerNames: [],
      imageTags: ["towbar/current:release", "towbar/previous:release"],
      imageOwners: Object.fromEntries(
        Object.keys(fixtures)
          .filter((name) => name !== "foreign")
          .flatMap((name) => [
            [`towbar/${name}:release`, name === "retired" ? "pending" : "app"],
            [`sha256:${name}`, name === "retired" ? "pending" : "app"],
          ]),
      ),
    };
    const script = cleanupOrphansScript.replace("sudo python3", "python3");
    const result = await execute(
      "bash",
      ["-c", script, "test", "[]", JSON.stringify(expected), "true", "true"],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          IMAGE_TEST_DIRECTORY: directory,
          IMAGE_TEST_CACHE_FAIL: cacheFails ? "1" : "",
        },
      },
    );
    const outcome = serverCleanupResultSchema.parse(JSON.parse(result.stdout));
    assert.deepEqual(outcome.cleaned.map((i) => i.name).sort(), [
      "towbar/obsolete:release",
      "untagged",
    ]);
    assert.equal(
      outcome.buildCache?.status,
      cacheFails ? "failed" : "succeeded",
    );
    const remaining = JSON.parse(
      await readFile(path.join(directory, "images.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(remaining).sort(), [
      "alias",
      "current",
      "foreign",
      "previous",
      "referenced",
      "retired",
    ]);
    assert(outcome.skipped.some((i) => i.reason.includes("rollback")));
    assert(
      outcome.skipped.some((i) => i.reason.includes("container references")),
    );
  });
}

void test("only full manual cleanup prunes shared build cache and cache failures retain their result", async () => {
  const { executeServerCleanup } = await import("./server-cleanup.js");
  type CleanupRequest = Extract<
    import("@workspace/towbar-core").ResourceOperationRequest,
    { type: "cleanup_orphans" }
  >;
  const requests: Array<[CleanupRequest, boolean]> = [
    [{ type: "cleanup_orphans", items: [], trigger: "manual" }, true],
    [
      {
        type: "cleanup_orphans",
        items: [],
        trigger: "manual",
        scope: "selected",
      },
      false,
    ],
    [{ type: "cleanup_orphans", items: [], trigger: "sync" }, false],
    [
      {
        type: "cleanup_orphans",
        items: [],
        trigger: "manual",
        retiringDeployableIds: ["retirement"],
      },
      false,
    ],
  ];
  let failed = false;
  for (const [request, expectedPrune] of requests) {
    const session = {
      run: (_script: string, args: string[]) => {
        assert.equal(args[3], String(expectedPrune));
        return Promise.resolve({
          stderr: "",
          stdout: JSON.stringify({
            cleaned: [],
            skipped: [],
            ...(failed
              ? { buildCache: { status: "failed", message: "Could not prune" } }
              : {}),
          }),
        });
      },
    } as unknown as import("./ssh.js").SshSession;
    const input = {
      session,
      request,
      expected: { imageTags: [], containerNames: [], deployableIds: [] },
    };
    await executeServerCleanup(input);
    failed = true;
    await assert.rejects(executeServerCleanup(input), (error: unknown) => {
      assert.equal(
        (error as { cleanupResult: { buildCache: { status: string } } })
          .cleanupResult.buildCache.status,
        "failed",
      );
      return true;
    });
    failed = false;
  }
});
