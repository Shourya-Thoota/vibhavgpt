-- 0004_memory_categories was released with an out-of-order journal timestamp,
-- so production correctly skipped it after 0003. Keep this repair idempotent:
-- it is safe both for databases that missed 0004 and for any environment that
-- already has the categorized columns.
ALTER TABLE "memory_facts" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
ALTER TABLE "memory_facts" ADD COLUMN IF NOT EXISTS "area" text;
--> statement-breakpoint
ALTER TABLE "memory_facts" ALTER COLUMN "category" SET DEFAULT 'profile';
--> statement-breakpoint

UPDATE "memory_facts"
SET "category" = CASE
  WHEN lower("content") ~ '(prefer|preference|response style|answer style|tone|concise|detailed)' THEN 'preferences'
  WHEN lower("content") ~ '(school|study|studies|academic|class|university|college|course)' THEN 'academics'
  WHEN lower("content") ~ '(career|job|work|employed|employer|company|profession)' THEN 'recent_work'
  WHEN lower("content") ~ '(tool|software|uses |using |app|application|editor|programming language)' THEN 'tools'
  WHEN lower("content") ~ '(interest|hobby|enjoys|likes|fan of|passion)' THEN 'interests'
  ELSE 'profile'
END
WHERE "category" IS NULL OR "category" = 'profile';
--> statement-breakpoint

ALTER TABLE "memory_facts" ALTER COLUMN "category" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_facts_user_category_updated_idx"
  ON "memory_facts" ("user_id", "category", "updated_at");
