import { domainHandoffRoutingMessage } from "./domain-routing.js";
import { type CloudflareDnsChange } from "./cloudflare.js";
import { localDomainHandoffs } from "./domain-routing.js";
import { prepareConfigurationFiles } from "./configuration-files.js";
import {
  containerRuntimeOptionsPath,
  prepareContainerRuntimeOptions,
} from "./container-runtime.js";
import { deploymentVolumeArguments, prepareAppStorage } from "./app-storage.js";
import { validateHostLogCollection } from "./host-log-collection.js";
import { chmod, mkdir, stat, statfs, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
/* eslint-disable max-lines -- Deployment phases share stateful rollback invariants that must remain visible in one module. */
import { createHash } from "node:crypto";
import path from "node:path";

import {
  createBuildContextArchive,
  createSourceContextArchive,
} from "./build-context.js";
import { parseCandidatePort } from "./candidate-port.js";
import { rollingMemoryHeadroomScript } from "./rolling-headroom.js";
import {
  deploymentCleanupId,
  deploymentRuntimeId,
} from "./deployment-identity.js";
import {
  type CloudflareDnsExpectations,
  type CloudflareDnsTransition,
  type CloudflareTunnelTransition,
  cleanupCloudflareDnsTransition,
  cleanupCloudflareTunnelTransition,
  deploymentPublicHostnames,
  reconcileCloudflareForDeployment,
  reconcileCloudflareTunnelForDeployment,
} from "./cloudflare.js";
import { checkOriginEndpoint, checkPublicEndpoint } from "./endpoint-health.js";
import { runWithSafeLogs, safeLog, transition } from "./executor-hooks.js";
import {
  buildRemoteScript,
  builderBuildRemoteScript,
  configureCaddyScript,
  containerHealthRemoteScript,
  ensureNetworkRemoteScript,
  finalizeRemoteScript,
  healthRemoteScript,
  hookRemoteScript,
  prepareRemoteScript,
  pullApplicationImageRemoteScript,
  scheduleFinalizeRemoteScript,
  startRemoteScript,
  startResourceRemoteScript,
  staticBuildRemoteScript,
} from "./remote-scripts.js";
import { renderCaddyFragment } from "./routing.js";
import { ensureCloudflareCaddyModule } from "./caddy-preparation.js";
import { pullResourceImage } from "./pull-resource-image.js";
import {
  MAX_SOURCE_ARCHIVE_ENTRIES,
  MAX_SOURCE_EXPANDED_BYTES,
  fetchDeploymentSource,
} from "./source-fetch.js";
import {
  aggregateBuildSecretKey,
  validateDeploymentSecrets,
} from "./secrets.js";
import { type SshSession, sshConnectionHost } from "./ssh.js";
import type {
  DeploymentExecutionContext,
  DeploymentSecrets,
  ExecutorHooks,
} from "./types.js";
import {
  collectsHostDockerLogs,
  deploymentCloudflareDnsDomains,
  deploymentTunnelHostnames,
  isNormalizedCompose,
  isNormalizedResource,
} from "@workspace/towbar-core";
import type {
  NormalizedApp,
  NormalizedDeploymentHook,
} from "@workspace/towbar-core";

type DeploymentPhaseInput = {
  onDnsChange?: (change: CloudflareDnsChange) => Promise<void>;
  cloudflareDnsExpectations?: CloudflareDnsExpectations;
  cloudflareDnsTransitions?: CloudflareDnsTransition[];
  containerName: string;
  context: DeploymentExecutionContext;
  hooks: ExecutorHooks;
  imageTag: string;
  localDirectory: string;
  remoteDirectory: string;
  secrets: DeploymentSecrets;
  sensitiveValues: string[];
  session: SshSession;
  buildSession?: SshSession;
  cloudflareTunnelTransition?: CloudflareTunnelTransition;
  targetArchitecture?: "amd64" | "arm64";
  signal?: AbortSignal;
};

const maxBuildArtifactBytes = 20 * 1_024 * 1_024 * 1_024;
const buildArtifactCapacityMargin = 256 * 1_024 * 1_024;

export async function prepareDeploymentImage(input: DeploymentPhaseInput) {
  validateHostLogCollection(input.context);
  const requiresCloudflareDns =
    input.context.app.tls?.mode === "cloudflare-dns";
  await transition(
    input.hooks,
    "checking_server",
    "SSH trust and target access verified",
  );
  if (requiresCloudflareDns) {
    await transition(
      input.hooks,
      "checking_server",
      "Preparing Cloudflare DNS support",
    );
    await ensureCloudflareCaddyModule(input.session, input.signal);
  }
  await preflight(input.session, requiresCloudflareDns, input.signal);
  if (input.buildSession)
    await preflight(input.buildSession, false, input.signal, "build");
  input.targetArchitecture = await verifyDeploymentArchitectures(input);
  const network = deploymentNetwork(input.context);
  if (network) {
    await input.session.run(ensureNetworkRemoteScript, [network], {
      signal: input.signal,
      timeoutMs: 30_000,
    });
  }

  const checkout = await selectDeploymentSource(input);
  await transition(
    input.hooks,
    "resolving_secrets",
    "Build, runtime, and hook secret bundles validated",
  );
  validateDeploymentSecrets(input.secrets);
  await input.session.run(prepareRemoteScript, [input.remoteDirectory], {
    signal: input.signal,
  });
  if (input.buildSession)
    await input.buildSession.run(prepareRemoteScript, [input.remoteDirectory], {
      signal: input.signal,
    });
  await writeSecretFiles(input.localDirectory, input.secrets);
  await prepareConfigurationFiles({ ...input, checkout });
  await prepareContainerRuntimeOptions(input);
  if (isNormalizedResource(input.context.app)) {
    await uploadSecrets(input, input.session, ["runtime"]);
    if (input.context.kind === "deploy") {
      await pullResourceImage(input);
    } else {
      await verifyRetainedImage(input, false);
    }
  } else if (
    checkout &&
    applicationDeployment(input.context.app).type !== "image"
  ) {
    await buildDeploymentImage(input, checkout);
    await uploadSecrets(input, input.session, ["runtime", "hooks", "registry"]);
  } else if (
    input.context.kind === "deploy" &&
    applicationDeployment(input.context.app).type === "image"
  ) {
    await pullApplicationImage(input);
    await uploadSecrets(input, input.session, ["runtime", "hooks", "registry"]);
  } else {
    await verifyRetainedImage(input, true);
  }

  const application = isNormalizedResource(input.context.app)
    ? null
    : (input.context.app as NormalizedApp);
  if (application) await prepareAppStorage(input, application);
  const hook =
    input.context.kind === "deploy" ? application?.hooks?.preDeploy : undefined;
  await transition(
    input.hooks,
    "running_pre_deploy",
    hook
      ? "Running pre-deploy hook"
      : "No pre-deploy hook declared; step skipped",
  );
  if (hook) {
    await runDeploymentHook({ ...input, hook, hookName: "preDeploy" });
  }
}

export async function preflightBuildServer(
  session: SshSession,
  signal?: AbortSignal,
) {
  await preflight(session, false, signal, "build");
}

export async function startAndVerifyCandidates(input: DeploymentPhaseInput) {
  validateHostLogCollection(input.context);
  const resource = isNormalizedResource(input.context.app)
    ? input.context.app
    : null;
  const application =
    !resource &&
    !isNormalizedCompose(input.context.app) &&
    input.context.app.kind === "app"
      ? input.context.app
      : null;
  const rollout = application?.rollout;
  if (!resource && rollout?.type === "rolling") {
    return await startRollingCandidates(input, rollout);
  }

  const previousContainer = input.context.currentRelease?.containerName ?? "";
  if (application && rollout?.type === "recreate" && rollout.maintenanceMode) {
    await transition(
      input.hooks,
      "starting_candidate",
      `Entering the declared maintenance window: ${rollout.reason}`,
    );
    const previousNames = input.context.currentRelease?.containerNames?.length
      ? input.context.currentRelease.containerNames
      : previousContainer
        ? [previousContainer]
        : [];
    for (const name of previousNames)
      await stopContainer(input, name, rollout.terminationSeconds);
  }

  const candidatePort = await startAndVerifyNamedCandidate(
    input,
    input.containerName,
    previousContainer,
  );
  await configureAndVerifyRouting(input, [candidatePort]);
  return {
    candidatePorts: [candidatePort],
    containerNames: [input.containerName],
  };
}

async function startAndVerifyNamedCandidate(
  input: DeploymentPhaseInput,
  containerName: string,
  previousContainer: string,
  startupDeadlineSeconds?: number,
  emitStateTransitions = true,
) {
  const startupDeadline = startupDeadlineSeconds
    ? Date.now() + startupDeadlineSeconds * 1_000
    : null;
  if (emitStateTransitions) {
    await transition(
      input.hooks,
      "starting_candidate",
      `Starting candidate container ${containerName}`,
    );
  } else {
    await safeLog(
      input.hooks,
      `Starting rolling candidate ${containerName}.\n`,
      "stdout",
      input.sensitiveValues,
    );
  }
  const resource = isNormalizedResource(input.context.app)
    ? input.context.app
    : null;
  const startResult = resource
    ? await input.session.run(
        `export TOWBAR_CONTAINER_RUNTIME_FILE="$1"\nshift 1\nexport TOWBAR_APP_ID="$1" TOWBAR_CLEANUP_ID="$2" TOWBAR_DEPLOYMENT_ID="$3" TOWBAR_COMMIT_SHA="$4" TOWBAR_SOURCE_ID="$5" TOWBAR_DEPLOYABLE_ID="$6"\nshift 6\n${startResourceRemoteScript}`,
        [
          containerRuntimeOptionsPath(input.remoteDirectory),
          resource.id,
          deploymentCleanupId(input.context),
          input.context.deploymentId,
          input.context.commitSha,
          input.context.sourceId,
          input.context.deployableId,
          input.remoteDirectory,
          containerName,
          input.imageTag,
          resource.container.port ? String(resource.container.port) : "",
          resource.container.network ?? "",
          resource.container.networkAlias ?? "",
          resource.access?.sshTunnel.hostPort
            ? String(resource.access.sshTunnel.hostPort)
            : "",
          String(resource.container.resources.cpus),
          resource.container.resources.memory,
          previousContainer,
          input.context.deployableId,
          String(resource.container.volumes.length),
          ...resource.container.volumes.flatMap((volume) => [
            volume.name,
            volume.mountPath,
          ]),
        ],
        {
          signal: input.signal,
          timeoutMs: startupTimeout(startupDeadline, 180_000),
        },
      )
    : await runWithSafeLogs({
        hooks: input.hooks,
        sensitiveValues: input.sensitiveValues,
        run: (handlers) =>
          input.session.run(
            `export TOWBAR_CONTAINER_RUNTIME_FILE="$1"\nshift 1\nexport TOWBAR_APP_ID="$1" TOWBAR_DEPLOYMENT_ID="$2" TOWBAR_COMMIT_SHA="$3" TOWBAR_SOURCE_ID="$4" TOWBAR_DEPLOYABLE_ID="$5" TOWBAR_VOLUME_ARGS_JSON="$6" TOWBAR_HOST_LOG_COLLECTION="$7"\nshift 7\n${startRemoteScript}`,
            [
              containerRuntimeOptionsPath(input.remoteDirectory),
              deploymentRuntimeId(input.context),
              input.context.deploymentId,
              input.context.commitSha,
              input.context.sourceId,
              input.context.deployableId,
              deploymentVolumeArguments(input.context),
              String(collectsHostDockerLogs(input.context.app)),
              input.remoteDirectory,
              containerName,
              input.imageTag,
              String(input.context.app.container.port),
              deploymentNetwork(input.context) ?? "",
              input.context.app.container.resources
                ? String(input.context.app.container.resources.cpus)
                : "",
              input.context.app.container.resources?.memory ?? "",
              input.context.app.container.networkAlias ?? "",
              previousContainer,
            ],
            {
              ...handlers,
              signal: input.signal,
              timeoutMs: startupTimeout(startupDeadline, 120_000),
            },
          ),
      });
  const requiresPublishedPort = !resource || Boolean(resource.container.port);
  const candidatePort = parseCandidatePort(
    startResult.stdout,
    requiresPublishedPort,
  );

  if (emitStateTransitions) {
    await transition(
      input.hooks,
      "checking_health",
      "Checking candidate health",
    );
  } else {
    await safeLog(
      input.hooks,
      `Checking rolling candidate ${containerName}.\n`,
      "stdout",
      input.sensitiveValues,
    );
  }
  try {
    const health = input.context.app.health;
    if (health.type === "command" || health.type === "container") {
      await input.session.run(
        `export TOWBAR_CONTAINER_RUNTIME_FILE="$1"\nshift 1\n${containerHealthRemoteScript}`,
        [
          containerRuntimeOptionsPath(input.remoteDirectory),
          containerName,
          health.type,
          String(health.timeoutSeconds),
        ],
        {
          signal: input.signal,
          timeoutMs: startupTimeout(
            startupDeadline,
            (health.timeoutSeconds + 10) * 1_000,
          ),
        },
      );
    } else {
      if (!("path" in health)) throw new Error("HTTP health path is missing");
      const healthTimeoutSeconds = boundedHealthTimeout(
        health.timeoutSeconds,
        startupDeadline,
      );
      const healthPort =
        health.port && health.port !== input.context.app.container.port
          ? parseCandidatePort(
              (
                await input.session.run(
                  'docker port "$1" "$2/tcp" | awk -F: \'NR==1 {print $NF}\'',
                  [containerName, String(health.port)],
                  { signal: input.signal },
                )
              ).stdout,
              true,
            )
          : candidatePort;
      await input.session.run(
        healthRemoteScript,
        [String(healthPort), health.path, String(healthTimeoutSeconds)],
        {
          signal: input.signal,
          timeoutMs: startupTimeout(
            startupDeadline,
            (healthTimeoutSeconds + 10) * 1_000,
          ),
        },
      );
    }
  } catch (error) {
    throw new Error("Candidate health check failed", { cause: error });
  }
  return candidatePort;
}

function deploymentNetwork(context: DeploymentExecutionContext) {
  if (isNormalizedCompose(context.app)) return null;
  return context.app.container.network ?? null;
}

async function startRollingCandidates(
  input: DeploymentPhaseInput,
  rollout: Extract<NormalizedApp["rollout"], { type: "rolling" }>,
) {
  if (
    isNormalizedCompose(input.context.app) ||
    isNormalizedResource(input.context.app)
  ) {
    throw new Error("Rolling app deployment received an incompatible workload");
  }
  const application = input.context.app;
  if (application.container.volumes?.length) {
    throw new Error(
      "Rolling deployment cannot overlap a single-writer managed volume",
    );
  }
  if (application.container.networkAlias) {
    throw new Error(
      "Rolling deployment cannot overlap a singleton network alias",
    );
  }

  const previousNames = [
    ...(input.context.currentRelease?.containerNames?.length
      ? input.context.currentRelease.containerNames
      : input.context.currentRelease?.containerName
        ? [input.context.currentRelease.containerName]
        : []),
  ];
  const previous = await inspectRunningPorts(
    input,
    previousNames,
    application.container.port,
  );
  await preflightRollingHeadroom(input, rollout, previous.length);
  const candidates: Array<{ name: string; port: number }> = [];
  const activePrevious = [...previous];
  const attemptedCandidates: string[] = [];
  const desiredNames = Array.from(
    { length: rollout.replicas },
    (_, index) => `${input.containerName}-r${index + 1}`,
  );

  try {
    for (const name of desiredNames) {
      while (
        activePrevious.length > 0 &&
        candidates.length + activePrevious.length >=
          rollout.replicas + rollout.maxSurge
      ) {
        const remainingAvailable =
          candidates.length + activePrevious.length - 1;
        if (
          remainingAvailable <
          Math.max(0, rollout.replicas - rollout.maxUnavailable)
        ) {
          throw new Error(
            "Rolling replacement cannot satisfy maxSurge and maxUnavailable",
          );
        }
        const retired = activePrevious.shift();
        if (!retired) break;
        const remainingPorts = [
          ...candidates.map((candidate) => candidate.port),
          ...activePrevious.map((release) => release.port),
        ];
        if (remainingPorts.length)
          await configureAndVerifyRouting(input, remainingPorts, false);
        if (rollout.drainSeconds > 0) {
          await wait(rollout.drainSeconds * 1_000, undefined, {
            signal: input.signal,
          });
        }
        await stopContainer(input, retired.name, rollout.terminationSeconds);
      }

      const firstCandidate = attemptedCandidates.length === 0;
      attemptedCandidates.push(name);
      const port = await startAndVerifyNamedCandidate(
        input,
        name,
        "",
        rollout.startupDeadlineSeconds,
        firstCandidate,
      );
      if (rollout.minimumHealthySeconds > 0) {
        await verifyRollingCandidateStability(input, port, rollout);
      }
      candidates.push({ name, port });
      await configureAndVerifyRouting(
        input,
        [
          ...candidates.map((candidate) => candidate.port),
          ...activePrevious.map((release) => release.port),
        ],
        false,
      );
    }

    while (activePrevious.length > 0) {
      const retired = activePrevious.shift();
      if (!retired) break;
      await configureAndVerifyRouting(
        input,
        [
          ...candidates.map((candidate) => candidate.port),
          ...activePrevious.map((release) => release.port),
        ],
        false,
      );
      if (rollout.drainSeconds > 0) {
        await wait(rollout.drainSeconds * 1_000, undefined, {
          signal: input.signal,
        });
      }
      await stopContainer(input, retired.name, rollout.terminationSeconds);
    }
    await configureAndVerifyRouting(
      input,
      candidates.map((candidate) => candidate.port),
      true,
    );
    return {
      candidatePorts: candidates.map((candidate) => candidate.port),
      containerNames: candidates.map((candidate) => candidate.name),
    };
  } catch (error) {
    const rollbackRuntime = await input.session
      .run(
        String.raw`set -euo pipefail
previous_json="$1"
candidates_json="$2"
python3 - "$previous_json" "$candidates_json" <<'PYTHON'
import json, subprocess, sys
previous = json.loads(sys.argv[1])
candidates = json.loads(sys.argv[2])
for name in candidates:
    subprocess.run(["docker", "rm", "-f", name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for name in previous:
    subprocess.run(["docker", "start", name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
PYTHON
`,
        [JSON.stringify(previousNames), JSON.stringify(attemptedCandidates)],
        { timeoutMs: 120_000 },
      )
      .then(() => true)
      .catch(async (rollbackError) => {
        await input.hooks.log?.(
          `Rolling runtime rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}\n`,
          "stderr",
        );
        return false;
      });
    if (rollbackRuntime && previous.length) {
      await restoreRollingRoute(
        input,
        previous.map((release) => release.port),
      ).catch(async (rollbackError) => {
        await input.hooks.log?.(
          `Rolling route rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}\n`,
          "stderr",
        );
      });
    }
    throw error;
  }
}

async function restoreRollingRoute(
  input: DeploymentPhaseInput,
  previousPorts: number[],
) {
  await writeRoutingFiles(input, previousPorts);
  if (!input.context.app.domains) return;
  await input.session.upload(
    path.join(input.localDirectory, "app.caddy"),
    `${input.remoteDirectory}/app.caddy`,
  );
  await input.session.run(
    configureCaddyScript,
    [
      input.remoteDirectory,
      deploymentRuntimeId(input.context),
      JSON.stringify(localDomainHandoffs(input.context)),
    ],
    { timeoutMs: 180_000 },
  );
}

function startupTimeout(deadline: number | null, maximumMs: number) {
  if (deadline === null) return maximumMs;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Candidate startup deadline exceeded");
  return Math.max(1_000, Math.min(maximumMs, remaining));
}

function boundedHealthTimeout(configured: number, deadline: number | null) {
  if (deadline === null) return configured;
  const remaining = Math.floor((deadline - Date.now()) / 1_000);
  if (remaining <= 0) throw new Error("Candidate startup deadline exceeded");
  return Math.max(1, Math.min(configured, remaining));
}

async function verifyRollingCandidateStability(
  input: DeploymentPhaseInput,
  port: number,
  rollout: Extract<NormalizedApp["rollout"], { type: "rolling" }>,
) {
  if (
    isNormalizedCompose(input.context.app) ||
    isNormalizedResource(input.context.app)
  )
    throw new Error(
      "Rolling health verification received an incompatible workload",
    );
  await input.session.run(
    String.raw`set -euo pipefail
port="$1"
health_path="$2"
stable_seconds="$3"
failure_threshold="$4"
deadline=$((SECONDS + stable_seconds))
failures=0
while (( SECONDS < deadline )); do
  if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port$health_path" >/dev/null; then
    failures=0
  else
    failures=$((failures + 1))
    if (( failures >= failure_threshold )); then
      echo "Candidate exceeded the readiness failure threshold" >&2
      exit 1
    fi
  fi
  sleep 2
done
`,
    [
      String(port),
      "path" in input.context.app.health
        ? input.context.app.health.path
        : (() => {
            throw new Error("Rolling deployments require HTTP health");
          })(),
      String(rollout.minimumHealthySeconds),
      String(rollout.failureThreshold),
    ],
    {
      signal: input.signal,
      timeoutMs: (rollout.minimumHealthySeconds + 10) * 1_000,
    },
  );
}

async function preflightRollingHeadroom(
  input: DeploymentPhaseInput,
  rollout: Extract<NormalizedApp["rollout"], { type: "rolling" }>,
  runningPreviousCount: number,
) {
  const resources = input.context.app.container.resources ?? {
    cpus: 1,
    memory: "512m",
  };
  const surge = Math.min(rollout.maxSurge, rollout.replicas);
  // Scaling up needs room for every missing replica. During replacement, the
  // peak also includes the permitted surge until an old replica is drained.
  // If excess old replicas already exist, Towbar retires them before starting
  // a candidate, so their released limits provide the required headroom.
  const additionalContainers = Math.max(
    0,
    rollout.replicas +
      (runningPreviousCount > 0 ? surge : 0) -
      runningPreviousCount,
  );
  if (additionalContainers === 0) return;
  await input.session.run(
    rollingMemoryHeadroomScript,
    [resources.memory, String(additionalContainers)],
    { signal: input.signal, timeoutMs: 30_000 },
  );
}

async function inspectRunningPorts(
  input: DeploymentPhaseInput,
  containerNames: string[],
  containerPort: number,
) {
  const running: Array<{ name: string; port: number }> = [];
  for (const name of containerNames) {
    const result = await input.session.run(
      'set -euo pipefail\nif test "$(docker inspect --format \'{{.State.Running}}\' "$1" 2>/dev/null || true)" = true; then docker port "$1" "$2/tcp" | awk -F: \'NR==1 {print $NF}\'; fi',
      [name, String(containerPort)],
      { signal: input.signal, timeoutMs: 30_000 },
    );
    const port = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isInteger(port) && port > 0) running.push({ name, port });
  }
  return running;
}

