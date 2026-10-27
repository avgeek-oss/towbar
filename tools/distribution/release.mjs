import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const identity = JSON.parse(
  await readFile(new URL("../../repository.json", import.meta.url), "utf8"),
);
export const artifactNames = [
  "install.sh",
  "towbar",
  "source.tar.gz",
  "towbar-images.json",
  ...["repository", "app", "compose", "resource"].map(
    (name) => `${name}.v2.json`,
  ),
];
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export function validateRelease(release) {
  if (
    release.schemaVersion !== 1 ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version) ||
    !release.version
      .slice(1)
      .split(".")
      .map(Number)
      .every(Number.isSafeInteger) ||
    !/^[a-f0-9]{40}$/.test(release.commit) ||
    !Number.isFinite(Date.parse(release.createdAt))
  )
    throw new Error("Invalid release identity");
  if (
    JSON.stringify(Object.keys(release.artifacts ?? {}).sort()) !==
      JSON.stringify([...artifactNames, "SHA256SUMS"].sort()) ||
    Object.values(release.artifacts).some(
      (hash) => !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error("Invalid release checksums");
  return release;
}
// registry defaults to the published image registry; release rehearsals pass
// their throwaway local registry.
export function validateImages(
  images,
  release,
  registry = identity.imageRegistry,
) {
  if (
    images.version !== release.version ||
    images.commit !== release.commit ||
    JSON.stringify(Object.keys(images.images ?? {}).sort()) !==
      JSON.stringify(["api", "web-app", "worker"])
  )
    throw new Error("Image manifest does not match the release");
  for (const [service, image] of Object.entries(images.images)) {
    const prefix = `${registry}/towbar-${service}@sha256:`;
    if (
      !image.startsWith(prefix) ||
      !/^[a-f0-9]{64}$/.test(image.slice(prefix.length))
    )
      throw new Error(`Invalid immutable ${service} image`);
  }
}
export async function verifyPublicRelease(release, fetcher = fetch) {
  validateRelease(release);
  const base = `https://github.com/${identity.repository}/releases/download/${release.version}/`;
  const response = await fetcher(base + "release.json", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Public release metadata is unavailable");
  const published = validateRelease(await response.json());
  if (
    published.validated !== true ||
    published.version !== release.version ||
    published.commit !== release.commit ||
    JSON.stringify(published.artifacts) !== JSON.stringify(release.artifacts)
  )
    throw new Error(
      "Public release metadata differs from the verified release",
    );
  for (const [name, hash] of Object.entries(release.artifacts)) {
    const response = await fetcher(base + name, {
      signal: AbortSignal.timeout(120_000),
    });
    if (
      !response.ok ||
      sha256(Buffer.from(await response.arrayBuffer())) !== hash
    )
      throw new Error(`Public artifact failed verification: ${name}`);
  }
}
