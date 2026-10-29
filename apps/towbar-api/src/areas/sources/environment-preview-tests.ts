import { testDeploymentEnvironment } from "./instance-test-helper.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  isNormalizedCompose,
  isNormalizedResource,
} from "@workspace/towbar-core";
import {
  previewPullRequestReports,
  sourceEnvironments,
} from "@workspace/towbar-database/schema";
import { apps, type servers } from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { getInstanceEnvironment } from "../apps/instance-environment.js";

export async function assertPreviewDiscovery(input: {
  stageId: string;
  stagingId: string;
  sourceId: string;
  workspaceId: string;
}) {
  const database = getTowbarDatabase();
  const { scheduleSourcePreviewReconciliations } =
    await import("../previews/reconciliation-scheduler.js");
  const [current] = await database
    .select()
    .from(apps)
    .where(eq(apps.id, input.stageId));
  assert(current && !isNormalizedResource(current.config));
  const configBefore = current.config;
  const branches: string[] = [];
  const queued: number[] = [];
  const dependencies = {
    listPullRequests: (request: { baseBranch: string }) => {
      branches.push(request.baseBranch);
      return Promise.resolve([7, 9]);
    },
    enqueue: (request: { pullRequestNumber: number }) => {
      queued.push(request.pullRequestNumber);
      return Promise.resolve({
        workflowId: `preview-test-${request.pullRequestNumber}`,
      });
    },
  };
  try {
    await database
      .update(sourceEnvironments)
      .set({ previewsEnabled: true })
      .where(eq(sourceEnvironments.id, input.stagingId));
    await database
      .update(apps)
      .set({
        config: {
          ...configBefore,
          preview: {
            enabled: true,
            domain: "preview.example.com",
            ttlHours: 72,
          },
        },
      })
      .where(eq(apps.id, input.stageId));
    await database.insert(previewPullRequestReports).values({
      sourceId: input.sourceId,
      workspaceId: input.workspaceId,
      pullRequestNumber: 9,
      branch: "feature",
      latestCommitSha: "b".repeat(40),
    });
    await scheduleSourcePreviewReconciliations(input.sourceId, dependencies);
    assert.deepEqual(branches, ["develop"]);
    assert.deepEqual(queued, [7, 9]);
    branches.length = 0;
    queued.length = 0;
    await database
      .update(sourceEnvironments)
      .set({ previewsEnabled: false })
      .where(eq(sourceEnvironments.id, input.stagingId));
    await scheduleSourcePreviewReconciliations(input.sourceId, dependencies);
    assert.deepEqual(branches, []);
    assert.deepEqual(queued, [9]);
  } finally {
    await database
      .update(apps)
      .set({ config: configBefore })
      .where(eq(apps.id, input.stageId));
    await database
      .update(sourceEnvironments)
      .set({ previewsEnabled: false })
      .where(eq(sourceEnvironments.id, input.stagingId));
  }
}

export async function assertPreviewAdmissionGuards({
  stage,
  sourceId,
  workspaceId,
  config,
}: {
  stage: typeof apps.$inferSelect;
  sourceId: string;
  workspaceId: string;
  config: (typeof servers.$inferSelect)["config"];
}) {
  const database = getTowbarDatabase();
  const { admitPreviewDeployment } = await import("../previews/admission.js");
  const { withPreviewLifecycleLock } =
    await import("../previews/lifecycle-lock.js");
  const identity = { sourceId, pullRequestNumber: 22 };
  await withPreviewLifecycleLock(identity, async () => {
    await assert.rejects(
      withPreviewLifecycleLock(identity, () => Promise.resolve()),
      /already being reconciled/,
    );
    assert.equal(
      await withPreviewLifecycleLock(
        { ...identity, pullRequestNumber: 23 },
        () => Promise.resolve("other PR"),
      ),
      "other PR",
    );
  });
  await assert.rejects(
    withPreviewLifecycleLock(identity, () =>
      Promise.reject(new Error("test failure")),
    ),
    /test failure/,
  );
  assert.equal(
    await withPreviewLifecycleLock(identity, () => Promise.resolve("released")),
    "released",
  );
  const environment = await getInstanceEnvironment({
    appId: stage.id,
    workspaceId,
  });
  assert(
    environment &&
      stage.requiredSecrets &&
      !isNormalizedResource(stage.config) &&
      !isNormalizedCompose(stage.config),
  );
  const input = {
    appId: stage.id,
    branch: "feature",
    commitSha: "c".repeat(40),
    config: stage.config,
    deploymentDigest: "test",
    hostname: "preview.example.com",
    manifestDigest: "test",
    pullRequestNumber: 22,
    server: config,
    serverId: stage.serverId,
    sourceId,
    sourceInputDigest: null,
    ttlHours: 24,
    workspaceId,
    targetEnvironment: environment,
    targetConfigDigest: stage.configDigest,
    requiredSecrets: stage.requiredSecrets,
  };
  try {
    await database
      .update(sourceEnvironments)
      .set({ previewsEnabled: true })
      .where(eq(sourceEnvironments.id, environment.id));
    await assert.rejects(
      admitPreviewDeployment({
        ...input,
        targetEnvironment: {
          ...environment,
          mappingRevision: randomUUID(),
        },
      }),
      /environment changed/,
    );
    await assert.rejects(
      admitPreviewDeployment(input),
      /preview target changed/,
    );
  } finally {
    await database
      .update(sourceEnvironments)
      .set({ previewsEnabled: false })
      .where(eq(sourceEnvironments.id, environment.id));
  }
}

