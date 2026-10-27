import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  artifactNames,
  identity,
  sha256,
  validateRelease,
} from "./release.mjs";

test("assembly pins committed bytes and rejects a tag that differs from HEAD", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "towbar-assemble-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root });
  git("init", "--quiet");
  const files = {
    "package.json": JSON.stringify({ version: "2.0.30" }),
    "install.sh": "#!/bin/bash\necho installer\n",
    "infra/towbar": "#!/bin/bash\necho cli\n",
    "docker-compose.yml": "services: {}\n",
    "infra/runtime_config.py": "# runtime configuration fixture\n",
    ...Object.fromEntries(
      ["repository", "app", "compose", "resource"].map((name) => [
        `packages/towbar-core/schemas/${name}.v2.json`,
        JSON.stringify({ title: name }),
      ]),
    ),
  };
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), body);
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Release Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "release fixture",
  );
  const commit = git("rev-parse", "HEAD").toString().trim();
  git("tag", "v2.0.30");
  await writeFile(join(root, "install.sh"), "uncommitted installer");
  await writeFile(join(root, "untracked.txt"), "not in release");
  const imageFile = join(root, "images.json");
  await writeFile(
    imageFile,
    JSON.stringify({
      version: "v2.0.30",
      commit,
      images: Object.fromEntries(
        ["api", "worker", "web-app"].map((service) => [
          service,
          `${identity.imageRegistry}/towbar-${service}@sha256:${"b".repeat(64)}`,
        ]),
      ),
    }),
  );
  const output = join(root, "release-artifacts");
  const assembler = fileURLToPath(new URL("./assemble.mjs", import.meta.url));
  const assemble = () =>
    execFileSync(
      process.execPath,
      [assembler, output, "v2.0.30", commit, imageFile],
      { cwd: root, stdio: "pipe" },
    );
  assemble();
  const release = validateRelease(
    JSON.parse(await readFile(join(output, "release.json"), "utf8")),
  );
  assert.equal(release.commit, commit);
  assert.equal(
    await readFile(join(output, "install.sh"), "utf8"),
    files["install.sh"],
  );
  assert.equal(
    await readFile(join(output, "towbar"), "utf8"),
    files["infra/towbar"],
  );
  for (const name of [...artifactNames, "SHA256SUMS"])
    assert.equal(
      sha256(await readFile(join(output, name))),
      release.artifacts[name],
      name,
    );
  const archive = execFileSync("tar", ["-tzf", join(output, "source.tar.gz")])
    .toString()
    .split("\n");
  for (const name of Object.keys(files))
    assert(archive.includes(`towbar/${name}`), name);
  assert(
    !archive.some(
      (name) =>
        name.includes("untracked") || name.includes("release-artifacts"),
    ),
  );
  git("add", "install.sh");
  git(
    "-c",
    "user.name=Release Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "new head",
  );
  assert.throws(assemble);
});

test("a rehearsal assembles an untagged HEAD only from a local registry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "towbar-rehearsal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root });
  git("init", "--quiet");
  const files = {
    "package.json": JSON.stringify({ version: "2.0.31" }),
    "install.sh": "#!/bin/bash\necho installer\n",
    "infra/towbar": "#!/bin/bash\necho cli\n",
    "docker-compose.yml": "services: {}\n",
    "infra/runtime_config.py": "# runtime configuration fixture\n",
    ...Object.fromEntries(
      ["repository", "app", "compose", "resource"].map((name) => [
        `packages/towbar-core/schemas/${name}.v2.json`,
        JSON.stringify({ title: name }),
      ]),
    ),
  };
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), body);
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Release Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "untagged rehearsal fixture",
  );
  const commit = git("rev-parse", "HEAD").toString().trim();
  const manifest = async (registry) => {
    const file = join(root, `images-${registry.replaceAll(/[/:]/g, "-")}.json`);
    await writeFile(
      file,
      JSON.stringify({
        version: "v2.0.31",
        commit,
        images: Object.fromEntries(
          ["api", "worker", "web-app"].map((service) => [
            service,
            `${registry}/towbar-${service}@sha256:${"c".repeat(64)}`,
          ]),
        ),
      }),
    );
    return file;
  };
  const local = await manifest("localhost:5000");
  const published = await manifest(identity.imageRegistry);
  const assembler = fileURLToPath(new URL("./assemble.mjs", import.meta.url));
  const assemble = (images, rehearsal, version = "v2.0.31", at = commit) =>
    execFileSync(
      process.execPath,
      [assembler, join(root, "out"), version, at, images],
      {
        cwd: root,
        stdio: "pipe",
        env: {
          ...process.env,
          TOWBAR_REHEARSAL_REGISTRY: rehearsal ?? "",
        },
      },
    );
  assemble(local, "localhost:5000");
  const release = validateRelease(
    JSON.parse(await readFile(join(root, "out", "release.json"), "utf8")),
  );
  assert.equal(release.commit, commit);
  // Outside a rehearsal the missing tag still fails, and a rehearsal relaxes
  // nothing else: published-registry images, a non-local registry, another
  // commit and another version are all refused.
  assert.throws(
    () => assemble(published),
    /Release tag must match|v2\.0\.31\^\{commit\}/,
  );
  assert.throws(
    () => assemble(published, "localhost:5000"),
    /Invalid immutable/,
  );
  assert.throws(
    () => assemble(local, identity.imageRegistry),
    /local registry/,
  );
  assert.throws(
    () => assemble(local, "localhost:5000", "v2.0.31", "f".repeat(40)),
    /checked-out HEAD/,
  );
  assert.throws(
    () => assemble(local, "localhost:5000", "v2.0.32"),
    /version|match/i,
  );
});
