CREATE TABLE "news_briefings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope_key" text NOT NULL,
  "user_id" text,
  "briefing" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "news_briefings_scope_unique" ON "news_briefings" ("scope_key");
--> statement-breakpoint
CREATE INDEX "news_briefings_expires_idx" ON "news_briefings" ("expires_at");
