-- Image watermark policy (owner decision, 2026-11-16, superseding #70): Free plan images always carry the VibhavGPT mark; on paid plans it
-- is optional and off unless the person turns it on. This is that opt-in. A new column, off by default: the old watermark_enabled column
-- defaulted to on under an earlier, opt-out policy, so its values cannot mean "chose it" and are not reused. Additive only.
ALTER TABLE "account_preferences" ADD COLUMN IF NOT EXISTS "image_watermark" boolean DEFAULT false NOT NULL;
