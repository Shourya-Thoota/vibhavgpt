CREATE TABLE image_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX image_folders_owner_id_unique ON image_folders (user_id, id);
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN display_name text;
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN folder_id uuid;
--> statement-breakpoint
ALTER TABLE attachments ADD CONSTRAINT attachments_folder_owner_fk
  FOREIGN KEY (user_id, folder_id) REFERENCES image_folders (user_id, id);
--> statement-breakpoint
CREATE INDEX attachments_owner_folder_created_idx ON attachments (user_id, folder_id, created_at, id);
