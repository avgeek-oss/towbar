CREATE FUNCTION "towbar_revoke_mcp_on_role_change"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.role IS DISTINCT FROM NEW.role THEN
    UPDATE public.towbar_api_key_policies SET revoked_at=now(), version=version+1
      WHERE owner_user_id=OLD.user_id AND workspace_id=OLD.workspace_id
        AND token_type='mcp-oauth' AND revoked_at IS NULL;
    UPDATE public.towbar_mcp_oauth_requests SET consumed_at=now()
      WHERE user_id=OLD.user_id AND workspace_id=OLD.workspace_id AND consumed_at IS NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "towbar_revoke_mcp_on_role_change" AFTER UPDATE OF role OR DELETE ON "towbar_workspace_members"
  FOR EACH ROW EXECUTE FUNCTION "towbar_revoke_mcp_on_role_change"();
