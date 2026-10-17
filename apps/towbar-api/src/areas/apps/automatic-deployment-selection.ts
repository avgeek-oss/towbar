import type { DeployableKind } from "@workspace/towbar-core";

type AutomaticDeploymentCandidate = {
  manifestState?: string;
  archivedAt: Date | null;
  config: { autoDeploy?: boolean };
  deploymentDigest: string | null;
  manifestId: string;
  kind: DeployableKind;
  serverReady: boolean;
  sourceRevision: string | null;
};

export type AutomaticDeploymentReleaseState = {
  currentDeploymentDigest: string | null;
  manifestId: string;
};

export function selectAutomaticDeploymentCandidates<
  Candidate extends AutomaticDeploymentCandidate,
>(input: {
  candidates: Candidate[];
  commitSha: string;
  releases: AutomaticDeploymentReleaseState[];
}) {
  const currentReleaseByApp = new Map(
    input.releases.map((release) => [release.manifestId, release]),
  );
  return input.candidates.filter(
    (candidate) =>
      Boolean(candidate.config.autoDeploy) &&
      Boolean(candidate.deploymentDigest) &&
      candidate.serverReady &&
      !candidate.archivedAt &&
      (!candidate.manifestState || candidate.manifestState === "active") &&
      candidate.sourceRevision === input.commitSha &&
      !isCandidateCurrent(
        candidate,
        currentReleaseByApp.get(candidate.manifestId),
      ),
  );
}

function isCandidateCurrent(
  candidate: AutomaticDeploymentCandidate,
  release: AutomaticDeploymentReleaseState | undefined,
) {
  return Boolean(
    release &&
    candidate.deploymentDigest &&
    release.currentDeploymentDigest === candidate.deploymentDigest,
  );
}
