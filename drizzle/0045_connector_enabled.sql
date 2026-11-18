ALTER TABLE "user_connectors" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;

