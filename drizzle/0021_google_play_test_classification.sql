ALTER TABLE "google_play_purchases" ADD COLUMN IF NOT EXISTS "is_test_purchase" boolean DEFAULT false NOT NULL;
