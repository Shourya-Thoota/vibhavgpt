ALTER TABLE attachments ADD COLUMN IF NOT EXISTS prompt text;
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS parent_attachment_id uuid;
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS generation_meta jsonb NOT NULL DEFAULT '{}';
