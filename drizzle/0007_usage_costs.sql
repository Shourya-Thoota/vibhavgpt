ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "cost_micros" integer DEFAULT 0 NOT NULL;
