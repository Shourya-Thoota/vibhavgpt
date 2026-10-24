-- Survey completion belongs to the account, so it follows the person to every
-- device. The answers (minus the "Call me" name, which lives in the personal
-- instructions) are kept so a new device can restore them; a skip leaves them null.
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "onboarding_completed" boolean DEFAULT false NOT NULL;
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp with time zone;
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "onboarding_answers" jsonb;
