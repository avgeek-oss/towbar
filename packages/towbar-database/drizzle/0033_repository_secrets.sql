ALTER TABLE "towbar_managed_secrets" DROP CONSTRAINT "towbar_managed_secret_owner";
--> statement-breakpoint
ALTER TABLE "towbar_managed_secrets" ADD CONSTRAINT "towbar_managed_secret_owner" CHECK ((
  (owner = 'workspace:' || workspace_id::text AND source_id IS NULL AND app_id IS NULL AND server_id IS NULL)
  OR (owner = 'repository:' || source_id::text AND source_id IS NOT NULL AND app_id IS NULL AND server_id IS NULL AND environment = 'production')
  OR (owner = 'app:' || app_id::text AND app_id IS NOT NULL AND source_id IS NOT NULL AND server_id IS NULL)
  OR (owner = 'server:' || server_id::text AND server_id IS NOT NULL AND source_id IS NULL AND app_id IS NULL)
) IS TRUE);
--> statement-breakpoint
ALTER TABLE "towbar_managed_secrets" DROP CONSTRAINT "towbar_managed_secret_stage";
--> statement-breakpoint
ALTER TABLE "towbar_managed_secrets" ADD CONSTRAINT "towbar_managed_secret_stage" CHECK (
  (stage IN ('build', 'deployment', 'pre_deploy', 'post_deploy') AND (owner = 'workspace:' || workspace_id::text OR owner = 'repository:' || source_id::text OR app_id IS NOT NULL))
  OR (stage = 'credentials' AND server_id IS NOT NULL AND environment = 'production')
);
