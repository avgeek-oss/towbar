import path from "node:path";

const scanner =
  "aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969";

// cacheDirectory: an absolute host directory that keeps the scanner database
// between runs (CI restores it with actions/cache). Without it the database
// lives in a disposable volume that is removed after the scans.
export async function verifyProductionImages(
  run,
  images,
  { cacheDirectory } = {},
) {
  const failures = [];
  const cacheVolume = `towbar-image-scan-cache-${run.id}`;
  const cache = cacheDirectory ?? cacheVolume;
  try {
    for (const [service, tag] of Object.entries(images)) {
      const container = `towbar-image-scan-${run.id}-${service}`;
      try {
        await run.step(`image-security-${service}`, "docker", [
          "run",
          "--rm",
          "--name",
          container,
          "--label",
          `com.towbar.verification.run=${run.id}`,
          "--cpus",
          "2",
          "--memory",
          "2g",
          "--volume",
          "/var/run/docker.sock:/var/run/docker.sock:ro",
          "--volume",
          `${run.directory}:/scan`,
          "--volume",
          `${cache}:/root/.cache/trivy`,
          scanner,
          "image",
          "--cache-dir",
          "/root/.cache/trivy",
          "--scanners",
          "vuln",
          "--severity",
          "HIGH,CRITICAL",
          "--exit-code",
          "1",
          "--format",
          "json",
          "--output",
          `/scan/image-security-${service}.json`,
          tag,
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        const remaining = await run.capture("docker", [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `name=^/${container}$`,
          "--filter",
          `label=com.towbar.verification.run=${run.id}`,
        ]);
        if (remaining)
          await run.capture("docker", ["rm", "--force", container]);
      }
    }
  } finally {
    const cacheExists =
      !cacheDirectory &&
      (await run.capture("docker", [
        "volume",
        "ls",
        "--quiet",
        "--filter",
        `name=^${cacheVolume}$`,
      ]));
    if (cacheExists) await run.capture("docker", ["volume", "rm", cacheVolume]);
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `Production image security gate failed. Review HIGH/CRITICAL findings or scanner errors in ${path.join(run.directory, "image-security-*.json")}`,
    );
}
