import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { managedSecrets } from "@workspace/towbar-database/schema";
import { validateSecretReferences } from "@workspace/towbar-core";
import {
  listEnvironmentSecrets,
  resolveEnvironmentStage,
} from "../apps/secrets.js";
import { mutateSecret, readSecretMetadata } from "./store.js";
import type { TestContext } from "node:test";
import type { getTowbarDatabase } from "../../infrastructure/database.js";
import type { SecretOwner, SecretSlot } from "./store.js";

export async function testManagedSecretInheritance({
  t,
  db,
  workspaceId,
  actorUserId,
  sourceId,
  appId,
  appOwner,
  globalSlot,
  slot,
}: {
  t: TestContext;
  db: ReturnType<typeof getTowbarDatabase>;
  workspaceId: string;
  actorUserId: string;
  sourceId: string;
  appId: string;
  appOwner: Extract<SecretOwner, { type: "app" }>;
  globalSlot: SecretSlot;
  slot: SecretSlot;
}) {
  await t.test(
    "encrypted storage, global references, and versioned writes",
    async () => {
      await mutateSecret(
        globalSlot,
        {
          expectedRevision: null,
          set: {
            TOKEN: "global-value",
            GLOBAL_ONLY: "global-only",
            GLOBAL_PREVIEW: "global-preview",
            AD_HOC: "not-declared-in-yaml",
          },
          delete: [],
        },
        actorUserId,
      );
      const saved = await mutateSecret(
        slot,
        {
          expectedRevision: null,
          set: {
            TOKEN: "local-value",
            MULTILINE: "line one\nline two",
            EMPTY: "",
          },
          delete: [],
        },
        actorUserId,
      );
      assert(!JSON.stringify(saved).includes("local-value"));
      const result = await resolveEnvironmentStage({
        workspaceId,
        sourceId,
        appId,
        environment: "production",
        stage: "deployment",
      });
      assert.equal(result.values.TOKEN, "local-value");
      assert.equal(result.values.GLOBAL_ONLY, undefined);
      const appBinding = (
        await listEnvironmentSecrets(appOwner, "production")
      ).find((binding) => binding.stage === "deployment");
      assert(appBinding);
      assert.deepEqual(appBinding.inheritedKeys, []);
      assert.deepEqual(appBinding.availableReferences, {
        globals: ["AD_HOC", "GLOBAL_ONLY", "GLOBAL_PREVIEW", "TOKEN"],
        repo: [],
      });
      const global = await readSecretMetadata(globalSlot);
      await mutateSecret(
        globalSlot,
        {
          expectedRevision: global.revision,
          set: {},
          delete: ["AD_HOC"],
        },
        actorUserId,
      );
      const [stored] = await db
        .select()
        .from(managedSecrets)
        .where(eq(managedSecrets.owner, `app:${appId}`));
      assert(stored);
      assert(!JSON.stringify(stored).includes("local-value"));
      const cleared = await mutateSecret(
        slot,
        { expectedRevision: saved.revision, set: {}, delete: ["TOKEN"] },
        actorUserId,
      );
      assert.equal(
        (
          await resolveEnvironmentStage({
            workspaceId,
            sourceId,
            appId,
            environment: "production",
            stage: "deployment",
          })
        ).values.TOKEN,
        undefined,
      );
      assert((await readSecretMetadata(slot)).missingKeys.includes("TOKEN"));
      const restored = await mutateSecret(
        slot,
        {
          expectedRevision: cleared.revision,
          set: { TOKEN: "local-value" },
          delete: [],
        },
        actorUserId,
      );
      await mutateSecret(
        slot,
        {
          expectedRevision: restored.revision,
          set: {
            TOKEN: "{{globals.TOKEN}}",
            GLOBAL_ONLY: "{{globals.GLOBAL_ONLY}}",
          },
          delete: [],
        },
        actorUserId,
      );
      const explicit = await resolveEnvironmentStage({
        workspaceId,
        sourceId,
        appId,
        environment: "production",
        stage: "deployment",
      });
      assert.equal(explicit.values.TOKEN, "global-value");
      assert.equal(explicit.values.GLOBAL_ONLY, "global-only");
      await assert.rejects(
        mutateSecret(
          slot,
          {
            expectedRevision: saved.revision,
            set: { TOKEN: "stale" },
            delete: [],
          },
          actorUserId,
        ),
        /changed after loading/u,
      );
      await assert.rejects(
        mutateSecret(
          slot,
          {
            expectedRevision: (await readSecretMetadata(slot)).revision,
            set: { TOKEN: "{{source.TOKEN}}" },
            delete: [],
          },
          actorUserId,
          (values) => validateSecretReferences(values, "app"),
        ),
        /invalid reference/u,
      );
    },
  );

  await t.test("environment and hook stages remain isolated", async () => {
    await mutateSecret(
      { ...globalSlot, stage: "pre_deploy" },
      {
        expectedRevision: null,
        set: { MIGRATION: "production-only" },
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
    assert.deepEqual(preview.values, {});
    assert.deepEqual(
      (
        await resolveEnvironmentStage({
          workspaceId,
          sourceId,
          appId,
          environment: "preview:production",
          stage: "pre_deploy",
        })
      ).values,
      {},
    );
    assert.equal(
      (
        await resolveEnvironmentStage({
          workspaceId,
          sourceId,
          appId,
          environment: "production",
          stage: "post_deploy",
        })
      ).values.MIGRATION,
      undefined,
    );
  });
}
