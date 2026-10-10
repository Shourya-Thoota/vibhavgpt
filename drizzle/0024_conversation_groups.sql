-- Projects and folders for Chat and Study. One table holds both: a project
-- carries optional instructions that reach the model for every chat inside
-- it; a folder is a plain grouping. A folder may sit inside a project (one
-- level only, enforced in the repository). Ownership is part of every key so
-- a conversation can never be filed under another account's group.
CREATE TABLE conversation_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL DEFAULT 'folder',
  mode text NOT NULL DEFAULT 'chat',
  parent_id uuid,
  name text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX conversation_groups_owner_id_unique ON conversation_groups (user_id, id);
--> statement-breakpoint
CREATE INDEX conversation_groups_owner_mode_idx ON conversation_groups (user_id, mode);
--> statement-breakpoint
ALTER TABLE conversation_groups ADD CONSTRAINT conversation_groups_parent_owner_fk
  FOREIGN KEY (user_id, parent_id) REFERENCES conversation_groups (user_id, id);
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN group_id uuid;
--> statement-breakpoint
ALTER TABLE conversations ADD CONSTRAINT conversations_group_owner_fk
  FOREIGN KEY (user_id, group_id) REFERENCES conversation_groups (user_id, id);
--> statement-breakpoint
CREATE INDEX conversations_owner_group_idx ON conversations (user_id, group_id);
