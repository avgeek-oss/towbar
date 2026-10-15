CREATE TABLE "towbar_log_collectors" (
 "server_id" uuid PRIMARY KEY REFERENCES "towbar_servers"("id") ON DELETE CASCADE,
 "generation" uuid NOT NULL DEFAULT gen_random_uuid(),
 "desired_state" varchar(20) NOT NULL DEFAULT 'disabled',
 "status" varchar(20) NOT NULL DEFAULT 'disabled',
 "token_hash" varchar(64), "encrypted_token" jsonb, "requested_by_actor" jsonb,
 "installed_version" varchar(64),
 "last_report_at" timestamptz, "last_ingested_at" timestamptz, "error_message" text,
 "supported_containers" integer NOT NULL DEFAULT 0,
 "unsupported_containers" integer NOT NULL DEFAULT 0,
 "queue_bytes" bigint NOT NULL DEFAULT 0, "dropped_records" bigint NOT NULL DEFAULT 0,
 "ingest_window" timestamptz, "ingest_bytes" integer NOT NULL DEFAULT 0,
 "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT "towbar_log_collector_desired_state" CHECK ("desired_state" IN ('enabled','disabled')),
 CONSTRAINT "towbar_log_collector_status" CHECK ("status" IN ('disabled','queued','installing','waiting','collecting','failed'))
);
--> statement-breakpoint
CREATE TABLE "towbar_log_sources" (
 "workspace_id" uuid NOT NULL REFERENCES "towbar_workspaces"("id") ON DELETE CASCADE,
 "server_id" uuid NOT NULL, "container_id" varchar(64) NOT NULL,
 "workload_id" uuid NOT NULL, "workload_name" varchar(120) NOT NULL,
 "deployment_id" uuid, "preview_id" uuid, "service" varchar(128) NOT NULL DEFAULT '',
 "last_seen_at" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY ("workspace_id", "server_id", "container_id")
);
--> statement-breakpoint
CREATE INDEX "towbar_log_source_workload" ON "towbar_log_sources" ("workspace_id", "workload_id");
--> statement-breakpoint
CREATE TABLE "towbar_log_policies" (
 "workspace_id" uuid NOT NULL REFERENCES "towbar_workspaces"("id") ON DELETE CASCADE,
 "workload_id" uuid NOT NULL, "restricted" boolean NOT NULL DEFAULT true,
 "updated_at" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY ("workspace_id", "workload_id")
);

--> statement-breakpoint
CREATE TABLE "towbar_log_retention_state" (
 "workspace_id" uuid PRIMARY KEY REFERENCES "towbar_workspaces"("id") ON DELETE CASCADE,
 "cutoff_at" timestamptz NOT NULL,
 "committed_sequence" bigint NOT NULL DEFAULT 0,
 "pruned_before_at" timestamptz
);

--> statement-breakpoint
CREATE TABLE "towbar_log_collector_requests" (
 "workspace_id" uuid NOT NULL REFERENCES "towbar_workspaces"("id") ON DELETE CASCADE,
 "key_hash" varchar(64) NOT NULL, "server_id" uuid NOT NULL, "generation" uuid NOT NULL,
 "enabled" boolean NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY ("workspace_id", "key_hash")
);
