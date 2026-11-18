-- Scoped memory with separate use/save controls, provenance, and temporary chats. Additive only: new nullable columns, or columns
-- with constant defaults (metadata-only in PostgreSQL 11+, no table rewrite). Nothing existing is altered, dropped or rewritten, except
-- that an account which had turned memory off keeps saving off under the new separate "Save new memories" switch.

-- memory_facts.scope: "personal" (the account owner only) or "project" (one project of that owner, in project_id).
ALTER TABLE "memory_facts" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'personal' NOT NULL;
ALTER TABLE "memory_facts" ADD COLUMN IF NOT EXISTS "project_id" uuid;
-- How the memory came to exist: "explicit" (the person asked for it to be remembered) or "inferred" (VibhavGPT judged it lasting).
-- Null for rows saved before this column; their `source` (manual, import, assistant, auto) still says where they came from.
ALTER TABLE "memory_facts" ADD COLUMN IF NOT EXISTS "origin" text;
-- The chat a memory was saved from, when it was saved from a chat. Not a foreign key: deleting the chat keeps the memory, and the
-- Memory page simply stops linking to it.
ALTER TABLE "memory_facts" ADD COLUMN IF NOT EXISTS "source_conversation_id" uuid;
CREATE INDEX IF NOT EXISTS "memory_facts_user_scope_idx" ON "memory_facts" ("user_id", "scope", "project_id");

-- "Use memory when answering" stays memory_enabled; "Save new memories" is new. Accounts that had memory off keep saving off.
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "memory_save_enabled" boolean DEFAULT true NOT NULL;
UPDATE "user_profiles" SET "memory_save_enabled" = false WHERE "memory_enabled" = false AND "memory_save_enabled" = true;

-- Per project: use this project's memories in its chats, and save new ones to it.
ALTER TABLE "conversation_groups" ADD COLUMN IF NOT EXISTS "memory_use_enabled" boolean DEFAULT true NOT NULL;
ALTER TABLE "conversation_groups" ADD COLUMN IF NOT EXISTS "memory_save_enabled" boolean DEFAULT true NOT NULL;

-- A temporary chat: memory is neither used nor saved, it is left out of the chat list, and it is deleted after 24 hours.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "temporary" boolean DEFAULT false NOT NULL;
