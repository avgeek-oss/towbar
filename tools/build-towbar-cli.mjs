import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const sourceDirectory = path.join(repository, "infra/towbar-cli");
const { version } = JSON.parse(
  await readFile(path.join(repository, "package.json"), "utf8"),
);
if (
  typeof version !== "string" ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
  throw new Error("package.json must declare a stable release version");
}
const identity = JSON.parse(
  await readFile(path.join(repository, "repository.json"), "utf8"),
);
if (
  !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(identity.repository) ||
  !/^ghcr\.io\/[a-z0-9-]+$/.test(identity.imageRegistry)
)
  throw new Error("Invalid repository.json identity");
const versionContent = `#!/usr/bin/env bash
# Generated from package.json and repository.json; run pnpm cli:build.
set -Eeuo pipefail

CLI_VERSION="${version}"
CLI_RELEASE="v$CLI_VERSION"
TOWBAR_UPSTREAM_REPOSITORY="${identity.repository}"
TOWBAR_RELEASES_URL="https://github.com/${identity.repository}/releases"
TOWBAR_RELEASES_API_URL="https://api.github.com/repos/${identity.repository}/releases"
TOWBAR_IMAGE_REGISTRY="${identity.imageRegistry}"
`;
const fragments = [
  "00-runtime.sh",
  "10-onboarding.sh",
  "15-config.sh",
  "20-host.sh",
  "30-release.sh",
  "40-lifecycle.sh",
  "50-doctor.sh",
  "60-commands.sh",
];
const content = `${versionContent.trimEnd()}\n\n${(
  await Promise.all(
    fragments.map(async (fragment) =>
      (await readFile(path.join(sourceDirectory, fragment), "utf8")).trimEnd(),
    ),
  )
).join("\n\n")}\n`;
const installerTemplate = await readFile(
  path.join(repository, "infra/install.sh.in"),
  "utf8",
);
if (installerTemplate.split("@TOWBAR_VERSION@").length !== 2) {
  throw new Error(
    "infra/install.sh.in must contain one release version marker",
  );
}
const installer = installerTemplate
  .replace(
    "#!/usr/bin/env bash\n",
    "#!/usr/bin/env bash\n# Generated from infra/install.sh.in and package.json; run pnpm cli:build.\n",
  )
  .replace("@TOWBAR_VERSION@", version)
  .replaceAll("@TOWBAR_REPOSITORY@", identity.repository);
const outputs = [
  ["infra/towbar-cli/00-version.sh", versionContent],
  ["infra/towbar", content],
  ["install.sh", installer],
];

for (const [relativePath, expected] of outputs) {
  const target = path.join(repository, relativePath);
  if (process.argv.includes("--check")) {
    const generated = await readFile(target, "utf8");
    if (generated !== expected) {
      console.error(`${relativePath} is stale; run pnpm cli:build`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(target, expected);
    await chmod(target, 0o755);
  }
}
