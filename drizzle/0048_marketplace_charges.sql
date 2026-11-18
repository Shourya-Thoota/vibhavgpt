-- Third-party model charges (Slice 7, src/models/marketplace.js). One row per settled third-party model call, written with the call's
-- usage_events row, so support can explain any charge: which model, what the provider charged, the 10% upcharge, and the credits.
-- Additive only: a new table, nothing existing is altered. It holds no message text, model output or keys.
CREATE TABLE IF NOT EXISTS "marketplace_charges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "usage_event_id" uuid NOT NULL REFERENCES "usage_events" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  -- The picker's model id (for example glm-5v-turbo) and its maker as shown (for example GLM).
  "model" text NOT NULL,
  "provider" text NOT NULL,
  -- Integer micro-dollars: the provider's cost, the 10% upcharge, and their sum (the ledger's debit for this call).
  "raw_cost_micros" integer NOT NULL,
  "upcharge_micros" integer NOT NULL,
  "charged_micros" integer NOT NULL,
  -- charged_micros in credits (one credit is CREDIT_MICROS), kept exact as text, for example "0.0132".
  "credits" text NOT NULL,
  -- provider-reported (the router's cost for the call) or live-price (the live per-token price times the counted tokens).
  "cost_source" text NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_charges_usage_event_unique" ON "marketplace_charges" ("usage_event_id");
CREATE INDEX IF NOT EXISTS "marketplace_charges_user_created_idx" ON "marketplace_charges" ("user_id", "created_at");
