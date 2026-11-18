-- Build's projects (src/build/projects.js): one project per Build conversation, and its versions. Each version holds its files as data
-- (paths and text contents, validated by src/build/artifacts.js); nothing here is executed. Owned by the person (user_id on every row),
-- deleted with the conversation (cascade) and with the account (src/account/deletion.js). Additive only: two new tables.
CREATE TABLE IF NOT EXISTS "build_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations" ("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "kind" text NOT NULL,
  -- The request that started the project, kept so follow-up changes keep to it (plain text, bounded).
  "brief" text DEFAULT '' NOT NULL,
  "current_revision" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "build_projects_conversation_unique" ON "build_projects" ("conversation_id");
CREATE INDEX IF NOT EXISTS "build_projects_user_idx" ON "build_projects" ("user_id");

CREATE TABLE IF NOT EXISTS "build_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "build_projects" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "number" integer NOT NULL,
  "kind" text NOT NULL,
  "entry" text NOT NULL,
  -- [{ "path": "index.html", "content": "...", "bytes": 123, "type": "text/html" }]
  "files" jsonb NOT NULL,
  "total_bytes" integer NOT NULL,
  -- The reply that wrote this version, or null for a restored one.
  "message_id" uuid,
  "restored_from" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "build_revisions_project_number_unique" ON "build_revisions" ("project_id", "number");
CREATE INDEX IF NOT EXISTS "build_revisions_user_idx" ON "build_revisions" ("user_id");
