import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const identity = JSON.parse(
  await readFile(new URL("repository.json", root), "utf8"),
);
const previous = identity.previousRepositories;
if (
  !Array.isArray(previous) ||
  previous.some(
    (name) =>
      !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name) || name === identity.repository,
  ) ||
  new Set(previous).size !== previous.length
)
  throw new Error(
    "previousRepositories must list distinct obsolete repository names",
  );
const previousRegistries = identity.previousImageRegistries;
if (
  !Array.isArray(previousRegistries) ||
  previousRegistries.some(
    (name) =>
      !/^ghcr\.io\/[a-z0-9-]+$/.test(name) || name === identity.imageRegistry,
  ) ||
  new Set(previousRegistries).size !== previousRegistries.length
)
  throw new Error(
    "previousImageRegistries must list distinct obsolete image registries",
  );
const committed = JSON.parse(
  execFileSync("git", ["show", "HEAD:repository.json"], {
    cwd: root,
  }).toString(),
);
if (
  committed.repository !== identity.repository &&
  !previous.includes(committed.repository)
)
  throw new Error(
    "Record the previous repository name before changing repository identity",
  );
if (
  committed.imageRegistry !== identity.imageRegistry &&
  !previousRegistries.includes(committed.imageRegistry)
)
  throw new Error(
    "Record the previous image registry before changing image ownership",
  );
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString()
  .split("\0")
  .filter(Boolean);
const generated = new Set([
  "packages/towbar-contracts/src/repository-identity.ts",
  "infra/towbar-cli/00-version.sh",
  "infra/towbar",
  "install.sh",
]);
const failures = [];
for (const path of files.filter(
  (path) =>
    (/\.(md|mdx|json|js|ts|tsx|py|sh|mjs|yml|yaml|toml|go|example)$/.test(
      path,
    ) ||
      path.endsWith("Dockerfile")) &&
    path !== "repository.json" &&
    !generated.has(path) &&
    !/(\.test\.|\/test[-_])/.test(path),
)) {
  let source;
  try {
    source = await readFile(new URL(path, root), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const match of source.matchAll(
    /(?:github\.com|raw\.githubusercontent\.com|api\.github\.com\/repos)\/([a-z0-9-]+\/[a-z0-9_.-]+)(?=[/."'`#?\s]|$)/gi,
  ))
    if (previous.includes(match[1].toLowerCase().replace(/\.git$/, "")))
      failures.push(
        `${path} refers to obsolete repository ${match[1]}; update the reference explicitly`,
      );
  for (const registry of previousRegistries)
    if (source.includes(`${registry}/towbar-`))
      failures.push(
        `${path} refers to obsolete image registry ${registry}; update image ownership explicitly`,
      );
  if (
    /\.(ts|tsx|py|sh|mjs)$/.test(path) &&
    !/(\.test\.|\/test[-_]|[-/]fixture)/.test(path) &&
    source.includes(identity.repository)
  )
    failures.push(
      `${path} hardcodes the repository; use repository.json or generated constants`,
    );
}
if (failures.length) throw new Error(failures.join("\n"));
console.log("Repository references are current.");
