-- Additive shadow cost ledger for Milestone 1.
-- Non-enforcing, privacy-safe record of marked-up inference costs in micro-dollars.
-- Prompts, completions, tool results, and memory contents are strictly excluded.
CREATE TABLE IF NOT EXISTS "shadow_cost_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text,
  "request_id" text,
  "attempt_number" integer DEFAULT 1 NOT NULL,
  "operation" text NOT NULL,
  "modality" text DEFAULT 'text' NOT NULL,
  "model_key" text NOT NULL,
  "provider" text,
  "pricing_version_id" text NOT NULL,
  "pricing_source" text NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cached_input_tokens" integer DEFAULT 0 NOT NULL,
  "reasoning_tokens" integer DEFAULT 0 NOT NULL,
  "raw_cost_micros" integer,
  "shadow_deduction_micros" integer,
  "status" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "shadow_cost_ledger_idempotency_unique" ON "shadow_cost_ledger" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "shadow_cost_ledger_user_created_idx" ON "shadow_cost_ledger" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "shadow_cost_ledger_request_idx" ON "shadow_cost_ledger" ("request_id");
CREATE INDEX IF NOT EXISTS "shadow_cost_ledger_status_idx" ON "shadow_cost_ledger" ("status");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'shadow_cost_ledger_user_id_user_id_fk'
    ) THEN
      ALTER TABLE "shadow_cost_ledger"
      ADD CONSTRAINT "shadow_cost_ledger_user_id_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

