import type { Source } from "@workspace/towbar-web-client";

export function repositoryFileLink(
  source: Pick<
    Source,
    "provider" | "repositoryUrl" | "repositoryOwner" | "repositoryName"
  >,
  revision: string,
  filePath: string,
) {
  const repositoryPath = [source.repositoryOwner, source.repositoryName]
    .flatMap((part) => part.split("/"))
    .map(encodeURIComponent)
    .join("/");
  const base = (source.repositoryUrl ?? `https://github.com/${repositoryPath}`)
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  const path = filePath.split("/").map(encodeURIComponent).join("/");
  return {
    href: `${base}/blob/${encodeURIComponent(revision)}/${path}`,
    label: "Open in GitHub",
  };
}
