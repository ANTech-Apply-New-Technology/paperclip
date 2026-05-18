CREATE TABLE IF NOT EXISTS "issue_status_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_agent_id" uuid,
	"actor_run_id" uuid,
	"checkout_run_id" uuid,
	"execution_run_id" uuid,
	"before_status" text NOT NULL,
	"after_status" text NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_status_audit_outcome_check') THEN
		ALTER TABLE "issue_status_audit" ADD CONSTRAINT "issue_status_audit_outcome_check"
			CHECK ("outcome" IN ('ok','conflict_409','validation_error','other_error'));
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_status_audit_issue_id_issues_id_fk') THEN
		ALTER TABLE "issue_status_audit" ADD CONSTRAINT "issue_status_audit_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_status_audit_actor_agent_id_agents_id_fk') THEN
		ALTER TABLE "issue_status_audit" ADD CONSTRAINT "issue_status_audit_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_status_audit_actor_run_id_heartbeat_runs_id_fk') THEN
		ALTER TABLE "issue_status_audit" ADD CONSTRAINT "issue_status_audit_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_status_audit_issue_created_idx" ON "issue_status_audit" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_status_audit_actor_run_idx" ON "issue_status_audit" USING btree ("actor_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_status_audit_created_at_idx" ON "issue_status_audit" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_agent_id" uuid;--> statement-breakpoint
-- Backfill execution_agent_id from heartbeat_runs.agent_id for active locks.
-- Idempotent: only fills rows that currently lack it but have an executionRunId.
UPDATE "issues"
SET "execution_agent_id" = "heartbeat_runs"."agent_id"
FROM "heartbeat_runs"
WHERE "issues"."execution_run_id" IS NOT NULL
	AND "issues"."execution_agent_id" IS NULL
	AND "issues"."execution_run_id" = "heartbeat_runs"."id";
