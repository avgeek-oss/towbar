import path from "node:path";
import { trivyFallbackDbRepository, trivyScanner } from "./trivy-db.mjs";

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
  // Runs one scanner container; on interruption only that run-owned
  // container is removed.
  async function scanner(name, suffix, mounts, trivyArgs) {
    const container = `towbar-image-scan-${run.id}-${suffix}`;
    try {
      await run.step(name, "docker", [
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
        ...mounts,
        "--volume",
        `${cache}:/root/.cache/trivy`,
        trivyScanner,
        "image",
        "--cache-dir",
        "/root/.cache/trivy",
        ...trivyArgs,
      ]);
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
      if (remaining) await run.capture("docker", ["rm", "--force", container]);
    }
  }
  try {
    // The database is fetched once; the scans then read it without updating.
    let database = false;
    for (const [name, repository] of [
      ["image-security-db", []],
      [
        "image-security-db-ghcr",
        ["--db-repository", trivyFallbackDbRepository],
      ],
    ]) {
      try {
        await scanner(name, "db", [], ["--download-db-only", ...repository]);
        database = true;
        break;
      } catch (error) {
        failures.push(error);
      }
    }
    if (database) {
      failures.length = 0;
      for (const [service, tag] of Object.entries(images)) {
        try {
          await scanner(
            `image-security-${service}`,
            service,
            [
              "--volume",
              "/var/run/docker.sock:/var/run/docker.sock:ro",
              "--volume",
              `${run.directory}:/scan`,
            ],
            [
              "--skip-db-update",
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
            ],
          );
        } catch (error) {
          failures.push(error);
        }
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
