// Decide whether the exact release commit passed the `verify` check.
//
// Same rules as Mill's release-check: only `verify` check runs for the exact
// commit from GitHub Actions count, any run still queued or in progress means
// wait, and the newest run must have succeeded. A completed failure is final.
//
// Usage: node tools/distribution/verified-commit.mjs --commit SHA --checks FILE
// FILE holds `gh api .../check-runs --paginate --slurp` output.
// Exit codes: 0 verified, 75 pending (retry later), 1 failed.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PENDING = 75;

export function verifyState(pages, commit) {
  const checks = pages
    .flatMap((page) => page.check_runs ?? [])
    .filter(
      (check) =>
        check.name === "verify" &&
        check.head_sha === commit &&
        check.app?.slug === "github-actions",
    );
  if (!checks.length)
    return { state: "pending", message: `No verify result yet for ${commit}` };
  if (checks.some((check) => check.status !== "completed"))
    return {
      state: "pending",
      message: `verify is still queued or running for ${commit}`,
    };
  const latest = checks.toSorted((left, right) => {
    const a = left.started_at ?? left.created_at ?? left.completed_at ?? "";
    const b = right.started_at ?? right.created_at ?? right.completed_at ?? "";
    return a.localeCompare(b) || left.id - right.id;
  })[checks.length - 1];
  return latest.conclusion === "success"
    ? { state: "success", message: `Latest verify succeeded for ${commit}` }
    : {
        state: "failure",
        message: `The latest verify run for ${commit} is '${latest.conclusion}'; an older success is not enough`,
      };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2)
    args.set(process.argv[index], process.argv[index + 1]);
  const commit = args.get("--commit");
  const file = args.get("--checks");
  if (!commit || !/^[a-f0-9]{40}$/.test(commit) || !file) {
    console.error("Usage: verified-commit.mjs --commit SHA --checks FILE");
    process.exit(1);
  }
  const result = verifyState(JSON.parse(await readFile(file, "utf8")), commit);
  console.log(result.message);
  process.exit(
    result.state === "success" ? 0 : result.state === "pending" ? PENDING : 1,
  );
}
