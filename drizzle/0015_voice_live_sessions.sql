ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS voice_suspended_at timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS voice_live_sessions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	user_id text NOT NULL,
	tier text NOT NULL,
	requested_model text NOT NULL,
	actual_model text NOT NULL,
	fair_use_fallback boolean NOT NULL DEFAULT false,
	reserved_seconds integer NOT NULL,
	actual_seconds integer,
	status text NOT NULL DEFAULT 'reserved',
	created_at timestamp with time zone NOT NULL DEFAULT now(),
	updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS voice_live_sessions_user_created_idx ON voice_live_sessions (user_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS voice_live_sessions_status_created_idx ON voice_live_sessions (status, created_at);
