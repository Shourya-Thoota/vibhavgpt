-- VibhavGPT News is retired. The cached briefings are not user content and
-- may be removed with the feature rather than retained as orphaned data.
DROP TABLE IF EXISTS "news_briefings";
--> statement-breakpoint
UPDATE "blog_posts"
SET "content" = replace(
  "content",
  E'- **News:** request a concise current briefing with original summaries and links back to the sources.\n',
  ''
),
"updated_at" = now()
WHERE "content" LIKE '%**News:** request a concise current briefing%';
