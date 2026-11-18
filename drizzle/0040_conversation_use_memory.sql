-- The "Use memory" switch in the composer menu, kept per conversation. Null means no choice was made (memory follows the account
-- setting); false means this conversation neither reads nor saves memory. Additive only: one nullable column with no default,
-- which PostgreSQL adds without rewriting the table. Nothing that exists is altered, dropped or rewritten.

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "use_memory" boolean;
