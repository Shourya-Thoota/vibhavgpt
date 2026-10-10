CREATE TABLE "attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "conversation_id" uuid,
  "message_id" uuid,
  "original_name" text NOT NULL,
  "stored_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "kind" text DEFAULT 'document' NOT NULL,
  "size_bytes" integer NOT NULL,
  "extracted_text" text,
  "extraction_status" text DEFAULT 'ready' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "attachments_conversation_id_conversations_id_fk"
    FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade,
  CONSTRAINT "attachments_message_id_messages_id_fk"
    FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "attachments_user_created_idx" ON "attachments" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_stored_name_unique" ON "attachments" USING btree ("stored_name");
