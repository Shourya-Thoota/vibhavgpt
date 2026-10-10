ALTER TABLE "user_profiles" ADD COLUMN "response_style" text DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "custom_instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
