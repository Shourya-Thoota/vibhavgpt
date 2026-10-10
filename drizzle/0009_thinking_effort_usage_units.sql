ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "usage_units" double precision DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "thinking_effort" text DEFAULT 'normal' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_user_model_effort_created_idx"
  ON "usage_events" ("user_id", "model", "thinking_effort", "created_at");