async function stopContainer(
  input: DeploymentPhaseInput,
  name: string,
  timeoutSeconds = 30,
) {
  await input.session.run(
    'set -euo pipefail\ndocker stop --time "$2" "$1" >/dev/null 2>&1 || true',
    [name, String(timeoutSeconds)],
    { signal: input.signal, timeoutMs: (timeoutSeconds + 15) * 1_000 },
  );
}

export async function finishPromotedDeployment(
  input: DeploymentPhaseInput & {
    containerNames: string[];
    deferCleanup: boolean;
    retainedImageTags: string[];
    warnings: string[];
  },
) {
  const application = isNormalizedResource(input.context.app)
    ? null
    : (input.context.app as NormalizedApp);
  const hook =
    input.context.kind === "deploy"
      ? application?.hooks?.postDeploy
      : undefined;
  await transition(
    input.hooks,
    "running_post_deploy",
    hook
      ? "Running post-deploy hook"
      : "No post-deploy hook declared; step skipped",
  );
  if (hook) {
    await runDeploymentHook({ ...input, hook, hookName: "postDeploy" }).catch(
      async () => {
        const warning =
          "Post-deploy hook failed after promotion; the release remains live";
        input.warnings.push(warning);
        await safeLog(
          input.hooks,
          `${warning}.\n`,
          "stderr",
          input.sensitiveValues,
        );
      },
    );
  }

  await cleanupPreviousDeploymentDns(input).catch(async () => {
    const warning =
      "The release is live, but previous Cloudflare DNS records need cleanup";
    input.warnings.push(warning);
    await safeLog(
      input.hooks,
      `${warning}.\n`,
      "stderr",
      input.sensitiveValues,
    );
  });

  await (
    input.secrets.previousCloudflareTunnelCleanupBlocked
      ? Promise.reject(new Error("Previous tunnel credentials are unavailable"))
      : cleanupCloudflareTunnelTransition({
          appId: deploymentRuntimeId(input.context),
          current: input.secrets.cloudflareTunnel,
          previous: input.secrets.previousCloudflareTunnel,
          protectedHostnames: deploymentPublicHostnames(input.context.app),
          session: input.session,
        })
  ).catch(async () => {
    const warning =
      "The release is live, but the previous Cloudflare Tunnel needs cleanup";
    input.warnings.push(warning);
    await safeLog(
      input.hooks,
      `${warning}.\n`,
      "stderr",
      input.sensitiveValues,
    );
  });
  await input.cloudflareTunnelTransition?.finalize().catch(async () => {
    const warning =
      "The release is live, but Cloudflare Tunnel rollback state needs cleanup";
    input.warnings.push(warning);
    await safeLog(
      input.hooks,
      `${warning}.\n`,
      "stderr",
      input.sensitiveValues,
    );
  });

  await transition(
    input.hooks,
    "cleaning_up",
    input.deferCleanup
      ? "Scheduling cleanup after the self-managed worker handoff"
      : "Retaining current and previous releases",
  );
  await input.session
    .run(
      input.deferCleanup ? scheduleFinalizeRemoteScript : finalizeRemoteScript,
      [
        input.remoteDirectory,
        deploymentCleanupId(input.context),
        JSON.stringify(input.containerNames),
        ...(input.deferCleanup ? ["20"] : []),
        ...input.retainedImageTags,
      ],
      { signal: input.signal, timeoutMs: 120_000 },
    )
    .catch(async () => {
      await safeLog(
        input.hooks,
        "Post-promotion cleanup was deferred until a later deployment.\n",
        "stderr",
        input.sensitiveValues,
      );
    });
  await transition(
    input.hooks,
    input.warnings.length > 0 ? "succeeded_with_warnings" : "succeeded",
    input.warnings.length > 0
      ? "Deployment completed with post-deploy warnings"
      : input.deferCleanup
        ? "Deployment completed; previous worker cleanup was handed off"
        : "Deployment completed",
  );
}

