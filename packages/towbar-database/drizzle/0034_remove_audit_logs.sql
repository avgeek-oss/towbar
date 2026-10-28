ALTER TABLE "towbar_servers" ADD COLUMN "last_removed_at" timestamptz;
--> statement-breakpoint
UPDATE "towbar_servers" AS server
SET "last_removed_at" = removed."at"
FROM (
  SELECT "workspace_id", "target_id", max("created_at") AS "at"
  FROM "towbar_audit_events"
  WHERE "action" = 'server.removed' AND "target_type" = 'server'
  GROUP BY "workspace_id", "target_id"
) AS removed
WHERE server."workspace_id" = removed."workspace_id"
  AND server."id"::text = removed."target_id";
--> statement-breakpoint
DROP TABLE "towbar_audit_events";
