-- Milestone 2A: Internal versioned model registry tables.
-- Decomposes model family lineage, exact versions, endpoints, pricing snapshots, and privacy auditing.
-- Strictly excludes user content, prompts, completions, and vendor API keys.

CREATE TABLE IF NOT EXISTS "model_families" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "family_group" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "sort_order" integer DEFAULT 100 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "model_families_slug_unique" ON "model_families" ("slug");
CREATE INDEX IF NOT EXISTS "model_families_group_idx" ON "model_families" ("family_group");

CREATE TABLE IF NOT EXISTS "model_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id" uuid NOT NULL REFERENCES "model_families"("id") ON DELETE CASCADE,
  "version_tag" text NOT NULL,
  "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "capabilities_documented" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "plan_eligibility" text DEFAULT 'paid' NOT NULL,
  "lifecycle_state" text DEFAULT 'candidate' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "model_versions_family_version_unique" ON "model_versions" ("family_id", "version_tag");
CREATE INDEX IF NOT EXISTS "model_versions_lifecycle_idx" ON "model_versions" ("lifecycle_state");

CREATE TABLE IF NOT EXISTS "model_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "version_id" uuid NOT NULL REFERENCES "model_versions"("id") ON DELETE CASCADE,
  "provider_name" text NOT NULL,
  "transport_type" text NOT NULL,
  "adapter_type" text DEFAULT 'chat_completions' NOT NULL,
  "endpoint_url" text NOT NULL,
  "capabilities_verified" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "privacy_review" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "endpoint_state" text DEFAULT 'candidate' NOT NULL,
  "sort_priority" integer DEFAULT 10 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "model_endpoints_version_provider_transport_unique" ON "model_endpoints" ("version_id", "provider_name", "transport_type");
CREATE INDEX IF NOT EXISTS "model_endpoints_state_idx" ON "model_endpoints" ("endpoint_state");

CREATE TABLE IF NOT EXISTS "model_pricing_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "endpoint_id" uuid NOT NULL REFERENCES "model_endpoints"("id") ON DELETE CASCADE,
  "pricing_version_id" text NOT NULL,
  "effective_from" timestamp with time zone DEFAULT now() NOT NULL,
  "effective_to" timestamp with time zone,
  "currency" text DEFAULT 'USD' NOT NULL,
  "billing_unit" text DEFAULT 'usd_per_1m_tokens' NOT NULL,
  "input_price_micros_per_m" integer,
  "output_price_micros_per_m" integer,
  "cached_read_price_micros_per_m" integer,
  "reasoning_price_micros_per_m" integer,
  "reasoning_included_in_output" boolean DEFAULT true NOT NULL,
  "calculated_mu" double precision,
  "consumption_category" text DEFAULT 'pending' NOT NULL,
  "pricing_confidence" text DEFAULT 'unknown' NOT NULL,
  "provenance" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "model_pricing_endpoint_effective_idx" ON "model_pricing_snapshots" ("endpoint_id", "effective_from");
CREATE INDEX IF NOT EXISTS "model_pricing_version_id_idx" ON "model_pricing_snapshots" ("pricing_version_id");

