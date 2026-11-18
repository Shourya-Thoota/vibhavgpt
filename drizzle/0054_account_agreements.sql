-- Eligibility and agreement records (legal audit, 2026-11-16). One row per account: which Terms and Privacy versions it accepted and when,
-- and the result of the neutral age question (16_plus or under_16) and when it was asked. The date of birth itself is never stored.
-- Additive only: a new table.
CREATE TABLE IF NOT EXISTS "account_agreements" (
  "user_id" text PRIMARY KEY NOT NULL,
  "terms_version" text,
  "privacy_version" text,
  "accepted_at" timestamp with time zone,
  "age_check" text,
  "age_checked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_agreements_age_check" CHECK ("age_check" IS NULL OR "age_check" IN ('16_plus', 'under_16'))
);
