ALTER TABLE "usage_events" ADD COLUMN "reserved_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "reservation_expires_at" timestamp with time zone;