export async function assertDeploymentSecretSnapshot({
  stage,
  sourceId,
  workspaceId,
  config,
  userId,
}: {
  stage: typeof apps.$inferSelect;
  sourceId: string;
  workspaceId: string;
  config: (typeof servers.$inferSelect)["config"];
  userId: string;
}) {
  const { generateKeyPairSync } = await import("node:crypto");
  const { deployments, previewEnvironments } =
    await import("@workspace/towbar-database/schema");
  const { mutateSecret } = await import("../secrets/store.js");
  const { resolveDeploymentSecrets } =
    await import("../deployments/deployment-secrets.js");
  const database = getTowbarDatabase();
  const privateKey = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  await mutateSecret(
    {
      type: "server",
      id: stage.serverId,
      workspaceId,
      environment: "production",
      stage: "credentials",
    },
    { expectedRevision: null, set: { privateKey }, delete: [] },
    userId,
  );
  const id = randomUUID();
  const previewId = randomUUID();
  await database.insert(previewEnvironments).values({
    id: previewId,
    sourceId,
    workspaceId,
    appId: stage.id,
    serverId: stage.serverId,
    pullRequestNumber: 23,
    branch: "feature",
    gitRef: "refs/pull/23/head",
    hostname: "preview.example.com",
    runtimeId: previewId,
    latestCommitSha: "c".repeat(40),
    expiresAt: new Date(Date.now() + 3600000),
  });
  await database.insert(deployments).values({
    targetEnvironment: await testDeploymentEnvironment(stage.id),
    id,
    sourceId,
    workspaceId,
    appId: stage.id,
    serverId: stage.serverId,
    idempotencyKey: id,
    temporalWorkflowId: id,
    commitSha: "c".repeat(40),
    manifestDigest: "test",
    environment: "preview",
    previewEnvironmentId: previewId,
    gitRef: "refs/pull/23/head",
    hostname: "preview.example.com",
    appSnapshot: stage.config,
    serverSnapshot: config,
    requiredSecrets: {
      runtime: ["EMPTY"],
      build: [],
      preDeploy: [],
      postDeploy: [],
    },
  });
  try {
    await assert.rejects(
      database.execute(
        sql`update towbar_deployments set required_secrets = null where id = ${id}`,
      ),
      (error: unknown) =>
        (error as { cause?: { code?: string } }).cause?.code === "23502",
    );
    await assert.rejects(
      resolveDeploymentSecrets(id),
      /Required secrets missing for deployment/,
    );
    await mutateSecret(
      {
        type: "app",
        id: stage.id,
        workspaceId,
        environment: "preview:staging",
        stage: "deployment",
      },
      { expectedRevision: null, set: { EMPTY: "" }, delete: [] },
      userId,
    );
    assert.deepEqual((await resolveDeploymentSecrets(id)).runtime, {
      EMPTY: "",
    });
    await database
      .update(deployments)
      .set({
        requiredSecrets: {
          runtime: ["PR_ONLY"],
          build: [],
          preDeploy: [],
          postDeploy: [],
        },
      })
      .where(eq(deployments.id, id));
    await assert.rejects(resolveDeploymentSecrets(id), /PR_ONLY/);
    const { recordPreviewCleanupResult, getPreviewCleanupContext } =
      await import("../previews/cleanup.js");
    await database
      .update(previewEnvironments)
      .set({ status: "healthy", cleanupAttempts: 1 })
      .where(eq(previewEnvironments.id, previewId));
    assert.deepEqual(
      await recordPreviewCleanupResult(previewId, {
        cleanupAttempt: 1,
        succeeded: true,
      }),
      { accepted: false },
    );
    await assert.rejects(
      getPreviewCleanupContext(previewId),
      /not awaiting cleanup/,
    );
    await database
      .update(previewEnvironments)
      .set({
        status: "deleting",
        cleanupAttempts: 2,
        cleanupRequestedByActor: {
          kind: "session",
          userId,
          workspaceId,
          grants: ["admin"],
        },
      })
      .where(eq(previewEnvironments.id, previewId));
    assert.equal((await getPreviewCleanupContext(previewId)).cleanupAttempt, 2);
    assert.deepEqual(
      await recordPreviewCleanupResult(previewId, {
        cleanupAttempt: 1,
        succeeded: true,
      }),
      { accepted: false },
    );
    const [unchanged] = await database
      .select()
      .from(previewEnvironments)
      .where(eq(previewEnvironments.id, previewId));
    assert.equal(unchanged!.status, "deleting");
    assert.deepEqual(
      await recordPreviewCleanupResult(previewId, {
        cleanupAttempt: 2,
        succeeded: false,
        errorMessage: "test failure",
      }),
      { accepted: true },
    );
    assert.deepEqual(
      await recordPreviewCleanupResult(previewId, {
        cleanupAttempt: 2,
        succeeded: true,
      }),
      { accepted: false },
    );
  } finally {
    await database.delete(deployments).where(eq(deployments.id, id));
    await database
      .delete(previewEnvironments)
      .where(eq(previewEnvironments.id, previewId));
  }
}

export async function assertEnvironmentManifestSnapshots(input: {
  sourceId: string;
  workspaceId: string;
  productionId: string;
  stagingId: string;
}) {
  const { getEnvironmentManifest } = await import("./environments.js");
  const production = await getEnvironmentManifest({
    ...input,
    environmentId: input.productionId,
  });
  const staging = await getEnvironmentManifest({
    ...input,
    environmentId: input.stagingId,
  });
  assert.equal(production?.commitSha, "a".repeat(40));
  assert.equal(staging?.commitSha, "b".repeat(40));
  assert.deepEqual(
    staging?.files.map((file) => file.path),
    ["towbar.yml", ".towbar/services/site.service.yml"],
  );
  assert.match(staging!.files[0]!.content, /version: 2/);
  await assert.rejects(
    getEnvironmentManifest({
      ...input,
      environmentId: input.stagingId,
      workspaceId: randomUUID(),
    }),
    /Source/,
  );
}
