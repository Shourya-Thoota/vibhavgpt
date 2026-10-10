CREATE TABLE "blog_posts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "excerpt" text NOT NULL,
  "content" text NOT NULL,
  "seo_description" text,
  "cover_image" text,
  "is_published" boolean DEFAULT false NOT NULL,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "blog_posts_slug_unique" ON "blog_posts" ("slug");
--> statement-breakpoint
CREATE INDEX "blog_posts_published_idx" ON "blog_posts" ("is_published", "published_at");
--> statement-breakpoint
INSERT INTO "blog_posts" ("slug", "title", "excerpt", "content", "seo_description", "is_published", "published_at")
VALUES (
  'welcome-to-vibhavgpt',
  'Welcome to VibhavGPT',
  'A calmer place to think, make, and keep momentum.',
  '# Welcome to VibhavGPT\n\nVibhavGPT is a personal workspace for questions, ideas, and the work between them. This journal is where we will share product notes and practical ways to get more from the workspace.\n\n## A thoughtful starting point\n\nWe are building the app around clear answers, useful context, and tools that stay out of the way. More updates will follow here as the product grows.',
  'Learn what VibhavGPT is and how the workspace is designed for clear, useful thinking.',
  true,
  now()
)
ON CONFLICT ("slug") DO NOTHING;
