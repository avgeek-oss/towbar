-- Narrow resource grants require new consent before using broad scopes.
UPDATE towbar_api_key_policies
SET revoked_at = COALESCE(revoked_at, now())
WHERE permission_mode = 'scoped';
--> statement-breakpoint
UPDATE towbar_api_key_policies
SET grants = CASE WHEN permission_mode = 'full-admin'
  THEN '["viewer", "member", "admin"]'::jsonb ELSE '[]'::jsonb END;
--> statement-breakpoint
ALTER TABLE towbar_api_key_policies
  DROP CONSTRAINT towbar_api_policy_permission_mode,
  DROP COLUMN permission_mode;
--> statement-breakpoint
ALTER TABLE towbar_api_key_policies
  ADD CONSTRAINT towbar_api_policy_scopes CHECK (
    jsonb_typeof(grants) = 'array' AND grants <@ '["viewer", "member", "admin"]'::jsonb
  );
--> statement-breakpoint
UPDATE towbar_mcp_oauth_requests
SET consumed_at = COALESCE(consumed_at, now()), code_hash = NULL,
    expires_at = LEAST(expires_at, now()), grants = NULL
WHERE scope LIKE 'mcp:%';
