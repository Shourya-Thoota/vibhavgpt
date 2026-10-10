-- Repair posts seeded with literal backslash-n sequences instead of Markdown line breaks.
UPDATE "blog_posts"
SET "content" = replace("content", E'\\n', E'\n'),
    "updated_at" = now()
WHERE "content" LIKE E'%\\n%';
