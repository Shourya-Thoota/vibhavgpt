-- Profile pictures: one row per account, holding the server's own re-encoded 256px WebP (a few kilobytes).
-- Additive only: a new table. Nothing that exists is altered, dropped or rewritten.

CREATE TABLE IF NOT EXISTS "profile_pictures" (
	"user_id" text PRIMARY KEY NOT NULL,
	"content_type" text DEFAULT 'image/webp' NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
