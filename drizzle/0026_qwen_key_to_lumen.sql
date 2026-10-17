-- Rewrites the legacy "qwen" model key to "lumen" in the stored model
-- preferences and on conversations. The code still aliases "qwen" to "lumen",
-- so nothing changes for users; this only clears old values so the alias can
-- be removed later. Matching on 'qwen' makes a second run change nothing.
-- updated_at is left as it was.
UPDATE "user_profiles" SET "preferred_model" = 'lumen' WHERE "preferred_model" = 'qwen';--> statement-breakpoint
UPDATE "user_profiles" SET "last_used_model" = 'lumen' WHERE "last_used_model" = 'qwen';--> statement-breakpoint
UPDATE "conversations" SET "model" = 'lumen' WHERE "model" = 'qwen';
