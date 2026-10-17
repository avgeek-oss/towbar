import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import {
  parseRepositoryManifest,
  resolveRepositoryEnvironment,
} from "../packages/towbar-core/dist/manifest-v2.js";
import {
  assertRenderedComposeImage,
  validateComposeRepository,
} from "../packages/towbar-deployer/dist/compose-security.js";
import { ossComposeRecipes } from "./oss-compose-recipes.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(file)));
    else if (/\.mdx?$/.test(entry.name)) files.push(file);
  }
  return files.sort();
}

let roots = 0;
let workloads = 0;
let fragments = 0;
let composeProjects = 0;
const failures = [];
for (const file of await collect(path.join(repository, "docs/docs"))) {
  const source = await readFile(file, "utf8");
  const blocks = [];
  for (const match of source.matchAll(/```ya?ml[^\n]*\n([\s\S]*?)```/g)) {
    const location = `${path.relative(repository, file)}:${source.slice(0, match.index).split("\n").length}`;
    try {
      blocks.push({ content: match[1], config: parse(match[1]), location });
    } catch (error) {
      failures.push(`${location}: ${error.message}`);
    }
  }
  const pageRoot = blocks.find(
    ({ config }) => config?.version === 2 && config.environments,
  );
  for (const { content, config, location } of blocks) {
    if (!config || typeof config !== "object") continue;
    try {
      if (config.version === 2 && config.environments) {
        parseRepositoryManifest(content);
        roots++;
        continue;
      }
      if (
        !config.id ||
        !config.environments ||
        !(config.deployment || config.type || config.file)
      ) {
        fragments++;
        continue;
      }
      const suffix = config.file
        ? "compose"
        : config.type
          ? "datastore"
          : "service";
      const directory = suffix === "datastore" ? "datastores" : "services";
      const environments = Object.keys(config.environments);
      const root =
        pageRoot?.content ??
        stringify({
          version: 2,
          environments: Object.fromEntries(
            environments.map((name) => [name, {}]),
          ),
        });
      for (const environment of environments) {
        resolveRepositoryEnvironment({
          root,
          files: [
            {
              path: `.towbar/${directory}/${config.id}.${suffix}.yml`,
              content,
            },
          ],
          environment,
          branch: "main",
        });
      }
      workloads++;
    } catch (error) {
      failures.push(`${location}: ${error.message}`);
    }
  }
}

for (const [id, recipe] of Object.entries(ossComposeRecipes)) {
  const checkout = await mkdtemp(path.join(tmpdir(), "towbar-docs-compose-"));
  try {
    const composeFiles = [];
    for (const [name, config] of recipe.files) {
      const file = path.resolve(checkout, name);
      assert.ok(
        file.startsWith(`${checkout}${path.sep}`),
        `${id}: unsafe path`,
      );
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, stringify(config));
      if (!config.services) continue;
      composeFiles.push(name);
      assert.ok(
        config.services[recipe.routedService],
        `${id}: routed Compose service is missing`,
      );
      for (const [service, value] of Object.entries(config.services)) {
        assertRenderedComposeImage(value.image, service);
      }
    }
    assert.ok(composeFiles.length, `${id}: no Compose file`);
    await validateComposeRepository(checkout, composeFiles);
    composeProjects++;
  } catch (error) {
    failures.push(`OSS Compose recipe ${id}: ${error.message}`);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Documentation examples: ${roots} repository manifests, ${workloads} complete workloads, and ${composeProjects} OSS Compose projects validated; ${fragments} YAML fragments parsed only.`,
  );
}
