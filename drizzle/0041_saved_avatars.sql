-- Saved avatars: reference photos a person keeps for image generation, apart from the one profile picture. Each is the server's own
-- re-encoded copy (no metadata). Additive only: a new table and an index on the owner. Nothing that exists is altered, dropped or
-- rewritten.

CREATE TABLE IF NOT EXISTS "saved_avatars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "saved_avatars_user_created_idx" ON "saved_avatars" ("user_id", "created_at");
