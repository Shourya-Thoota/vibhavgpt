-- Milestone 4: Account-scoped model catalog preferences.
-- Stores favorites, hidden brands, and brand ordering for authenticated users.
-- Strictly non-sensitive UI preferences; excludes inference data and credentials.

ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "catalog_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;
