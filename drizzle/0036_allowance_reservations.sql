-- Milestone 6: Allowance reservation, settlement, and lifecycle core.
-- Adds reservation hold amounts, settlement values, dispatch timestamps,
-- and worker lease tracking to shadow_cost_ledger.

ALTER TABLE "shadow_cost_ledger"
  ADD COLUMN IF NOT EXISTS "reserved_cost_micros" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "settled_cost_micros" integer,
  ADD COLUMN IF NOT EXISTS "reservation_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "dispatched_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "settled_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reconciled_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "parent_id" uuid;

CREATE INDEX IF NOT EXISTS "shadow_cost_ledger_user_expires_idx" ON "shadow_cost_ledger" ("user_id", "reservation_expires_at");
CREATE INDEX IF NOT EXISTS "shadow_cost_ledger_lease_expires_idx" ON "shadow_cost_ledger" ("lease_expires_at");
CREATE INDEX IF NOT EXISTS "shadow_cost_ledger_parent_idx" ON "shadow_cost_ledger" ("parent_id");

