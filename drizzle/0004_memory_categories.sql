ALTER TABLE "memory_facts" ADD COLUMN "category" text DEFAULT 'profile' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD COLUMN "area" text;--> statement-breakpoint

-- Preserve every existing fact while giving the old flat records a useful,
-- conservative first home. Ambiguous records remain in Profile rather than
-- being assigned to an invented project area.
UPDATE "memory_facts"
SET "category" = CASE
  WHEN lower("content") ~ '(prefer|preference|response style|answer style|tone|concise|detailed)' THEN 'preferences'
  WHEN lower("content") ~ '(school|study|studies|academic|class|university|college|course)' THEN 'academics'
  WHEN lower("content") ~ '(career|job|work|employed|employer|company|profession)' THEN 'recent_work'
  WHEN lower("content") ~ '(tool|software|uses |using |app|application|editor|programming language)' THEN 'tools'
  WHEN lower("content") ~ '(interest|hobby|enjoys|likes|fan of|passion)' THEN 'interests'
  ELSE 'profile'
END;

CREATE INDEX "memory_facts_user_category_updated_idx"
  ON "memory_facts" ("user_id", "category", "updated_at");
