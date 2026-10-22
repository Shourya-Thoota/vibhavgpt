-- DECANet: DECA role-play practice, a VibhavGPT product. Its accounts are its
-- own (email + password, or linked to a VibhavGPT user), so nothing here
-- touches VibhavGPT's auth or billing tables.
CREATE TABLE IF NOT EXISTS "decanet_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "email_normalized" text NOT NULL,
  "password_hash" text,
  "name" text NOT NULL,
  "role" text DEFAULT 'participant' NOT NULL,
  "event_code" text,
  "vibhav_user_id" text,
  "onboarded" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decanet_accounts_role_check" CHECK ("role" IN ('participant', 'advisor'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decanet_accounts_email_unique" ON "decanet_accounts" ("email_normalized");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decanet_accounts_vibhav_unique" ON "decanet_accounts" ("vibhav_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decanet_sessions" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "decanet_accounts"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decanet_sessions_account_idx" ON "decanet_sessions" ("account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decanet_password_resets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "decanet_accounts"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decanet_password_resets_account_idx" ON "decanet_password_resets" ("account_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decanet_chapters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "school" text DEFAULT '' NOT NULL,
  "join_code" text NOT NULL,
  "advisor_code" text NOT NULL,
  "invite_token" text NOT NULL,
  "require_approval" boolean DEFAULT true NOT NULL,
  "created_by" uuid REFERENCES "decanet_accounts"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decanet_chapters_join_code_unique" ON "decanet_chapters" ("join_code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decanet_chapters_advisor_code_unique" ON "decanet_chapters" ("advisor_code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decanet_chapters_invite_token_unique" ON "decanet_chapters" ("invite_token");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decanet_chapter_members" (
  "chapter_id" uuid NOT NULL REFERENCES "decanet_chapters"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "decanet_accounts"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "locked_event" text,
  "consented_at" timestamp with time zone,
  "approved_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decanet_chapter_members_pk" PRIMARY KEY ("chapter_id", "account_id"),
  CONSTRAINT "decanet_chapter_members_role_check" CHECK ("role" IN ('participant', 'advisor')),
  CONSTRAINT "decanet_chapter_members_status_check" CHECK ("status" IN ('pending', 'active'))
);
--> statement-breakpoint
-- One chapter per account keeps sharing and credit pools unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "decanet_chapter_members_account_unique" ON "decanet_chapter_members" ("account_id");
--> statement-breakpoint
-- Append-only: a balance is the sum of an account's rows.
CREATE TABLE IF NOT EXISTS "decanet_credit_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "decanet_accounts"("id") ON DELETE CASCADE,
  "delta" integer NOT NULL,
  "kind" text NOT NULL,
  "reference" text,
  "chapter_id" uuid,
  "attempt_id" uuid,
  "actor_account_id" uuid,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decanet_credit_ledger_account_idx" ON "decanet_credit_ledger" ("account_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decanet_credit_ledger_reference_unique" ON "decanet_credit_ledger" ("reference");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decanet_chapter_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chapter_id" uuid NOT NULL REFERENCES "decanet_chapters"("id") ON DELETE CASCADE,
  "delta" integer NOT NULL,
  "kind" text NOT NULL,
  "reference" text,
  "actor_account_id" uuid,
  "member_account_id" uuid,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decanet_chapter_ledger_chapter_idx" ON "decanet_chapter_ledger" ("chapter_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decanet_chapter_ledger_reference_unique" ON "decanet_chapter_ledger" ("reference");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decanet_purchases" (
  "checkout_session_id" text PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "decanet_accounts"("id") ON DELETE CASCADE,
  "chapter_id" uuid,
  "pack" text NOT NULL,
  "credits" integer NOT NULL,
  "amount_cents" integer NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decanet_purchases_account_idx" ON "decanet_purchases" ("account_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decanet_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "decanet_accounts"("id") ON DELETE CASCADE,
  "chapter_id" uuid,
  "event_code" text NOT NULL,
  "roleplay_id" text NOT NULL,
  "status" text DEFAULT 'prep' NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "prep_started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "prep_ended_at" timestamp with time zone,
  "roleplay_started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "realtime_call_id" text,
  "realtime_connects" integer DEFAULT 0 NOT NULL,
  "realtime_usage" jsonb,
  "transcript" jsonb,
  "result" jsonb,
  "score" integer,
  "grading_started_at" timestamp with time zone,
  "graded_at" timestamp with time zone,
  "grading_error" text,
  "grading_tries" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decanet_attempts_status_check" CHECK ("status" IN ('prep', 'roleplay', 'grading', 'graded'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decanet_attempts_account_idx" ON "decanet_attempts" ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decanet_attempts_chapter_idx" ON "decanet_attempts" ("chapter_id", "created_at");
