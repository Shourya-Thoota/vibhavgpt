-- Search across a person's own chats: full-text indexes on conversation titles and message text.
-- Additive only: two new indexes. No table or column is touched; nothing is rewritten. (An index build takes a short lock
-- that holds back writes to that table while it runs.)

CREATE INDEX IF NOT EXISTS "conversations_title_fts_idx" ON "conversations" USING gin (to_tsvector('english', "title"));
CREATE INDEX IF NOT EXISTS "messages_content_fts_idx" ON "messages" USING gin (to_tsvector('english', "content"));
