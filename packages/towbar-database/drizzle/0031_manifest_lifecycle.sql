ALTER TABLE "towbar_apps" ADD COLUMN "manifest_state" varchar(16) NOT NULL DEFAULT 'active';
ALTER TABLE "towbar_apps" ADD COLUMN "retired_at" timestamptz;
ALTER TABLE "towbar_apps" ADD CONSTRAINT "towbar_apps_manifest_state" CHECK (manifest_state IN ('active','conflict','retired','removing','removed'));
--> statement-breakpoint
CREATE TABLE "towbar_repository_manifests" (
  "source_environment_id" uuid PRIMARY KEY REFERENCES "towbar_source_environments"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "towbar_workspaces"("id") ON DELETE CASCADE,
  "commit_sha" varchar(64) NOT NULL,
  "manifest" jsonb NOT NULL,
  "tree" jsonb,
  "paths" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "observed_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_towbar_repository_manifests_workspace" ON "towbar_repository_manifests" ("workspace_id");
--> statement-breakpoint
INSERT INTO "towbar_repository_manifests" (source_environment_id, workspace_id, commit_sha, manifest)
SELECT e.id, s.workspace_id, sy.commit_sha, sy.normalized_manifest
FROM towbar_source_environments e
JOIN towbar_sources s ON s.id = e.source_id
JOIN towbar_source_syncs sy ON sy.id = e.latest_successful_sync_id
WHERE sy.normalized_manifest IS NOT NULL AND sy.commit_sha IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "towbar_managed_secrets" DROP CONSTRAINT "fk_towbar_secret_apps_owner";
ALTER TABLE "towbar_managed_secrets" ADD CONSTRAINT "fk_towbar_secret_apps_owner"
FOREIGN KEY ("app_id", "workspace_id", "source_id") REFERENCES "towbar_apps" ("id", "workspace_id", "source_id") ON DELETE CASCADE ON UPDATE CASCADE;
--> statement-breakpoint
-- Existing archived inventory is retained for review; a missing manifest never authorizes cleanup.
UPDATE towbar_apps SET manifest_state = 'retired', retired_at = archived_at, archived_at = NULL WHERE archived_at IS NOT NULL;
-- Preserve every legacy duplicate. Git corrections must disambiguate these records.
UPDATE towbar_apps a SET manifest_state = 'conflict'
FROM towbar_source_environments e
WHERE a.source_environment_id = e.id AND EXISTS (
 SELECT 1 FROM towbar_apps other JOIN towbar_source_environments oe ON oe.id = other.source_environment_id
 WHERE other.workspace_id = a.workspace_id AND oe.name = e.name AND other.manifest_id = a.manifest_id AND other.id <> a.id
);

--> statement-breakpoint
DROP INDEX uq_towbar_apps_environment_entity;
CREATE UNIQUE INDEX uq_towbar_apps_environment_entity ON towbar_apps(source_environment_id, entity_id) WHERE manifest_state <> 'removed';
