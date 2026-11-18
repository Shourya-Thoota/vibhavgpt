-- Shared chat capacity (src/chat/capacity.js). One row per chat reply that is waiting for, or holding, a slot. Rows are short-lived:
-- a reply deletes its row when it completes, fails, is cancelled or the person disconnects, and a row whose API replica stopped
-- renewing it (a crash or a redeploy) expires after a few seconds and is deleted by the next admission check on any replica.
-- Additive only: a new table, nothing existing is altered. It holds no message text, model output, keys or provider names.
CREATE TABLE IF NOT EXISTS "chat_capacity_leases" (
  "id" uuid PRIMARY KEY,
  -- lumen | nova | nebula | vesper | study
  "tier" text NOT NULL,
  "user_id" text NOT NULL,
  -- The project whose shared context the reply uses, when it has one.
  "group_id" text,
  -- queued | active
  "state" text NOT NULL,
  -- The API replica holding the row (a random id per process).
  "instance_id" text NOT NULL,
  "enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "accepted_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL
);
CREATE INDEX IF NOT EXISTS "chat_capacity_leases_state_tier_idx" ON "chat_capacity_leases" ("state", "tier");
CREATE INDEX IF NOT EXISTS "chat_capacity_leases_expires_idx" ON "chat_capacity_leases" ("expires_at");