async function selectDeploymentSource(input: DeploymentPhaseInput) {
  if (input.context.kind === "rollback") {
    await transition(
      input.hooks,
      "fetching_source",
      `Selecting retained release ${input.context.rollbackRelease?.releaseId.slice(0, 8)}`,
    );
    return undefined;
  }
  if (
    !isNormalizedCompose(input.context.app) &&
    input.context.app.container.configFiles?.length
  ) {
    await transition(
      input.hooks,
      "fetching_source",
      `Fetching configuration files at commit ${input.context.commitSha.slice(0, 12)}`,
    );
    return await fetchDeploymentSource(
      input.context,
      input.localDirectory,
      input.signal,
    );
  }
  if (isNormalizedResource(input.context.app)) {
    await transition(
      input.hooks,
      "fetching_source",
      `Selecting image ${input.context.app.image}`,
    );
    return undefined;
  }
  if (applicationDeployment(input.context.app).type === "image") {
    await transition(
      input.hooks,
      "fetching_source",
      "Selecting the declared immutable application image",
    );
    return undefined;
  }
  await transition(
    input.hooks,
    "fetching_source",
    `Fetching commit ${input.context.commitSha.slice(0, 12)}`,
  );
  return await fetchDeploymentSource(
    input.context,
    input.localDirectory,
    input.signal,
  );
}

