import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const platforms = ["amd64", "arm64"];
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export function platformImageInputs(records, service, image) {
  if (
    records.length !== platforms.length ||
    new Set(records.map((record) => record.platform)).size !==
      platforms.length ||
    records.some(
      (record) =>
        record.service !== service ||
        !platforms.includes(record.platform) ||
        typeof record.image !== "string" ||
        !record.image.startsWith(`${image}@`) ||
        !digestPattern.test(record.image.slice(image.length + 1)),
    )
  )
    throw new Error("Expected one immutable image for each release platform");
  return platforms.map(
    (platform) => records.find((record) => record.platform === platform).image,
  );
}

export function platformIndexDigest(index) {
  const linux = index.manifests?.filter(
    (manifest) => manifest.platform?.os === "linux",
  );
  if (
    !digestPattern.test(index.digest) ||
    !linux ||
    linux.length !== platforms.length ||
    platforms.some(
      (platform) =>
        linux.filter((manifest) => manifest.platform.architecture === platform)
          .length !== 1,
    )
  )
    throw new Error("Published image must include both release platforms");
  return index.digest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, path, service, image] = process.argv.slice(2);
  if (command === "inputs") {
    const files = (await readdir(path)).filter((name) =>
      name.endsWith(".json"),
    );
    const records = await Promise.all(
      files.map(async (file) =>
        JSON.parse(await readFile(join(path, file), "utf8")),
      ),
    );
    console.log(platformImageInputs(records, service, image).join("\n"));
  } else if (command === "digest") {
    console.log(platformIndexDigest(JSON.parse(await readFile(path, "utf8"))));
  } else {
    throw new Error("Use inputs DIRECTORY SERVICE IMAGE or digest INDEX_FILE");
  }
}
