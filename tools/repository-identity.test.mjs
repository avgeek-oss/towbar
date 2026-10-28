import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  symlink,
} from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "towbar-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  await mkdir(join(root, "tools"));
  await copyFile(
    new URL("./check-repository-references.mjs", import.meta.url),
    join(root, "tools/check-repository-references.mjs"),
  );
  await copyFile(
    new URL("./sync-repository-identity.mjs", import.meta.url),
    join(root, "tools/sync-repository-identity.mjs"),
  );
  await symlink(
    new URL("../node_modules", import.meta.url).pathname,
    join(root, "node_modules"),
  );
  const identity = {
    repository: "old-org/old-name",
    repositoryId: 123,
    imageRegistry: "ghcr.io/old-org",
    previousRepositories: [],
    previousImageRegistries: [],
  };
  await writeFile(join(root, "repository.json"), JSON.stringify(identity));
  await writeFile(
    join(root, "README.md"),
    "https://github.com/old-org/old-name.git\n",
  );
  await writeFile(
    join(root, "release.yml"),
    "image: ghcr.io/old-org/towbar-api\n",
  );
  git("init", "-q");
  git("add", "repository.json", "README.md", "release.yml");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "baseline",
  );
  const run = (script) =>
    spawnSync(process.execPath, [join(root, "tools", script)], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY_ID: "", GITHUB_REPOSITORY: "" },
    });
  const save = () =>
    writeFile(join(root, "repository.json"), JSON.stringify(identity));
  return { root, identity, run, save, git };
}
test("renames require recorded aliases and explicit documentation and image updates", async (t) => {
  const { root, identity, run, save, git } = await fixture(t);
  identity.repository = "new-org/new-name";
  identity.imageRegistry = "ghcr.io/new-org";
  await save();
  assert.match(
    run("check-repository-references.mjs").stderr,
    /Record the previous repository/,
  );
  identity.previousRepositories.push("old-org/old-name");
  await save();
  assert.match(
    run("check-repository-references.mjs").stderr,
    /Record the previous image registry/,
  );
  identity.previousImageRegistries.push("ghcr.io/old-org");
  await save();
  const obsolete = run("check-repository-references.mjs");
  assert.notEqual(obsolete.status, 0);
  assert.match(obsolete.stderr, /README.md/);
  assert.match(obsolete.stderr, /release.yml/);
  await writeFile(
    join(root, "README.md"),
    "https://github.com/new-org/new-name\n",
  );
  await writeFile(
    join(root, "release.yml"),
    "image: ghcr.io/new-org/towbar-api\n",
  );
  assert.equal(run("check-repository-references.mjs").status, 0);
  await rm(join(root, "release.yml"));
  assert.equal(run("check-repository-references.mjs").status, 0);
  git("add", "-u");
  git("add", "repository.json");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "rename",
  );
  await writeFile(
    join(root, "README.md"),
    "https://raw.githubusercontent.com/old-org/old-name/main/file\n",
  );
  assert.match(
    run("check-repository-references.mjs").stderr,
    /obsolete repository/,
  );
});
test("generation only updates declared outputs and leaves documentation untouched", async (t) => {
  const { root, identity, run, save } = await fixture(t);
  identity.repository = "new-org/new-name";
  await save();
  for (const path of [
    "packages/towbar-contracts/src",
    "apps/towbar-monitoring-agent",
  ])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ repository: { type: "git", url: "old" } }),
  );
  await writeFile(
    join(root, "apps/towbar-monitoring-agent/go.mod"),
    "module old\n\ngo 1.26\n",
  );
  const before = await readFile(join(root, "README.md"), "utf8");
  const result = run("sync-repository-identity.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), before);
  assert.match(
    await readFile(
      join(root, "packages/towbar-contracts/src/repository-identity.ts"),
      "utf8",
    ),
    /new-org\/new-name/,
  );
  assert.match(
    await readFile(join(root, "apps/towbar-monitoring-agent/go.mod"), "utf8"),
    /new-org\/new-name/,
  );
});
