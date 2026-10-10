CREATE TABLE "credit_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "credits" integer NOT NULL,
  "kind" text NOT NULL,
  "usage_event_id" uuid,
  "external_reference" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_usage_event_id_usage_events_id_fk"
  FOREIGN KEY ("usage_event_id") REFERENCES "usage_events"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "credit_ledger_user_created_idx" ON "credit_ledger" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "credit_ledger_usage_event_idx" ON "credit_ledger" ("usage_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_external_reference_unique" ON "credit_ledger" ("external_reference");
