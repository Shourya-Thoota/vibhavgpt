-- Account preferences that follow a person between devices: the accent colour, the media watermark choice and the optional
-- location context. Additive only: a new table. Nothing that exists is altered, dropped or rewritten.

CREATE TABLE IF NOT EXISTS "account_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"accent" text,
	"watermark_enabled" boolean DEFAULT true NOT NULL,
	"location_mode" text DEFAULT 'off' NOT NULL,
	"location_city" text,
	"location_region" text,
	"location_country" text,
	"location_timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
