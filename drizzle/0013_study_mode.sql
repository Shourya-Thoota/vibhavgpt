ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS product_mode text NOT NULL DEFAULT 'chat';
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'chat';
