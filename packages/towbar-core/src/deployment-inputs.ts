import { minimatch } from "minimatch";

import { digestValue } from "./manifest-values.js";

import type { NormalizedDeployable, NormalizedServer } from "./manifest.js";

import type { RepositoryTree } from "@workspace/towbar-contracts/repository-tree";
export type {
  RepositoryTree,
  RepositoryTreeEntry,
} from "@workspace/towbar-contracts/repository-tree";

export type RepositoryChangedPaths = {
  complete: boolean;
  paths: string[];
};

export function shouldDeployForChangedPaths(input: {
  changedPaths: RepositoryChangedPaths;
  deploymentInputs: string[];
}) {
  if (input.deploymentInputs.length === 0 || !input.changedPaths.complete) {
    return true;
  }
  return input.changedPaths.paths.some((path) =>
    matchesDeploymentInput(path, input.deploymentInputs),
  );
}

export function getMatchingChangedPaths(input: {
  changedPaths: RepositoryChangedPaths;
  deploymentInputs: string[];
}) {
  if (!input.changedPaths.complete || input.deploymentInputs.length === 0) {
    return [];
  }
  return [...new Set(input.changedPaths.paths)]
    .filter((path) => matchesDeploymentInput(path, input.deploymentInputs))
    .sort((left, right) => left.localeCompare(right));
}

export function selectDeploymentInputEntries(
  inputs: string[],
  tree: RepositoryTree,
) {
  if (!tree.complete) return [];
  return tree.entries
    .filter((entry) => matchesDeploymentInput(entry.path, inputs))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function matchesDeploymentInput(path: string, inputs: string[]) {
  return inputs.some((input) =>
    minimatch(path, input, {
      dot: true,
      nocomment: true,
      nonegate: true,
      nocase: false,
    }),
  );
}

export function getSourceInputDigest(input: {
  commitSha: string;
  deploymentInputs: string[];
  tree?: RepositoryTree;
}) {
  if (input.deploymentInputs.length === 0 || !input.tree?.complete) {
    return {
      digest: digestValue({ commitSha: input.commitSha, mode: "commit" }),
      fallback: true,
      matchedPaths: [] as string[],
    };
  }
  const selected = selectDeploymentInputEntries(
    input.deploymentInputs,
    input.tree,
  );
  return {
    digest: digestValue({
      entries: selected.map(({ mode, path, sha, type }) => ({
        mode,
        path,
        sha,
        type,
      })),
      mode: "paths",
    }),
    fallback: false,
    matchedPaths: selected.map((entry) => entry.path),
  };
}

export function getDeployableDeploymentDigest(input: {
  deployable: NormalizedDeployable;
  server: NormalizedServer;
  sourceInputDigest: string | null;
}) {
  const server = { ...input.server } as Record<string, unknown>;
  delete server.buildConcurrency;
  delete server.previewBuildConcurrency;
  delete server.hostLogCollection;
  return digestValue({
    runtimeConfig: getDeploymentRuntimeConfig(input.deployable),
    server,
    sourceInputDigest: input.sourceInputDigest,
  });
}

export function digestWithoutNotificationSubscriptions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return digestValue(value);
  const config = { ...value };
  Reflect.deleteProperty(config, "notifications");
  return digestValue(config);
}

function getDeploymentRuntimeConfig(deployable: NormalizedDeployable) {
  const value = { ...deployable } as Record<string, unknown>;
  delete value.autoDeploy;
  // Ignore the scheduling field retained by deployments admitted before
  // dependency support was removed from the manifest contract.
  delete value.dependsOn;
  delete value.description;
  delete value.iconUrl;
  delete value.deploymentInputs;
  delete value.deploymentInputScope;
  delete value.name;
  delete value.notifications;
  delete value.preview;
  delete value.sourceBranch;
  delete value.vulnerabilityScanning;
  return value;
}
