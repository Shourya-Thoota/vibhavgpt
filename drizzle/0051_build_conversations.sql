-- Build conversations get their own stored mode (owner request, 2026-11-15), so Build history is kept apart from Chat by what is stored, never
-- by a title or the tab on screen. Existing Build conversations are identified by the model recorded on the conversation: VibhavGPT Tecton
-- has only ever been offered in Build (it is not a picker model), so a chat-mode conversation whose model is tecton was started in Build.
-- Additive and narrow: one UPDATE of those rows' mode; nothing is deleted, duplicated or moved between accounts.
UPDATE "conversations" SET "mode" = 'build' WHERE "mode" = 'chat' AND lower(btrim("model")) = 'tecton';
