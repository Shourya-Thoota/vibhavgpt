-- Drops the legacy Android in-app purchase tables created by 0020 and 0021.
-- VibhavGPT bills on the web only; no code path has written these tables
-- since then, and the only remaining reader was account deletion, which no
-- longer needs to clear them. Their indexes go with them. IF EXISTS keeps
-- this safe to re-run. There is no automatic rollback: the rows are gone
-- once this runs, so restore from a backup taken before deploy if needed.
DROP TABLE IF EXISTS "google_play_notifications";--> statement-breakpoint
DROP TABLE IF EXISTS "google_play_accounts";--> statement-breakpoint
DROP TABLE IF EXISTS "google_play_purchases";
