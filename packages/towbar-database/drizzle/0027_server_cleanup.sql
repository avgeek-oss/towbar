ALTER TABLE "towbar_releases" ADD COLUMN "retired_at" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER towbar_require_active_server BEFORE INSERT ON towbar_resource_operations
FOR EACH ROW WHEN (NEW.type <> 'cleanup_orphans' OR NEW.state <> 'failed')
EXECUTE FUNCTION towbar_require_active_server();
