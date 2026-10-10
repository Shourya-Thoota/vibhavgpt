ALTER TABLE "subscriptions"
  ADD COLUMN "billing_source" text DEFAULT 'stripe' NOT NULL,
  ADD COLUMN "provider_product_id" text,
  ADD COLUMN "provider_base_plan_id" text,
  ADD COLUMN "provider_purchase_token_hash" text,
  ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "google_play_purchases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "purchase_token_hash" text NOT NULL,
  "linked_purchase_token_hash" text,
  "product_id" text NOT NULL,
  "base_plan_id" text NOT NULL,
  "order_id" text,
  "provider_status" text NOT NULL,
  "expires_at" timestamp with time zone,
  "auto_renew_enabled" boolean DEFAULT false NOT NULL,
  "acknowledgement_state" text,
  "last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "google_play_purchases_token_hash_unique" ON "google_play_purchases" USING btree ("purchase_token_hash");
--> statement-breakpoint
CREATE INDEX "google_play_purchases_user_idx" ON "google_play_purchases" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "google_play_purchases_linked_token_idx" ON "google_play_purchases" USING btree ("linked_purchase_token_hash");
--> statement-breakpoint
CREATE TABLE "google_play_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "obfuscated_account_id_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "google_play_accounts_user_unique" ON "google_play_accounts" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "google_play_accounts_account_hash_unique" ON "google_play_accounts" USING btree ("obfuscated_account_id_hash");
--> statement-breakpoint
CREATE TABLE "google_play_notifications" (
  "message_id" text PRIMARY KEY NOT NULL,
  "purchase_token_hash" text,
  "notification_type" text,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "google_play_notifications_token_idx" ON "google_play_notifications" USING btree ("purchase_token_hash");
