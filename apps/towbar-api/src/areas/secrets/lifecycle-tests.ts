import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  apps,
  deployments,
  managedSecrets,
  releases,
} from "@workspace/towbar-database/schema";
import type { normalizeServerConfiguration } from "@workspace/towbar-core";
import type { TestContext } from "node:test";
import type { getTowbarDatabase } from "../../infrastructure/database.js";
import { createServer, updateServer } from "../servers/lifecycle.js";
import {
  type SecretSlot,
  readSecretMetadata,
  readSecretValues,
} from "./store.js";

export async function testSecretLifecycle({
  t,
  db,
  appId,
  workspaceId,
  otherWorkspaceId,
  serverId,
  serverConfig,
  slot,
}: {
  t: TestContext;
  db: ReturnType<typeof getTowbarDatabase>;
  appId: string;
  workspaceId: string;
  otherWorkspaceId: string;
  serverId: string;
  serverConfig: ReturnType<typeof normalizeServerConfiguration>;
  slot: SecretSlot;
}) {
  await t.test(
    "archival and restoration preserve stored secrets; tampering fails closed; deletion cascades",
    async () => {
      await db
        .update(apps)
        .set({ archivedAt: new Date() })
        .where(and(eq(apps.id, appId), eq(apps.workspaceId, workspaceId)));
      const retained = await readSecretValues(slot);
      assert.equal(retained.values.MULTILINE, "line one\nline two");
      await db
        .update(apps)
        .set({ archivedAt: null, name: "Renamed" })
        .where(and(eq(apps.id, appId), eq(apps.workspaceId, workspaceId)));
      assert.equal(
        (await readSecretValues(slot)).values.MULTILINE,
        "line one\nline two",
      );
      assert.equal(
        (
          await updateServer({
            config: { ...serverConfig, buildConcurrency: 2 },
            serverId,
            workspaceId,
          })
        ).id,
        serverId,
      );
      assert.match(
        (
          await db
            .select({ deploymentDigest: apps.deploymentDigest })
            .from(apps)
            .where(eq(apps.id, appId))
            .limit(1)
        )[0]!.deploymentDigest!,
        /^[a-f0-9]{64}$/u,
      );
      const newServer = await createServer({
        config: { ...serverConfig, ip: "192.0.2.11" },
        workspaceId,
      });
      assert.equal(
        (
          await readSecretMetadata({
            type: "server",
            id: newServer.id,
            workspaceId,
            environment: "production",
            stage: "credentials",
          })
        ).revision,
        null,
      );
      assert.equal((await readSecretValues(slot)).revision, retained.revision);
      const [row] = await db
        .select()
        .from(managedSecrets)
        .where(
          and(
            eq(managedSecrets.owner, `app:${appId}`),
            eq(managedSecrets.stage, "deployment"),
            eq(managedSecrets.environment, "production"),
          ),
        );
      assert(row);
      // Database ownership cannot be reassigned across a workspace even by a direct write.
      await assert.rejects(
        db
          .update(managedSecrets)
          .set({ workspaceId: otherWorkspaceId })
          .where(eq(managedSecrets.id, row.id)),
      );
      const [another] = await db
        .select()
        .from(managedSecrets)
        .where(
          and(
            eq(managedSecrets.owner, `workspace:${workspaceId}`),
            eq(managedSecrets.stage, "deployment"),
          ),
        );
      assert(another);
      await db
        .update(managedSecrets)
        .set({ encryptedPayload: another.encryptedPayload })
        .where(eq(managedSecrets.id, row.id));
      await assert.rejects(readSecretValues(slot), /could not be unlocked/u);
      await db
        .update(managedSecrets)
        .set({ encryptedPayload: row.encryptedPayload })
        .where(eq(managedSecrets.id, row.id));
      await db
        .update(managedSecrets)
        .set({
          encryptedPayload: {
            ...row.encryptedPayload,
            authenticationTag: randomBytes(16).toString("base64url"),
          },
        })
        .where(eq(managedSecrets.id, row.id));
      await assert.rejects(readSecretValues(slot), /could not be unlocked/u);
      await db.delete(releases).where(eq(releases.appId, appId));
      await db.delete(deployments).where(eq(deployments.appId, appId));
      await db.delete(apps).where(eq(apps.id, appId));
      assert.deepEqual(
        await db
          .select({ id: managedSecrets.id })
          .from(managedSecrets)
          .where(eq(managedSecrets.appId, appId)),
        [],
      );
      await assert.rejects(readSecretMetadata(slot), /requires an environment/);
    },
  );
}
