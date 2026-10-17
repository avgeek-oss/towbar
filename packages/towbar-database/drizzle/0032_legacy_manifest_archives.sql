ALTER TABLE "towbar_apps" ADD COLUMN "legacy_archived_at" timestamptz;
--> statement-breakpoint
-- v2.0.50 preserved pre-lifecycle archive timestamps in retired_at.
-- Only timestamps predating the first lifecycle migration prove this origin.
UPDATE towbar_apps SET legacy_archived_at = retired_at
WHERE retired_at < to_timestamp(1792200000000 / 1000.0);
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('pg_temp.towbar_legacy_archives') IS NOT NULL THEN
    UPDATE towbar_apps a SET legacy_archived_at = legacy.archived_at
    FROM pg_temp.towbar_legacy_archives legacy WHERE legacy.id = a.id;
  END IF;
END $$;
--> statement-breakpoint
-- Restore only a unique, unchanged declaration's existing owner. Ambiguous
-- declarations and live duplicates remain conflicts for reconciliation.
CREATE TEMP TABLE towbar_legacy_manifest_owners ON COMMIT DROP AS
WITH declarations AS (
  SELECT m.workspace_id, e.name AS environment, e.id AS environment_id,
         e.source_id, config
  FROM towbar_repository_manifests m
  JOIN towbar_source_environments e ON e.id = m.source_environment_id
  CROSS JOIN LATERAL jsonb_array_elements(
    coalesce(m.manifest->'apps', '[]'::jsonb) ||
    coalesce(m.manifest->'compose', '[]'::jsonb) ||
    coalesce(m.manifest->'resources', '[]'::jsonb)
  ) AS config
), unique_declarations AS (
  SELECT workspace_id, environment, config->>'id' AS manifest_id
  FROM declarations GROUP BY workspace_id, environment, config->>'id'
  HAVING count(*) = 1
)
SELECT a.id, a.workspace_id, a.manifest_id, e.name AS environment
FROM towbar_apps a
JOIN towbar_source_environments e ON e.id = a.source_environment_id
JOIN declarations d ON d.environment_id = a.source_environment_id
  AND d.source_id = a.source_id AND d.config = a.config
JOIN unique_declarations u ON u.workspace_id = a.workspace_id
  AND u.environment = e.name AND u.manifest_id = a.manifest_id
WHERE a.legacy_archived_at IS NULL AND a.manifest_state = 'conflict'
  AND a.archived_at IS NULL
  AND EXISTS (
    SELECT 1 FROM towbar_apps legacy
    JOIN towbar_source_environments le ON le.id = legacy.source_environment_id
    WHERE legacy.workspace_id = a.workspace_id AND le.name = e.name
      AND legacy.manifest_id = a.manifest_id AND legacy.legacy_archived_at IS NOT NULL
      AND legacy.manifest_state <> 'removed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM towbar_apps other
    JOIN towbar_source_environments oe ON oe.id = other.source_environment_id
    WHERE other.workspace_id = a.workspace_id AND oe.name = e.name
      AND other.manifest_id = a.manifest_id AND other.id <> a.id
      AND other.legacy_archived_at IS NULL AND other.manifest_state <> 'removed'
  );
--> statement-breakpoint
UPDATE towbar_apps legacy SET manifest_state = 'retired'
FROM towbar_legacy_manifest_owners owner, towbar_source_environments e
WHERE legacy.workspace_id = owner.workspace_id
  AND legacy.manifest_id = owner.manifest_id
  AND legacy.source_environment_id = e.id AND e.name = owner.environment
  AND legacy.legacy_archived_at IS NOT NULL AND legacy.manifest_state = 'conflict';
--> statement-breakpoint
UPDATE towbar_apps a SET manifest_state = 'active'
FROM towbar_legacy_manifest_owners owner WHERE owner.id = a.id;
