import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { actorAllows } from "@workspace/towbar-access";
import {
  type NormalizedApp,
  digestValue,
  isNormalizedApp,
} from "@workspace/towbar-core";
import {
  apiKeyPolicies,
  apiKeys,
  apps,
  deployments,
  workspaceMembers,
} from "@workspace/towbar-database/schema";
import { getTowbarDatabase } from "../../infrastructure/database.js";

export async function assertAdminCollectorKeyAccess({
  appId,
  workspaceId,
  userId,
  config,
}: {
  appId: string;
  workspaceId: string;
  userId: string;
  config: NormalizedApp;
}) {
  const { createApiKey, findApiKey, revokeApiKey } =
    await import("../api-keys/service.js");
  const { withActor } = await import("../auth/actor-context.js");
  const { getDeploymentExecutionContext } =
    await import("../deployments/service.js");
  const { requestAppDeployment } = await import("./service.js");
  const db = getTowbarDatabase();
  await db
    .update(apps)
    .set({ config, configDigest: digestValue(config) })
    .where(eq(apps.id, appId));
  const user = {
    id: userId,
    email: `${userId}@example.test`,
    name: "Admin",
    workspaceId,
    workspaceRole: "admin" as const,
  };
  for (const access of ["read", "edit"] as const) {
    const key = await createApiKey(user, { name: `${access} scoped`, access });
    assert(key.token);
    const principal = await findApiKey(key.token);
    assert(principal);
    assert(!actorAllows(principal.actor, ["admin"]));
    await assert.rejects(
      withActor(principal.actor, () =>
        requestAppDeployment({
          appId,
          workspaceId,
          requestedBy: userId,
          idempotencyKey: randomUUID(),
        }),
      ),
      /not permitted/,
    );
  }
  const oauth = await createApiKey(user, {
    name: "OAuth consent",
    access: "edit",
    oauth: {
      clientId: "client",
      clientName: "Client",
      clientLogo: null,
      clientTrust: "unverified",
      resource: "https://app.test/v1/mcp",
      grants: ["admin"],
    },
  });
  assert(oauth.token);
  const oauthPrincipal = await findApiKey(oauth.token);
  assert(oauthPrincipal);
  assert(!actorAllows(oauthPrincipal.actor, ["admin"]));
  await assert.rejects(
    withActor(oauthPrincipal.actor, () =>
      requestAppDeployment({
        appId,
        workspaceId,
        requestedBy: userId,
        idempotencyKey: randomUUID(),
      }),
    ),
    /not permitted/,
  );
  for (const scope of ["personal", "team"] as const) {
    const key = await createApiKey(user, {
      name: `Old ${scope}`,
      access: "edit",
      scope,
      includeAdmin: true,
    });
    assert(key.token);
    const principal = await findApiKey(key.token);
    assert(principal);
    const result = await withActor(principal.actor, () =>
      requestAppDeployment({
        appId,
        workspaceId,
        requestedBy: userId,
        idempotencyKey: randomUUID(),
      }),
    );
    const [stored] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, result.deployment.id));
    assert(stored);
    const queued = stored.requestedByActor;
    assert(queued && queued.grants);
    assert(queued.grants.includes("admin"));
    assert.equal(stored.requestedByKeyId, key.key.id);
    const execution = await getDeploymentExecutionContext(result.deployment.id);
    assert(isNormalizedApp(execution.app));
    assert.equal(execution.app.container.hostLogs?.dockerJsonFiles, true);
    await db
      .update(deployments)
      .set({
        requestedByActor: {
          ...queued,
          grants: queued.grants.filter((action) => action !== "admin"),
        },
      })
      .where(eq(deployments.id, result.deployment.id));
    await assert.rejects(
      getDeploymentExecutionContext(result.deployment.id),
      /Access changed/,
    );
    await db
      .update(deployments)
      .set({ requestedByActor: queued })
      .where(eq(deployments.id, result.deployment.id));
    if (scope === "personal") {
      await db
        .update(workspaceMembers)
        .set({ role: "member" })
        .where(eq(workspaceMembers.userId, userId));
      await assert.rejects(
        getDeploymentExecutionContext(result.deployment.id),
        /Access changed/,
      );
      await db
        .update(workspaceMembers)
        .set({ role: "admin" })
        .where(eq(workspaceMembers.userId, userId));
    }
    await db
      .update(apiKeyPolicies)
      .set({ grants: ["viewer", "member"] })
      .where(eq(apiKeyPolicies.keyId, key.key.id));
    const restricted = await findApiKey(key.token);
    assert(restricted);
    assert(!actorAllows(restricted.actor, ["admin"]));
    await assert.rejects(
      withActor(restricted.actor, () =>
        requestAppDeployment({
          appId,
          workspaceId,
          requestedBy: userId,
          idempotencyKey: randomUUID(),
        }),
      ),
      /not permitted/,
    );
    await assert.rejects(
      getDeploymentExecutionContext(result.deployment.id),
      /Access changed/,
    );
    await db
      .update(apiKeyPolicies)
      .set({ grants: ["viewer", "member", "admin"] })
      .where(eq(apiKeyPolicies.keyId, key.key.id));
    const expired = await createApiKey(user, {
      name: `Expired ${scope}`,
      access: "edit",
      scope,
      includeAdmin: true,
    });
    assert(expired.token);
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date("2020-01-01") })
      .where(eq(apiKeys.id, expired.key.id));
    await db
      .update(deployments)
      .set({
        requestedByActor: { ...queued, keyId: expired.key.id },
        requestedByKeyId: expired.key.id,
      })
      .where(eq(deployments.id, result.deployment.id));
    await assert.rejects(
      getDeploymentExecutionContext(result.deployment.id),
      /no longer has access/,
    );
    assert.equal(await findApiKey(expired.token), null);
    await db
      .update(deployments)
      .set({ requestedByActor: queued, requestedByKeyId: key.key.id })
      .where(eq(deployments.id, result.deployment.id));
    await revokeApiKey(user, key.key.id, scope);
    assert.equal(await findApiKey(key.token), null);
    await assert.rejects(
      getDeploymentExecutionContext(result.deployment.id),
      /no longer has access/,
    );
  }
}