async function buildDeploymentImage(
  input: DeploymentPhaseInput,
  checkout: string,
) {
  const application = input.context.app as NormalizedApp;
  const deployment = applicationDeployment(application);
  const contextArchive = path.join(input.localDirectory, "context.tar.gz");
  let relativeDockerfile = "";
  if (deployment.type === "dockerfile") {
    ({ relativeDockerfile } = await createBuildContextArchive({
      archivePath: contextArchive,
      checkout,
      contextPath: deployment.context,
      dockerfilePath: deployment.dockerfile,
      signal: input.signal,
    }));
  } else {
    if (deployment.type === "image")
      throw new Error("Prebuilt images do not use a source checkout");
    await createSourceContextArchive({
      archivePath: contextArchive,
      checkout,
      contextPath: deployment.context,
      signal: input.signal,
    });
  }
  await transition(
    input.hooks,
    "transferring",
    "Transferring minimal build context",
  );
  const buildSession = input.buildSession ?? input.session;
  await buildSession.upload(
    contextArchive,
    `${input.remoteDirectory}/context.tar.gz`,
    { signal: input.signal },
  );
  await uploadSecrets(input, buildSession, ["build", "registry"]);
  await transition(input.hooks, "building", "Building immutable Docker image");
  const timeoutMs =
    "timeoutSeconds" in deployment
      ? deployment.timeoutSeconds * 1_000
      : 45 * 60_000;
  await runWithSafeLogs({
    hooks: input.hooks,
    run: async (outputHandlers) =>
      await buildSession.run(
        `export TOWBAR_APP_ID="$1" TOWBAR_COMMIT_SHA="$2" TOWBAR_SOURCE_ID="$3" TOWBAR_DEPLOYABLE_ID="$4"\nshift 4\n${buildScriptFor(deployment.type)}`,
        [
          deploymentRuntimeId(input.context),
          input.context.commitSha,
          input.context.sourceId,
          input.context.deployableId,
          ...buildArguments(input, deployment, relativeDockerfile),
        ],
        { ...outputHandlers, signal: input.signal, timeoutMs },
      ),
    sensitiveValues: input.sensitiveValues,
  });
  if (input.buildSession) await transferBuiltImage(input);
}

