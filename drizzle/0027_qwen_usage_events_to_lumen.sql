-- The same "qwen" to "lumen" rewrite for usage_events.model, kept in its own
-- migration so it can be left out on its own. Usage totals already count
-- "qwen" rows as Lumen through the alias, so totals do not change. Matching on
-- 'qwen' makes a second run change nothing.
UPDATE "usage_events" SET "model" = 'lumen' WHERE "model" = 'qwen';
