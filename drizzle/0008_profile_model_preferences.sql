ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "preferred_model" text;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "last_used_model" text;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "thinking_effort" text DEFAULT 'normal' NOT NULL;