async function transferBuiltImage(input: DeploymentPhaseInput) {
  if (!input.buildSession) return;
  if (input.context.buildServer?.transfer === "registry") {
    if (!input.secrets.registry)
      throw new Error("Registry build transfer credentials are unavailable");
    const registryImage = registryTransferImage(input);
    const { stdout } = await input.buildSession.run(
      String.raw`set -euo pipefail
remote_dir="$1"
server="$2"
source_image="$3"
registry_image="$4"
cat "$remote_dir/secrets/registry/password" | docker login "$server" --username "$(cat "$remote_dir/secrets/registry/username")" --password-stdin >/dev/null
trap 'docker logout "$server" >/dev/null 2>&1 || true' EXIT
docker image tag "$source_image" "$registry_image"
docker push "$registry_image" >/dev/null
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$registry_image" | grep '^'"$registry_image"'@sha256:' | head -1
`,
      [
        input.remoteDirectory,
        registryServer(input.secrets.registry.server),
        input.imageTag,
        registryImage,
      ],
      { signal: input.signal, timeoutMs: 30 * 60_000 },
    );
    const immutableImage = stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${registryImage}@sha256:`));
    if (!immutableImage?.match(/@sha256:[a-f0-9]{64}$/u))
      throw new Error("Registry did not return an immutable image digest");
    await input.session.run(
      String.raw`set -euo pipefail
remote_dir="$1"
server="$2"
immutable_image="$3"
local_image="$4"
cat "$remote_dir/secrets/registry/password" | docker login "$server" --username "$(cat "$remote_dir/secrets/registry/username")" --password-stdin >/dev/null
trap 'docker logout "$server" >/dev/null 2>&1 || true' EXIT
docker pull "$immutable_image" >/dev/null
test "$(docker image inspect --format '{{index .RepoDigests 0}}' "$immutable_image" | sed 's/.*@//')" = "${"$"}{immutable_image##*@}"
docker image tag "$immutable_image" "$local_image"
docker image inspect "$local_image" >/dev/null
`,
      [
        input.remoteDirectory,
        registryServer(input.secrets.registry.server),
        immutableImage,
        input.imageTag,
      ],
      { signal: input.signal, timeoutMs: 30 * 60_000 },
    );
    return;
  }
  const remoteArchive = `${input.remoteDirectory}/image.tar.gz`;
  const localArchive = path.join(input.localDirectory, "image.tar.gz");
  const { stdout } = await input.buildSession.run(
    String.raw`set -euo pipefail
image_size="$(docker image inspect --format '{{.Size}}' "$1")"
case "$image_size" in ''|*[!0-9]*) exit 65;; esac
test "$image_size" -le "$3"
available="$(df -PB1 "$(dirname "$2")" | awk 'NR==2 {print $4}')"
test "$available" -ge "$((image_size + 268435456))"
docker save "$1" | gzip -1 >"$2"
archive_size="$(stat -c %s "$2")"
test "$archive_size" -le "$3"
printf '%s %s\n' "$(sha256sum "$2" | awk '{print $1}')" "$archive_size"
`,
    [input.imageTag, remoteArchive, String(maxBuildArtifactBytes)],
    { signal: input.signal, timeoutMs: 30 * 60_000 },
  );
  const [expectedChecksum, rawArchiveSize] = stdout.trim().split(/\s+/u);
  if (!expectedChecksum?.match(/^[a-f0-9]{64}$/u))
    throw new Error("Build server did not return an image checksum");
  const archiveSize = Number(rawArchiveSize);
  if (
    !Number.isSafeInteger(archiveSize) ||
    archiveSize <= 0 ||
    archiveSize > maxBuildArtifactBytes
  )
    throw new Error("Build artifact exceeds Towbar's 20 GiB transfer limit");
  const localCapacity = await statfs(input.localDirectory);
  if (
    localCapacity.bavail * localCapacity.bsize <
    archiveSize + buildArtifactCapacityMargin
  )
    throw new Error(
      "The control plane does not have enough temporary capacity for this build artifact",
    );
  await input.buildSession.download(remoteArchive, localArchive, {
    signal: input.signal,
    timeoutMs: 30 * 60_000,
  });
  if ((await stat(localArchive)).size !== archiveSize)
    throw new Error("Build artifact size changed during transfer");
  await input.session.run(
    String.raw`set -euo pipefail
available="$(df -PB1 "$1" | awk 'NR==2 {print $4}')"
test "$available" -ge "$(( $2 + 268435456 ))"
`,
    [input.remoteDirectory, String(archiveSize)],
    { signal: input.signal, timeoutMs: 30_000 },
  );
  await input.session.upload(localArchive, remoteArchive, {
    signal: input.signal,
    timeoutMs: 30 * 60_000,
  });
  await input.session.run(
    'set -euo pipefail\ntest "$(sha256sum "$1" | awk \'{print $1}\')" = "$2"\ngzip -cd "$1" | docker load >/dev/null\ndocker image inspect "$3" >/dev/null\nrm -f -- "$1"\n',
    [remoteArchive, expectedChecksum, input.imageTag],
    { signal: input.signal, timeoutMs: 30 * 60_000 },
  );
}

export async function cleanupBuildServerArtifacts(input: DeploymentPhaseInput) {
  if (!input.buildSession) return;
  const tags = [input.imageTag];
  if (
    input.context.buildServer?.transfer === "registry" &&
    input.secrets.registry
  )
    tags.push(registryTransferImage(input));
  await input.buildSession.run(
    'for image in "$@"; do docker image rm "$image" >/dev/null 2>&1 || true; done',
    tags,
    { timeoutMs: 120_000 },
  );
}

function registryServer(value: string) {
  return value.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
}

function registryTransferImage(input: DeploymentPhaseInput) {
  const server = registryServer(input.secrets.registry!.server);
  return `${server}/towbar/${input.context.deployableId}:${input.context.deploymentId}`;
}

function buildScriptFor(
  type: Exclude<ReturnType<typeof applicationDeployment>["type"], "image">,
) {
  if (type === "dockerfile") return buildRemoteScript;
  if (type === "static") return staticBuildRemoteScript;
  return builderBuildRemoteScript;
}

// eslint-disable-next-line complexity -- The argument matrix maps each supported buildpack contract to its immutable CLI invocation.
function buildArguments(
  input: DeploymentPhaseInput,
  deployment: Exclude<
    ReturnType<typeof applicationDeployment>,
    { type: "image" }
  >,
  relativeDockerfile: string,
) {
  if (deployment.type === "dockerfile")
    return [
      input.remoteDirectory,
      input.imageTag,
      relativeDockerfile,
      String(MAX_SOURCE_EXPANDED_BYTES),
      String(MAX_SOURCE_ARCHIVE_ENTRIES),
      JSON.stringify(deployment.arguments),
      String(deployment.resources.cpus),
      deployment.resources.memory,
      deployment.target ?? "",
      input.targetArchitecture ?? "",
      String(deployment.cache?.enabled ?? true),
      buildCacheScope(input, deployment.cache?.scope, deployment.type),
    ];
  if (deployment.type === "static")
    return [
      input.remoteDirectory,
      input.imageTag,
      deployment.output,
      String(input.context.app.container.port),
      deployment.nodeImage,
      deployment.runtimeImage,
      JSON.stringify(deployment.buildCommand ?? []),
      String(deployment.spaFallback),
      deployment.index,
      deployment.errorPage ?? "",
      JSON.stringify(deployment.headers ?? {}),
      String(MAX_SOURCE_EXPANDED_BYTES),
      String(MAX_SOURCE_ARCHIVE_ENTRIES),
      JSON.stringify(deployment.arguments),
      String(deployment.resources.cpus),
      deployment.resources.memory,
      input.targetArchitecture ?? "",
      String(deployment.cache?.enabled ?? true),
      buildCacheScope(input, deployment.cache?.scope, deployment.type),
    ];
  return [
    input.remoteDirectory,
    input.imageTag,
    deployment.type,
    deployment.type === "buildpack" ? deployment.packImage : deployment.image,
    deployment.type === "buildpack" ? deployment.builder : "",
    JSON.stringify(deployment.buildCommand ?? []),
    JSON.stringify(deployment.startCommand ?? []),
    input.targetArchitecture ?? "",
    String(deployment.cache?.enabled ?? true),
    JSON.stringify(
      deployment.type === "buildpack" ? (deployment.buildpacks ?? []) : [],
    ),
    JSON.stringify(deployment.arguments),
    String(MAX_SOURCE_EXPANDED_BYTES),
    String(MAX_SOURCE_ARCHIVE_ENTRIES),
    String(deployment.resources.cpus),
    deployment.resources.memory,
    deployment.type === "buildpack" ? "" : deployment.version,
    deployment.configFile ?? "",
    buildCacheScope(input, deployment.cache?.scope, deployment.type),
  ];
}

function buildCacheScope(
  input: DeploymentPhaseInput,
  requested: string | undefined,
  mode: string,
) {
  return createHash("sha256")
    .update(
      `${input.context.sourceId}\0${requested ?? input.context.deployableId}\0${mode}`,
    )
    .digest("hex")
    .slice(0, 32);
}

async function verifyDeploymentArchitectures(input: DeploymentPhaseInput) {
  const runtime = await serverArchitecture(input.session, input.signal);
  if (isNormalizedResource(input.context.app)) return runtime;
  const deployment = applicationDeployment(input.context.app);
  const requested =
    deployment.type === "image"
      ? deployment.platform?.replace("linux/", "")
      : "architecture" in deployment
        ? deployment.architecture
        : undefined;
  if (requested && requested !== runtime)
    throw new Error(
      `Deployment targets linux/${requested}, but the runtime server is linux/${runtime}`,
    );
  if (
    input.buildSession &&
    !isNormalizedCompose(input.context.app) &&
    input.context.app.buildServer?.architecture
  ) {
    const actual = await serverArchitecture(input.buildSession, input.signal);
    if (actual !== input.context.app.buildServer.architecture)
      throw new Error(
        `Build server was declared as ${input.context.app.buildServer.architecture}, but reports ${actual}`,
      );
  }
  return runtime;
}

async function serverArchitecture(session: SshSession, signal?: AbortSignal) {
  const result = await session.run(
    'set -euo pipefail\ncase "$(uname -m)" in x86_64|amd64) printf amd64 ;; aarch64|arm64) printf arm64 ;; *) echo "Unsupported server architecture" >&2; exit 65 ;; esac',
    [],
    { signal, timeoutMs: 30_000 },
  );
  const architecture = result.stdout.trim();
  if (architecture !== "amd64" && architecture !== "arm64")
    throw new Error("Server returned an invalid architecture");
  return architecture;
}

async function pullApplicationImage(input: DeploymentPhaseInput) {
  const deployment = applicationDeployment(input.context.app);
  if (deployment.type !== "image")
    throw new Error("Application image is missing");
  await transition(input.hooks, "transferring", "No source transfer required");
  await transition(
    input.hooks,
    "building",
    "Pulling the declared application image",
  );
  await runWithSafeLogs({
    hooks: input.hooks,
    run: async (outputHandlers) =>
      input.session.run(
        pullApplicationImageRemoteScript,
        [
          deployment.image,
          input.imageTag,
          deployment.pullPolicy,
          deployment.platform ?? "",
          input.remoteDirectory,
          input.secrets.registry
            ? registryServer(input.secrets.registry.server)
            : "",
        ],
        { ...outputHandlers, signal: input.signal, timeoutMs: 15 * 60_000 },
      ),
    sensitiveValues: input.sensitiveValues,
  });
}

function applicationDeployment(
  app: import("@workspace/towbar-core").NormalizedDeployable,
) {
  if (isNormalizedResource(app))
    throw new Error("Managed resources do not have an application build mode");
  if (isNormalizedCompose(app))
    throw new Error("Compose workloads use the Compose deployment executor");
  return (
    app.deployment ?? {
      type: "dockerfile" as const,
      context: app.context,
      arguments: {},
      resources: { cpus: 2, memory: "2g" },
      dockerfile: app.dockerfile ?? "Dockerfile",
      timeoutSeconds: 2_700,
    }
  );
}

async function verifyRetainedImage(
  input: DeploymentPhaseInput,
  uploadRuntimeSecrets: boolean,
) {
  await transition(
    input.hooks,
    "transferring",
    "Transferring runtime configuration for retained release",
  );
  if (uploadRuntimeSecrets)
    await uploadSecrets(input, input.session, ["runtime", "hooks"]);
  await transition(input.hooks, "building", "Verifying retained Docker image");
  await input.session.run(
    'docker image inspect "$1" >/dev/null',
    [input.imageTag],
    {
      signal: input.signal,
      timeoutMs: 30_000,
    },
  );
}

async function configureAndVerifyRouting(
  input: DeploymentPhaseInput,
  candidatePorts: number[],
  verifyPublic = true,
) {
  if (verifyPublic) {
    await transition(
      input.hooks,
      "configuring_routing",
      domainHandoffRoutingMessage(input.context) ??
        "Reconciling DNS and validating generated Caddy routing",
    );
  } else {
    await safeLog(
      input.hooks,
      "Applying an intermediate rolling route.\n",
      "stdout",
      input.sensitiveValues,
    );
  }
  await writeRoutingFiles(input, candidatePorts);
  if (!input.context.app.domains) {
    if (!verifyPublic) return;
    await transition(
      input.hooks,
      "provisioning_tls",
      "No domain declared; TLS skipped",
    );
    await transition(
      input.hooks,
      "checking_public_endpoint",
      "No public endpoint declared; check skipped",
    );
    return;
  }

  await input.session.upload(
    path.join(input.localDirectory, "app.caddy"),
    `${input.remoteDirectory}/app.caddy`,
    { signal: input.signal },
  );
  if (input.secrets.cloudflare) {
    await input.session.upload(
      path.join(input.localDirectory, "cloudflare.env"),
      `${input.remoteDirectory}/cloudflare.env`,
      { signal: input.signal },
    );
  }
  if (verifyPublic) {
    await transition(
      input.hooks,
      "provisioning_tls",
      "Provisioning TLS through Caddy",
    );
  }
  await input.session.run(
    configureCaddyScript,
    [
      input.remoteDirectory,
      deploymentRuntimeId(input.context),
      JSON.stringify(localDomainHandoffs(input.context)),
    ],
    { signal: input.signal, timeoutMs: 180_000 },
  );
  const dnsTransition = await reconcileCloudflareForDeployment({
    app: input.context.app,
    appId: deploymentRuntimeId(input.context),
    onDnsChange: input.onDnsChange,
    handoffs: input.context.domainHandoffs,
    expectedRecords: input.cloudflareDnsExpectations,
    credentials: input.secrets.cloudflare,
    handoffDns: input.secrets.domainHandoffDns,
    server: input.context.server,
  });
  if (dnsTransition) {
    input.cloudflareDnsTransitions?.push(dnsTransition);
    const tunnelHostnames = new Set(
      deploymentTunnelHostnames(input.context.app),
    );
    for (const hostname of Object.keys(input.cloudflareDnsExpectations ?? {}))
      if (!tunnelHostnames.has(hostname))
        delete input.cloudflareDnsExpectations?.[hostname];
  }
  if (!verifyPublic) return;
  if (input.context.app.ingress?.type === "cloudflare-tunnel") {
    if (!input.secrets.cloudflareTunnel)
      throw new Error("Cloudflare Tunnel credentials were not resolved");
    input.cloudflareTunnelTransition =
      await reconcileCloudflareTunnelForDeployment({
        ...input.secrets.cloudflareTunnel,
        app: input.context.app,
        appId: deploymentRuntimeId(input.context),
        onDnsChange: input.onDnsChange,
        handoffs: input.context.domainHandoffs,
        expectedRecords: input.cloudflareDnsExpectations,
        localDirectory: input.localDirectory,
        session: input.session,
      });
  }
  await transition(
    input.hooks,
    "checking_public_endpoint",
    "Checking origin and public HTTPS endpoints",
  );
  await checkOriginEndpoint(
    sshConnectionHost(input.context.server),
    input.context.app.domains.primary,
    getPublicHealthPath(input.context),
    input.signal,
  );
  await checkPublicEndpoint(
    input.context.app.domains.primary,
    getPublicHealthPath(input.context),
    input.signal,
  );
}

function getPublicHealthPath(context: DeploymentExecutionContext) {
  const health = context.app.health;
  if (health.publicPath) return health.publicPath;
  if (!("path" in health))
    throw new Error("Public workloads require an HTTP publicPath");
  return health.path;
}

async function writeSecretFiles(
  localDirectory: string,
  secrets: DeploymentSecrets,
) {
  const directories = {
    build: path.join(localDirectory, "build-secrets"),
    postDeploy: path.join(localDirectory, "hook-secrets", "postDeploy"),
    preDeploy: path.join(localDirectory, "hook-secrets", "preDeploy"),
    runtime: path.join(localDirectory, "runtime-secrets"),
    registry: path.join(localDirectory, "registry-secrets"),
  };
  await Promise.all(
    Object.values(directories).map((directory) =>
      mkdir(directory, { mode: 0o700, recursive: true }),
    ),
  );
  await writeEntries(directories.build, secrets.build);
  await writeFile(
    path.join(directories.build, aggregateBuildSecretKey),
    JSON.stringify(secrets.build),
    { mode: 0o600 },
  );
  await Promise.all([
    writeEntries(directories.runtime, secrets.runtime),
    writeEntries(directories.postDeploy, secrets.hooks.postDeploy),
    writeEntries(directories.preDeploy, secrets.hooks.preDeploy),
    ...(secrets.registry
      ? [writeEntries(directories.registry, secrets.registry)]
      : []),
  ]);
}

async function writeEntries(
  directory: string,
  entries: Record<string, string>,
) {
  await Promise.all(
    Object.entries(entries).map(([key, value]) =>
      writeFile(path.join(directory, key), value, { mode: 0o600 }),
    ),
  );
}

async function uploadSecrets(
  input: DeploymentPhaseInput,
  session: SshSession,
  groups: Array<"build" | "hooks" | "registry" | "runtime">,
) {
  const files = [
    ...(groups.includes("build")
      ? [...Object.keys(input.secrets.build), aggregateBuildSecretKey].map(
          (key) => ["build-secrets", `build/${key}`, key] as const,
        )
      : []),
    ...(groups.includes("runtime")
      ? Object.keys(input.secrets.runtime).map(
          (key) => ["runtime-secrets", `runtime/${key}`, key] as const,
        )
      : []),
    ...(groups.includes("hooks")
      ? (["postDeploy", "preDeploy"] as const).flatMap((hookName) =>
          Object.keys(input.secrets.hooks[hookName]).map(
            (key) =>
              [
                `hook-secrets/${hookName}`,
                `hooks/${hookName}/${key}`,
                key,
              ] as const,
          ),
        )
      : []),
    ...(groups.includes("registry") && input.secrets.registry
      ? (["username", "password"] as const).map(
          (key) => ["registry-secrets", `registry/${key}`, key] as const,
        )
      : []),
  ];
  for (const [localParent, remotePath, key] of files) {
    await session.upload(
      path.join(input.localDirectory, localParent, key),
      `${input.remoteDirectory}/secrets/${remotePath}`,
      { signal: input.signal },
    );
  }
  await session.run(
    'set -euo pipefail\nfind "$1"/secrets -type f -exec chmod 600 {} +\n',
    [input.remoteDirectory],
    { signal: input.signal },
  );
}

async function runDeploymentHook(
  input: DeploymentPhaseInput & {
    hook: NormalizedDeploymentHook;
    hookName: "postDeploy" | "preDeploy";
  },
) {
  await prepareContainerRuntimeOptions(input);
  await runWithSafeLogs({
    hooks: input.hooks,
    run: async (outputHandlers) =>
      await input.session.run(
        `export TOWBAR_CONTAINER_RUNTIME_FILE="$1"\nshift 1\nexport TOWBAR_APP_ID="$1" TOWBAR_DEPLOYMENT_ID="$2" TOWBAR_COMMIT_SHA="$3" TOWBAR_VOLUME_ARGS_JSON="$4"\nshift 4\n${hookRemoteScript}`,
        [
          containerRuntimeOptionsPath(input.remoteDirectory, input.hookName),
          deploymentRuntimeId(input.context),
          input.context.deploymentId,
          input.context.commitSha,
          deploymentVolumeArguments(input.context),
          input.remoteDirectory,
          input.hookName,
          input.containerName,
          input.imageTag,
          deploymentNetwork(input.context) ?? "",
          input.context.app.container.resources
            ? String(input.context.app.container.resources.cpus)
            : "",
          input.context.app.container.resources?.memory ?? "",
          String(input.hook.timeoutSeconds),
        ],
        {
          ...outputHandlers,
          signal: input.signal,
          timeoutMs: (input.hook.timeoutSeconds + 30) * 1_000,
        },
      ),
    sensitiveValues: input.sensitiveValues,
  });
}

async function writeRoutingFiles(input: DeploymentPhaseInput, ports: number[]) {
  await writeFile(
    path.join(input.localDirectory, "app.caddy"),
    renderCaddyFragment(input.context, ports),
    { mode: 0o600 },
  );
  if (input.secrets.cloudflare) {
    await writeFile(
      path.join(input.localDirectory, "cloudflare.env"),
      `CLOUDFLARE_API_TOKEN=${input.secrets.cloudflare.apiToken}\n`,
      { mode: 0o600 },
    );
  }
  await chmod(input.localDirectory, 0o700);
}

async function preflight(
  session: SshSession,
  requiresCloudflareModule: boolean,
  signal?: AbortSignal,
  role: "build" | "runtime" = "runtime",
) {
  await session.run(
    'set -euo pipefail\nrequires_cloudflare="$1"\nrole="$2"\n. /etc/os-release\ntest "$ID" = ubuntu\ncommand -v docker >/dev/null\ndocker info >/dev/null\ncommand -v python3 >/dev/null\ncommand -v timeout >/dev/null\nif test "$role" = runtime; then command -v caddy >/dev/null; sudo -n /usr/bin/test -d /etc/caddy; fi\nif test "$requires_cloudflare" = true; then caddy list-modules | grep -Fx dns.providers.cloudflare >/dev/null; fi\ntest "$(df -Pk /var/lib/docker | awk \'NR==2 {print $4}\')" -gt 1048576\n',
    [String(requiresCloudflareModule), role],
    { signal, timeoutMs: 30_000 },
  );
}

async function cleanupPreviousDeploymentDns(input: DeploymentPhaseInput) {
  if (input.secrets.previousCloudflareDnsCleanupBlocked)
    throw new Error("Previous DNS credentials are unavailable");
  await cleanupCloudflareDnsTransition({
    appId: deploymentRuntimeId(input.context),
    previous: input.secrets.previousCloudflareDns ?? null,
    protectedHostnames: deploymentPublicHostnames(input.context.app),
    managedHostnames: deploymentCloudflareDnsDomains(input.context.app),
  });
}
