import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  apps,
  auditEvents,
  managedSecrets,
  sources,
} from "@workspace/towbar-database/schema";
import {
  listEnvironmentSecrets,
  resolveEnvironmentStage,
} from "../apps/secrets.js";
import { mutateSecret, readSecretMetadata, readSecretValues } from "./store.js";
import { testInstanceLinks } from "../sources/instance-test-helper.js";
import { createSecretTestEnvironment } from "./execution-tests.js";
import type { TestContext } from "node:test";
import type { Hono } from "hono";
import type { TowbarHonoEnvironment } from "../../http/types.js";
import type { getTowbarDatabase } from "../../infrastructure/database.js";

export async function testRepositorySecrets({
  t,
  db,
  api,
  workspaceId,
  otherWorkspaceId,
  actorUserId,
  sourceId,
  appId,
  setRole,
  setWorkspace,
}: {
  t: TestContext;
  db: ReturnType<typeof getTowbarDatabase>;
  api: Hono<TowbarHonoEnvironment>;
  workspaceId: string;
  otherWorkspaceId: string;
  actorUserId: string;
  sourceId: string;
  appId: string;
  setRole: (role: "admin" | "member" | "viewer") => void;
  setWorkspace: (workspace: string) => void;
}) {
  const repositorySlot = {
    type: "repository" as const,
    id: sourceId,
    workspaceId,
    environment: "production",
    stage: "deployment",
  };
  const localSlot = { ...repositorySlot, type: "app" as const, id: appId };
  const route = `/sources/${sourceId}/secrets`;
  const patch = (path: string, body: unknown) =>
    api.request(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const reveal = () =>
    api.request(`${route}/production/deployment/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "TOKEN" }),
    });
  await t.test(
    "repository stores are versioned, encrypted, stage-specific and shared across environments",
    async () => {
      const initial = await api.request(`${route}?environment=staging`);
      assert.equal(initial.status, 200);
      const initialBody = (await initial.json()) as {
        environments: string[];
        bindings: unknown[];
      };
      assert.deepEqual(initialBody.environments, ["production"]);
      assert.equal(initialBody.bindings.length, 4);
      const saved = await patch(`${route}/preview/deployment`, {
        expectedRevision: null,
        set: { TOKEN: "repository-token", UNUSED: "not-injected" },
      });
      assert.equal(saved.status, 200);
      assert(!JSON.stringify(await saved.json()).includes("repository-token"));
      assert.equal(
        (
          await patch(`${route}/production/deployment`, {
            expectedRevision: null,
            set: { TOKEN: "stale" },
          })
        ).status,
        409,
      );
      const stored = await db
        .select()
        .from(managedSecrets)
        .where(eq(managedSecrets.owner, `repository:${sourceId}`));
      assert.equal(stored.length, 1);
      assert(!JSON.stringify(stored).includes("repository-token"));
      const current = await readSecretMetadata(repositorySlot);
      for (const expression of ["{{globals.TOKEN}}", "{{repo.TOKEN}}"]) {
        assert.equal(
          (
            await patch(`${route}/production/deployment`, {
              expectedRevision: current.revision,
              set: { TOKEN: expression },
            })
          ).status,
          422,
        );
      }
      assert.deepEqual(
        (await readSecretValues({ ...repositorySlot, stage: "build" })).values,
        {},
      );
      const original = await readSecretValues(localSlot);
      try {
        await mutateSecret(
          localSlot,
          {
            expectedRevision: original.revision,
            set: { TOKEN: "{{repo.TOKEN}}" },
            delete: [],
          },
          actorUserId,
        );
        const resolved = await resolveEnvironmentStage({
          workspaceId,
          sourceId: randomUUID(),
          appId,
          environment: "production",
          stage: "deployment",
        });
        assert.equal(resolved.values.TOKEN, "repository-token");
        assert.equal(resolved.values.UNUSED, undefined);
        assert.equal(
          resolved.revisions["deployment:repository"],
          current.revision,
        );
        const [runtime] = (
          await listEnvironmentSecrets(
            { type: "app", id: appId, workspaceId },
            "production",
          )
        ).filter((binding) => binding.stage === "deployment");
        assert.deepEqual(runtime?.availableReferences.repo, [
          "TOKEN",
          "UNUSED",
        ]);
        assert.equal(runtime?.repositoryId, sourceId);
        await mutateSecret(
          { ...localSlot, environment: "preview:production" },
          {
            expectedRevision: null,
            set: { TOKEN: "{{repo.TOKEN}}" },
            delete: [],
          },
          actorUserId,
        );
        const preview = await resolveEnvironmentStage({
          workspaceId,
          sourceId,
          appId,
          environment: "preview:production",
          stage: "deployment",
        });
        assert.equal(preview.values.TOKEN, "repository-token");
        await db
          .delete(managedSecrets)
          .where(eq(managedSecrets.owner, `app:${appId}`));
        // Restore all original slots before the remaining lifecycle suite runs.
        await mutateSecret(
          localSlot,
          { expectedRevision: null, set: original.values, delete: [] },
          actorUserId,
        );
      } finally {
        const currentLocal = await readSecretValues(localSlot);
        if (currentLocal.values.TOKEN !== original.values.TOKEN)
          await mutateSecret(
            localSlot,
            {
              expectedRevision: currentLocal.revision,
              set: original.values,
              delete: [],
            },
            actorUserId,
          );
      }
    },
  );
  await t.test(
    "repository access follows roles, workspace boundaries, and fresh admin reveal",
    async () => {
      try {
        setRole("viewer");
        assert.equal((await api.request(route)).status, 403);
        assert.equal(
          (
            await patch(`${route}/production/deployment`, {
              expectedRevision: (await readSecretMetadata(repositorySlot))
                .revision,
              set: { TOKEN: "no" },
            })
          ).status,
          403,
        );
        setRole("member");
        assert.equal((await api.request(route)).status, 200);
        assert.equal((await reveal()).status, 403);
        const metadata = await readSecretMetadata(repositorySlot);
        assert.equal(
          (
            await patch(`${route}/production/deployment`, {
              expectedRevision: metadata.revision,
              set: { MEMBER: "member-value" },
            })
          ).status,
          200,
        );
        setRole("admin");
        setWorkspace(otherWorkspaceId);
        assert.equal((await api.request(route)).status, 404);
        assert.equal((await reveal()).status, 404);
        setWorkspace(workspaceId);
        const response = await reveal();
        assert.equal(response.status, 200);
        assert.match(response.headers.get("cache-control") ?? "", /no-store/);
        assert.equal(
          ((await response.json()) as { value: string }).value,
          "repository-token",
        );
        const audits = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.targetId, `repository:${sourceId}`));
        assert(audits.some((event) => event.action === "secrets.revealed"));
        assert(!JSON.stringify(audits).includes("repository-token"));
        // Existing bulk-reveal tests assert their own audit counts.
        await db
          .delete(auditEvents)
          .where(eq(auditEvents.targetId, `repository:${sourceId}`));
      } finally {
        setRole("admin");
        setWorkspace(workspaceId);
      }
    },
  );
  await t.test(
    "ownership transfer resolves the destination repository and never falls back to the old store",
    async () => {
      const [source] = await db
        .select()
        .from(sources)
        .where(eq(sources.id, sourceId));
      const [app] = await db.select().from(apps).where(eq(apps.id, appId));
      assert(source && app);
      const destinationId = randomUUID();
      await db.insert(sources).values({
        id: destinationId,
        workspaceId,
        integrationInstallationId: source.integrationInstallationId,
        repositoryOwner: "test",
        repositoryName: destinationId,
      });
      const destinationEnvironment = await createSecretTestEnvironment(
        db,
        destinationId,
      );
      const original = await readSecretValues(localSlot);
      try {
        await mutateSecret(
          localSlot,
          {
            expectedRevision: original.revision,
            set: { TOKEN: "{{repo.TOKEN}}" },
            delete: [],
          },
          actorUserId,
        );
        const links = await testInstanceLinks(destinationId, app.manifestId);
        await db
          .update(apps)
          .set({
            ...links,
            requiredSecrets: app.requiredSecrets,
            sourceId: destinationId,
            sourceEnvironmentId: destinationEnvironment!.id,
          })
          .where(eq(apps.id, appId));
        await assert.rejects(
          resolveEnvironmentStage({
            workspaceId,
            sourceId,
            appId,
            environment: "production",
            stage: "deployment",
          }),
          /unavailable repo reference/,
        );
        await mutateSecret(
          { ...repositorySlot, id: destinationId },
          {
            expectedRevision: null,
            set: { TOKEN: "destination-value" },
            delete: [],
          },
          actorUserId,
        );
        const transferred = await resolveEnvironmentStage({
          workspaceId,
          sourceId,
          appId,
          environment: "production",
          stage: "deployment",
        });
        assert.equal(transferred.values.TOKEN, "destination-value");
        assert.equal(
          (await readSecretValues(repositorySlot)).values.TOKEN,
          "repository-token",
        );
      } finally {
        await db
          .update(apps)
          .set({
            sourceId,
            entityId: app.entityId,
            sourceEnvironmentId: app.sourceEnvironmentId,
          })
          .where(eq(apps.id, appId));
        await mutateSecret(
          localSlot,
          {
            expectedRevision: (await readSecretMetadata(localSlot)).revision,
            set: original.values,
            delete: [],
          },
          actorUserId,
        );
        await db.delete(sources).where(eq(sources.id, destinationId));
      }
    },
  );
}
