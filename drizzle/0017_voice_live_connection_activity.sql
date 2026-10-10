ALTER TABLE voice_live_sessions
  ADD COLUMN IF NOT EXISTS connected_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE voice_live_sessions
  ADD COLUMN IF NOT EXISTS last_activity_at timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS voice_live_sessions_reserved_activity_idx
  ON voice_live_sessions (status, last_activity_at)
  WHERE status = 'reserved';
