CREATE TABLE IF NOT EXISTS "user_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_connectors_user_provider_idx" ON "user_connectors" ("user_id","provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connectors_user_status_idx" ON "user_connectors" ("user_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_tool_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid,
	"tool_name" text NOT NULL,
	"action_description" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_tool_actions_user_status_idx" ON "pending_tool_actions" ("user_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pending_tool_actions_idempotency_idx" ON "pending_tool_actions" ("idempotency_key");

