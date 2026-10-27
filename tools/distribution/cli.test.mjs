import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, sha256 } from "./release.mjs";

const repository = new URL("../../", import.meta.url).pathname;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "towbar-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "remote"));
  await mkdir(join(root, "bin"));
  const commit = "a".repeat(40),
    version = "v2.0.30";
  const archive = Buffer.from("a damaged archive that must never be extracted");
  const images = Buffer.from(JSON.stringify({ version, commit, images: {} }));
  await writeFile(join(root, "remote/source.tar.gz"), archive);
  await writeFile(join(root, "remote/towbar-images.json"), images);
  await writeFile(
    join(root, "remote/release.json"),
    JSON.stringify({
      schemaVersion: 1,
      version,
      commit,
      validated: true,
      artifacts: {
        "source.tar.gz": sha256("valid archive"),
        "towbar-images.json": sha256(images),
      },
    }),
  );
  await writeFile(
    join(root, "bin/curl"),
    `#!/usr/bin/env bash\nset -euo pipefail\noutput=""; url=""\nwhile (($#)); do\n case "$1" in --output) output="$2"; shift;; https://*) url="$1";; esac\n shift\ndone\nif [[ -n "$output" ]]; then cp "$REMOTE/\${url##*/}" "$output"; else cat "$REMOTE/\${url##*/}"; fi\n`,
    { mode: 0o755 },
  );
  if (process.platform === "darwin") {
    await writeFile(
      join(root, "bin/sha256sum"),
      '#!/bin/bash\nexec /usr/bin/shasum -a 256 "$@"\n',
      { mode: 0o755 },
    );
  }
  const run = (command = `download_release v2.0.30 ${commit}`, env = {}) =>
    spawnSync(
      "bash",
      [
        "-c",
        `source "$REPOSITORY/infra/towbar-cli/00-version.sh"; source "$REPOSITORY/infra/towbar-cli/00-runtime.sh"; source "$REPOSITORY/infra/towbar-cli/20-host.sh"; source "$REPOSITORY/infra/towbar-cli/30-release.sh"; ${command}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          REPOSITORY: repository,
          REMOTE: join(root, "remote"),
          TOWBAR_ROOT: join(root, "installation"),
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          ...env,
        },
      },
    );
  await writeFile(
    join(root, "remote/v2.0.30"),
    JSON.stringify({ tag_name: version, draft: false, prerelease: false }),
  );
  await writeFile(
    join(root, "remote/latest"),
    JSON.stringify({ tag_name: version, draft: false, prerelease: false }),
  );
  return { root, run, version, commit };
}
test("CLI rejects a corrupted source archive before extraction or activation", async (t) => {
  const { root, run } = await fixture(t);
  const result = run();
  assert.notEqual(result.status, 0, JSON.stringify(result));
  assert.match(result.stderr, /source.tar.gz checksum verification failed/);
  await assert.rejects(
    readFile(join(root, "installation/releases/v2.0.30/.towbar-release")),
  );
});
test("CLI resolves GitHub latest and rejects draft, prerelease, or unvalidated releases", async (t) => {
  const { root, run, version } = await fixture(t);
  assert.equal(run("resolve_latest_version").stdout.trim(), version);
  assert.equal(run(`verify_release ${version}`).status, 0);
  for (const changes of [
    { draft: true },
    { prerelease: true },
    { tag_name: "v2.0.31" },
  ]) {
    await writeFile(
      join(root, "remote", version),
      JSON.stringify({
        tag_name: version,
        draft: false,
        prerelease: false,
        ...changes,
      }),
    );
    assert.notEqual(run(`verify_release ${version}`).status, 0);
  }
  await writeFile(
    join(root, "remote", version),
    JSON.stringify({ tag_name: version, draft: false, prerelease: false }),
  );
  const manifest = JSON.parse(
    await readFile(join(root, "remote/release.json"), "utf8"),
  );
  await writeFile(
    join(root, "remote/release.json"),
    JSON.stringify({ ...manifest, validated: false }),
  );
  assert.notEqual(run(`verify_release ${version}`).status, 0);
  assert.notEqual(
    run(`verify_release ${version}`, { TOWBAR_RELEASE_SMOKE: "true" }).status,
    0,
  );
  assert.equal(
    run(`verify_release ${version}`, {
      TOWBAR_RELEASE_SMOKE: "true",
      TOWBAR_RELEASE_DIRECTORY: join(root, "remote"),
    }).status,
    0,
  );
});

test("CLI downloads a complete release from GitHub and pins all three images", async (t) => {
  const { root, run, version, commit } = await fixture(t);
  const source = join(root, "source/towbar");
  await mkdir(join(source, "infra"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ version: version.slice(1) }),
  );
  await writeFile(join(source, "docker-compose.yml"), "services: {}\n");
  await writeFile(join(source, "infra/runtime_config.py"), "# fixture\n");
  await writeFile(join(source, "infra/towbar"), "#!/bin/bash\n");
  execFileSync("tar", [
    "-czf",
    join(root, "remote/source.tar.gz"),
    "-C",
    join(root, "source"),
    "towbar",
  ]);
  const images = Object.fromEntries(
    ["api", "worker", "web-app"].map((service) => [
      service,
      `${identity.imageRegistry}/towbar-${service}@sha256:${"b".repeat(64)}`,
    ]),
  );
  await writeFile(
    join(root, "remote/towbar-images.json"),
    JSON.stringify({ version, commit, images }),
  );
  const manifest = JSON.parse(
    await readFile(join(root, "remote/release.json"), "utf8"),
  );
  for (const name of ["source.tar.gz", "towbar-images.json"])
    manifest.artifacts[name] = sha256(
      await readFile(join(root, "remote", name)),
    );
  await writeFile(join(root, "remote/release.json"), JSON.stringify(manifest));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const metadata = await readFile(
    join(root, "installation/releases", version, ".towbar-release"),
    "utf8",
  );
  assert.match(metadata, new RegExp(`COMMIT=${commit}`));
  for (const image of Object.values(images)) assert(metadata.includes(image));
});

test("release workflow only promotes after the candidate installation job succeeds", async () => {
  const text = await readFile(
    new URL("../../.github/workflows/release-images.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    text,
    /local-installation-smoke:\n\s+needs: \[prepare, manifest\][\s\S]+Install the candidate release locally[\s\S]+- name: Publish the verified GitHub release\n\s+env:/,
  );
  assert.match(text, /gh release download/);
  assert.match(text, /sha256sum --check SHA256SUMS/);
  assert.match(text, /gh release edit "\$RELEASE_TAG" --draft=false --latest/);
  assert.doesNotMatch(
    text,
    /id-token: write|CLOUDFLARE|publish\.mjs|check-scope/,
  );
  assert.match(text, /TOWBAR_RELEASE_SMOKE=true/);
});

test("repository transfer guard fails for the upstream ID and permits forks", () => {
  const run = (id, name) =>
    spawnSync(
      process.execPath,
      ["tools/sync-repository-identity.mjs", "--check"],
      {
        cwd: repository,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REPOSITORY_ID: String(id),
          GITHUB_REPOSITORY: name,
        },
      },
    );
  const wrongUpstream = run(identity.repositoryId, "renamed-owner/towbar");
  assert.notEqual(wrongUpstream.status, 0);
  assert.match(wrongUpstream.stderr, /renamed or transferred/);
  assert.equal(run(identity.repositoryId + 1, "contributor/towbar").status, 0);
});
