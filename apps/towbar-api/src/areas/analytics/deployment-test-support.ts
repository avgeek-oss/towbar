import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type NormalizedApp,
  normalizeServerConfiguration,
} from "@workspace/towbar-core";
import {
  apps,
  deployments,
  previewEnvironments,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";
import { testDeploymentEnvironment } from "../sources/instance-test-helper.js";
import { getAnalyticsConfiguration, getAnalyticsReport } from "./service.js";

export async function verifyAnalyticsDeploymentMarkers({
  appId,
  workspaceId,
  serverId,
  sourceId,
  config,
}: {
  appId: string;
  workspaceId: string;
  serverId: string;
  sourceId: string;
  config: NormalizedApp;
}) {
  const db = getTowbarDatabase();
  const deploymentId = randomUUID();
  const previewId = randomUUID();
  await db.insert(previewEnvironments).values({
    id: previewId,
    workspaceId,
    sourceId,
    appId,
    serverId,
    pullRequestNumber: 1,
    branch: "preview",
    gitRef: "refs/pull/1/head",
    hostname: "pr-1.example.com",
    runtimeId: previewId,
    latestCommitSha: "abcdef0",
    expiresAt: new Date(Date.now() + 86400_000),
  });
  const deployment = {
    workspaceId,
    sourceId,
    appId,
    serverId,
    targetEnvironment: await testDeploymentEnvironment(appId),
    requiredSecrets: {
      build: [],
      runtime: [],
      preDeploy: [],
      postDeploy: [],
    },
    commitSha: "abcdef0",
    manifestDigest: "test",
    appSnapshot: config,
    serverSnapshot: normalizeServerConfiguration({
      ip: "192.0.2.200",
      ssh: { username: "deploy" },
    }),
  };
  for (const [index, age] of [
    3600_000,
    8 * 86400_000,
    -86400_000,
    1800_000,
  ].entries()) {
    const id = index === 0 ? deploymentId : randomUUID();
    await db.insert(deployments).values({
      ...deployment,
      id,
      idempotencyKey: id,
      temporalWorkflowId: id,
      state: "succeeded",
      createdAt: new Date(Date.now() - age),
      ...(index === 3
        ? {
            environment: "preview" as const,
            previewEnvironmentId: previewId,
            gitRef: "refs/pull/1/head",
            hostname: "pr-1.example.com",
          }
        : {}),
    });
  }
  const report = await getAnalyticsReport({
    appId,
    workspaceId,
    days: 7,
    kind: "request",
  });
  assert.deepEqual(
    report.deployments.map((event) => event.id),
    [deploymentId],
  );
  assert.equal(report.deployments[0]?.type, "deployment");
  for (const kind of ["request", "pageview"] as const) {
    const filtered = await getAnalyticsReport({
      appId,
      workspaceId,
      days: 7,
      kind,
      filters: [{ field: "path", operator: "equals", value: "/no-traffic" }],
    });
    assert.deepEqual(
      filtered.deployments,
      report.deployments,
      "markers describe deployments, independently of traffic mode or path filters",
    );
  }
  const { getDeploymentEvents } =
    await import("../monitoring/deployment-events.js");
  const markerScope = {
    workspaceId,
    serverId,
    deployableId: appId,
    start: new Date(report.start),
    end: new Date(report.end),
    limit: 20,
  };
  assert.deepEqual(
    await getDeploymentEvents(db, {
      ...markerScope,
      workspaceId: randomUUID(),
    }),
    [],
  );
  assert.deepEqual(
    await getDeploymentEvents(db, {
      ...markerScope,
      deployableId: randomUUID(),
    }),
    [],
  );
  const markerRows = Array.from({ length: 21 }, (_, index) => {
    const id = randomUUID();
    return {
      ...deployment,
      id,
      idempotencyKey: id,
      temporalWorkflowId: id,
      createdAt: new Date(Date.now() - 60_000 - index * 1000),
    };
  });
  await db.insert(deployments).values(markerRows);
  const capped = await getAnalyticsReport({
    appId,
    workspaceId,
    days: 7,
    kind: "request",
  });
  assert.equal(capped.deployments.length, 20);
  assert.deepEqual(
    capped.deployments.map((event) => event.id),
    markerRows.slice(0, 20).map((row) => row.id),
  );
}

export async function verifyAnalyticsProxyConfiguration({
  appId,
  serverId,
  config,
}: {
  appId: string;
  serverId: string;
  config: NormalizedApp;
}) {
  const db = getTowbarDatabase();
  for (const [tls, proxied] of [
    [{ mode: "cloudflare-dns" }, true],
    [{ mode: "cloudflare-dns", proxied: false }, false],
    [{ mode: "direct" }, false],
  ] as const) {
    await db
      .update(apps)
      .set({ config: { ...config, tls } })
      .where(eq(apps.id, appId));
    assert.equal(
      (await getAnalyticsConfiguration(serverId)).services.find(
        ({ id }) => id === appId,
      )?.cloudflareProxy,
      proxied,
    );
  }
  await db.update(apps).set({ config }).where(eq(apps.id, appId));
}
