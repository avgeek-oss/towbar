DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'towbar_deployments', 'towbar_source_syncs', 'towbar_resource_operations',
    'towbar_server_checks', 'towbar_server_preparations',
    'towbar_server_credential_verifications', 'towbar_image_vulnerability_scans',
    'towbar_preview_environments', 'towbar_upgrade_leases'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS towbar_upgrade_guard ON public.%I', target);
  END LOOP;
END $$;
--> statement-breakpoint
DROP VIEW public.towbar_upgrade_blockers;
DROP FUNCTION public.towbar_check_upgrade_admission();
DROP TABLE public.towbar_upgrade_leases;
DROP TABLE public.towbar_upgrade_admission;
--> statement-breakpoint
UPDATE public.towbar_sources
SET status = 'archived', auto_deploy_paused = true,
    archived_at = coalesce(archived_at, now()), updated_at = now()
WHERE provider = 'gitlab';
UPDATE public.towbar_source_environments
SET auto_deploy_paused = true, previews_enabled = false,
    disconnected_at = coalesce(disconnected_at, now()), updated_at = now()
WHERE source_id IN (SELECT id FROM public.towbar_sources WHERE provider = 'gitlab');
UPDATE public.towbar_integration_authorizations
SET disconnected_at = coalesce(disconnected_at, now()), encrypted_payload = NULL, updated_at = now()
WHERE provider = 'gitlab';
DROP TABLE public.towbar_integration_authorization_attempts;
UPDATE public.towbar_notification_deliveries
SET state = 'failed', next_attempt_at = NULL,
    last_error_code = 'PROVIDER_REMOVED', last_error_message = 'This notification provider is no longer supported.', updated_at = now()
WHERE provider IN ('discord', 'telegram') AND state IN ('pending', 'delivering', 'retrying');
DROP TABLE public.towbar_notification_discord_route_settings;
DROP TABLE public.towbar_notification_telegram_destinations;
DROP TABLE public.towbar_notification_telegram_routing;
--> statement-breakpoint
ALTER TABLE public.towbar_sources DROP CONSTRAINT towbar_source_provider_connection;
ALTER TABLE public.towbar_sources ADD CONSTRAINT towbar_source_provider_connection
CHECK (status = 'archived' OR (provider = 'github' AND integration_installation_id IS NOT NULL AND integration_authorization_id IS NULL));
