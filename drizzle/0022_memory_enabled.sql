ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "memory_enabled" boolean DEFAULT true NOT NULL;
