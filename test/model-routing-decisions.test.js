import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";

import {
  ROUTE_DECISION_REASONS,
  CUSTOMER_SAFE_REJECTIONS,
  evaluateRoutingDecision,
  revalidateRoutingDecision,
  serializeDecisionForClient,
  loadRegistrySnapshot,
} from "../src/models/decision.js";
import {
  createModelFamily,
  createModelVersion,
  createModelEndpoint,
  createPricingSnapshot,
  updateEndpointPrivacyReview,
  revokeEndpointPrivacyReview,
  transitionModelVersionState,
  LIFECYCLE_STATES,
  PLAN_ELIGIBILITY,
} from "../src/models/registry.js";
import { CONSUMPTION_CATEGORIES } from "../src/models/consumption.js";
import { getModelConfig } from "../src/chat/providers.js";
import { MODEL_ALIASES } from "../src/chat/model-keys.js";
import * as schema from "../src/db/schema.js";

// Helper to create an in-memory PGlite database with all tables
async function createTestDb(t) {
  const client = new PGlite();
  t.after(async () => {
    await client.close();
  });
  const db = drizzle(client, { schema });

  // Execute schema definitions
  await client.exec(`
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
  `);

  return { db, client };
}

// Builds a synthetic test snapshot in memory without DB overhead
function buildSyntheticSnapshot() {
  const jan1 = "2026-01-01T00:00:00Z";
  return [
    // 1. Free lightweight model (Lumen)
    {
      family: {
        id: "fam-lumen",
        slug: "vibhavgpt/lumen",
        displayName: "VibhavGPT Lumen",
        familyGroup: "native",
        sortOrder: 10,
      },
      version: {
        id: "ver-lumen",
        versionTag: "lumen-standard",
        aliases: ["lumen", "spark"],
        planEligibility: "free",
        lifecycleState: "active",
        capabilitiesDocumented: {
          vision: false,
          tools: true,
          streaming: true,
          structuredOutputs: true,
          contextWindowTokens: 131072,
          maxOutputTokens: 8192,
          reasoningSupported: false,
        },
      },
      endpoints: [
        {
          id: "ep-lumen-primary",
          providerName: "primaryFree",
          transportType: "primaryFree",
          adapterType: "chat_completions",
          endpointUrl: "https://api.groq.com/openai/v1",
          endpointState: "active",
          sortPriority: 1,
          capabilitiesVerified: { vision: false, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "denied",
            zeroDataRetention: false,
            scope: "default",
          },
          pricing: {
            pricingVersionId: "snap-lumen",
            effectiveFrom: jan1,
            effectiveTo: null,
            calculatedMu: 0.20,
            consumptionCategory: "low",
            pricingConfidence: "verified",
            inputPriceMicrosPerM: 100_000,
            outputPriceMicrosPerM: 400_000,
          },
        },
      ],
    },

    // 2. Paid general model (Nova)
    {
      family: {
        id: "fam-nova",
        slug: "vibhavgpt/nova",
        displayName: "VibhavGPT Nova",
        familyGroup: "native",
        sortOrder: 20,
      },
      version: {
        id: "ver-nova",
        versionTag: "nova-flash",
        aliases: ["nova"],
        planEligibility: "paid",
        lifecycleState: "active",
        capabilitiesDocumented: {
          vision: true,
          tools: true,
          streaming: true,
          structuredOutputs: true,
          contextWindowTokens: 1048576,
          maxOutputTokens: 65536,
          reasoningSupported: true,
          reasoningModes: ["low", "normal"],
        },
      },
      endpoints: [
        {
          id: "ep-nova",
          providerName: "paid",
          transportType: "router",
          adapterType: "chat_completions",
          endpointUrl: "https://openrouter.ai/api/v1",
          endpointState: "active",
          sortPriority: 1,
          capabilitiesVerified: { vision: true, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "denied",
            zeroDataRetention: false,
            scope: "default",
          },
          pricing: {
            pricingVersionId: "snap-nova",
            effectiveFrom: jan1,
            effectiveTo: null,
            calculatedMu: 1.20,
            consumptionCategory: "medium",
            pricingConfidence: "verified",
            inputPriceMicrosPerM: 500_000,
            outputPriceMicrosPerM: 2_000_000,
          },
        },
      ],
    },

    // 3. Paid High-complexity model (Nebula) - High tier (mu <= 7.0)
    {
      family: {
        id: "fam-nebula",
        slug: "vibhavgpt/nebula",
        displayName: "VibhavGPT Nebula",
        familyGroup: "native",
        sortOrder: 40,
      },
      version: {
        id: "ver-nebula",
        versionTag: "nebula-pro",
        aliases: ["nebula"],
        planEligibility: "paid",
        lifecycleState: "active",
        capabilitiesDocumented: {
          vision: true,
          tools: true,
          streaming: true,
          structuredOutputs: true,
          contextWindowTokens: 200000,
          maxOutputTokens: 64000,
          reasoningSupported: true,
          reasoningModes: ["low", "normal", "high"],
        },
      },
      endpoints: [
        {
          id: "ep-nebula",
          providerName: "paid",
          transportType: "router",
          adapterType: "chat_completions",
          endpointUrl: "https://openrouter.ai/api/v1",
          endpointState: "active",
          sortPriority: 1,
          capabilitiesVerified: { vision: true, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "denied",
            zeroDataRetention: true,
            scope: "default",
          },
          pricing: {
            pricingVersionId: "snap-nebula",
            effectiveFrom: jan1,
            effectiveTo: null,
            calculatedMu: 4.50,
            consumptionCategory: "high",
            pricingConfidence: "verified",
            inputPriceMicrosPerM: 2_000_000,
            outputPriceMicrosPerM: 8_000_000,
          },
        },
      ],
    },

    // 4. Pro Extra High model (Flagship Extra High: mu > 7.0)
    {
      family: {
        id: "fam-extra-high",
        slug: "partner/ultra-reasoning",
        displayName: "Ultra Reasoning Extra High",
        familyGroup: "partner",
        sortOrder: 45,
      },
      version: {
        id: "ver-extra-high",
        versionTag: "ultra-reasoning-r1",
        aliases: ["ultra-r1"],
        planEligibility: "paid",
        lifecycleState: "active",
        capabilitiesDocumented: {
          vision: false,
          tools: true,
          streaming: true,
          contextWindowTokens: 128000,
          maxOutputTokens: 32768,
          reasoningSupported: true,
        },
      },
      endpoints: [
        {
          id: "ep-extra-high",
          providerName: "paid",
          transportType: "router",
          adapterType: "chat_completions",
          endpointUrl: "https://openrouter.ai/api/v1",
          endpointState: "active",
          sortPriority: 1,
          capabilitiesVerified: { vision: false, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "denied",
            scope: "default",
          },
          pricing: {
            pricingVersionId: "snap-extra",
            effectiveFrom: jan1,
            effectiveTo: null,
            calculatedMu: 9.80, // Extra High: mu > 7.0
            consumptionCategory: "extra_high",
            pricingConfidence: "verified",
            inputPriceMicrosPerM: 5_000_000,
            outputPriceMicrosPerM: 20_000_000,
          },
        },
      ],
    },

    // 5. Native Vulcan with explicit Direct vs Router transports
    {
      family: {
        id: "fam-vesper",
        slug: "vibhavgpt/vesper",
        displayName: "VibhavGPT Vulcan",
        familyGroup: "native",
        sortOrder: 50,
      },
      version: {
        id: "ver-vesper",
        versionTag: "gpt-6.1-terra",
        aliases: ["vesper"],
        planEligibility: "pro_only",
        lifecycleState: "active",
        capabilitiesDocumented: {
          vision: true,
          tools: true,
          streaming: true,
          structuredOutputs: true,
          contextWindowTokens: 1000000,
          maxOutputTokens: 64000,
          reasoningSupported: true,
          reasoningModes: ["low", "normal", "high"],
        },
      },
      endpoints: [
        // Direct transport (Responses API)
        {
          id: "ep-vesper-direct",
          providerName: "direct",
          transportType: "direct",
          adapterType: "responses",
          endpointUrl: "https://api.openai.com/v1",
          endpointState: "active",
          sortPriority: 1,
          capabilitiesVerified: { vision: true, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: true,
            trainingPolicy: "training_excluded",
            zeroDataRetention: false,
            dataRetentionDays: 30,
            scope: "direct_enterprise_contract",
            auditRef: "openai-enterprise-io-off",
          },
          pricing: {
            pricingVersionId: "snap-vesper-direct",
            effectiveFrom: jan1,
            effectiveTo: null,
            calculatedMu: 4.80,
            consumptionCategory: "high",
            pricingConfidence: "verified",
            inputPriceMicrosPerM: 1_000_000,
            outputPriceMicrosPerM: 5_000_000,
          },
        },
        // Router transport (alternate configuration, NOT fallback)
        {
          id: "ep-vesper-router",
          providerName: "paid",
          transportType: "router",
          adapterType: "chat_completions",
          endpointUrl: "https://openrouter.ai/api/v1",
          endpointState: "active",
          sortPriority: 2,
          capabilitiesVerified: { vision: true, tools: true, streaming: true },
          privacyReview: {
            privacyApproved: false, // Router Vulcan is unapproved in production
            trainingPolicy: "denied",
            scope: "default",
          },
          pricing: {
            pricingVersionId: "snap-vesper-router",
            effectiveFrom: jan1,
            effectiveTo: null,
            calculatedMu: 4.80,
            consumptionCategory: "high",
            pricingConfidence: "verified",
            inputPriceMicrosPerM: 1_000_000,
            outputPriceMicrosPerM: 5_000_000,
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// 1. Plan Eligibility and Extra High Restrictions
// ---------------------------------------------------------------------------
test("plan eligibility: Free, Plus, and Pro boundaries including Extra High exclusion", async () => {
  const snapshot = buildSyntheticSnapshot();

  // Free user accessing Free model -> Eligible
  const freeDecision = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "lumen" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(freeDecision.eligible, true);
  assert.equal(freeDecision.selectedCandidate.familySlug, "vibhavgpt/lumen");

  // Lumen is included with Free even when its stored plan eligibility is paid (rows written before the Free launch).
  const paidLumenSnapshot = snapshot.map((entry) => (entry.family.slug === "vibhavgpt/lumen" ? { ...entry, version: { ...entry.version, planEligibility: "paid" } } : entry));
  const freeOnPaidLumen = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "lumen" } },
    { registrySnapshot: paidLumenSnapshot },
  );
  assert.equal(freeOnPaidLumen.eligible, true);
  assert.equal(freeOnPaidLumen.selectedCandidate.familySlug, "vibhavgpt/lumen");

  // Nova was included with Free too until it was retired on 2026-11-14. Its (paid) fixture row is now refused on Free, not swapped.
  const freeOnNova = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "nova" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(freeOnNova.eligible, false);
  assert.equal(freeOnNova.reasonCode, ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE);

  // Nebula stays paid. A Free request is rejected, not swapped for Lumen.
  const freeOnNebula = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "nebula" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(freeOnNebula.eligible, false);
  assert.equal(freeOnNebula.reasonCode, ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE);
  assert.equal(freeOnNebula.customerMessage, CUSTOMER_SAFE_REJECTIONS[ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE]);

  // Plus user accessing Paid High model (Nebula) -> Eligible
  const plusOnHigh = await evaluateRoutingDecision(
    { plan: "plus", requestedModel: { modelKey: "nebula" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(plusOnHigh.eligible, true);
  assert.equal(plusOnHigh.pinnedPricing.consumptionCategory, "high");

  // Plus user attempting to access Extra High model (mu > 7.0) -> Strictly rejected!
  const plusOnExtraHigh = await evaluateRoutingDecision(
    { plan: "plus", requestedModel: { versionTag: "ultra-reasoning-r1" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(plusOnExtraHigh.eligible, false);
  assert.equal(plusOnExtraHigh.reasonCode, ROUTE_DECISION_REASONS.PLUS_EXCLUDED_EXTRA_HIGH);
  assert.equal(plusOnExtraHigh.customerMessage, CUSTOMER_SAFE_REJECTIONS[ROUTE_DECISION_REASONS.PLUS_EXCLUDED_EXTRA_HIGH]);

  // Pro user accessing Extra High model -> Eligible
  const proOnExtraHigh = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { versionTag: "ultra-reasoning-r1" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(proOnExtraHigh.eligible, true);
  assert.equal(proOnExtraHigh.pinnedPricing.consumptionCategory, "extra_high");

  // Plus user attempting to access Pro-Only model (Vulcan) -> Rejected
  const plusOnVesper = await evaluateRoutingDecision(
    { plan: "plus", requestedModel: { modelKey: "vesper" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(plusOnVesper.eligible, false);
  assert.equal(plusOnVesper.reasonCode, ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE);

  // Pro user accessing Pro-Only model (Vulcan) -> Eligible
  const proOnVesper = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "vesper" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(proOnVesper.eligible, true);
});

// ---------------------------------------------------------------------------
// 2. Pending Consumption Classification and Cheap Models for Free
// ---------------------------------------------------------------------------
test("pending consumption classification locks out Plus users; cheap models are not free", async () => {
  const snapshot = buildSyntheticSnapshot();
  // Modify Nova's pricing to have consumptionCategory: "pending"
  snapshot[1].endpoints[0].pricing.consumptionCategory = "pending";

  // Plus user on a model with pending classification -> Rejected
  const plusDecision = await evaluateRoutingDecision(
    { plan: "plus", requestedModel: { modelKey: "nova" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(plusDecision.eligible, false);
  assert.equal(plusDecision.reasonCode, ROUTE_DECISION_REASONS.CONSUMPTION_CLASSIFICATION_PENDING);

  // A cheap paid model is still not included with Free. Nebula stays paid
  // even at $0.05 / 1M; Nova is the Free exception and is not this case.
  snapshot[2].endpoints[0].pricing.calculatedMu = 0.05;
  snapshot[2].endpoints[0].pricing.consumptionCategory = "low";
  const freeAttempt = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "nebula" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(freeAttempt.eligible, false);
  assert.equal(freeAttempt.reasonCode, ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE, "Cheapness does not grant Free eligibility");
});

// ---------------------------------------------------------------------------
// 3. Documented Marketing Claims vs Endpoint-Verified Capabilities
// ---------------------------------------------------------------------------
test("endpoint-verified capabilities override documented marketing claims", async () => {
  const snapshot = buildSyntheticSnapshot();
  // Version claims vision: true, but endpoint verified has vision: false
  snapshot[1].version.capabilitiesDocumented.vision = true;
  snapshot[1].endpoints[0].capabilitiesVerified.vision = false;

  const decision = await evaluateRoutingDecision(
    { plan: "plus", requestedModel: { modelKey: "nova" }, modalities: { vision: true } },
    { registrySnapshot: snapshot },
  );
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, ROUTE_DECISION_REASONS.CAPABILITY_VISION_UNSUPPORTED);
});

// ---------------------------------------------------------------------------
// 4. Privacy: Approval, Scopes, Expiration, and Revocation
// ---------------------------------------------------------------------------
test("privacy review enforcement: unapproved, expired, revoked, and scope mismatch", async () => {
  const snapshot = buildSyntheticSnapshot();

  // 1. Unapproved endpoint
  snapshot[0].endpoints[0].privacyReview.privacyApproved = false;
  const unapprovedDecision = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "lumen" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(unapprovedDecision.eligible, false);
  assert.equal(unapprovedDecision.reasonCode, ROUTE_DECISION_REASONS.PRIVACY_NOT_APPROVED);

  // Restore approval
  snapshot[0].endpoints[0].privacyReview.privacyApproved = true;

  // 2. Expired approval
  snapshot[0].endpoints[0].privacyReview.expiresAt = "2026-05-01T00:00:00Z";
  const expiredDecision = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "lumen" } },
    { registrySnapshot: snapshot, evaluatedAt: "2026-06-01T00:00:00Z" },
  );
  assert.equal(expiredDecision.eligible, false);
  assert.equal(expiredDecision.reasonCode, ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_EXPIRED);

  // Restore expiration
  snapshot[0].endpoints[0].privacyReview.expiresAt = "2027-01-01T00:00:00Z";

  // 3. Revoked approval
  snapshot[0].endpoints[0].privacyReview.revoked = true;
  snapshot[0].endpoints[0].privacyReview.revokedAt = "2026-04-01T00:00:00Z";
  const revokedDecision = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "lumen" } },
    { registrySnapshot: snapshot, evaluatedAt: "2026-04-02T00:00:00Z" },
  );
  assert.equal(revokedDecision.eligible, false);
  assert.equal(revokedDecision.reasonCode, ROUTE_DECISION_REASONS.PRIVACY_APPROVAL_REVOKED);

  // Restore revocation
  snapshot[0].endpoints[0].privacyReview.revoked = false;
  snapshot[0].endpoints[0].privacyReview.revokedAt = null;

  // 4. Scope mismatch: request requires "direct_enterprise_contract", endpoint has "default"
  const scopeMismatchDecision = await evaluateRoutingDecision(
    {
      plan: "free",
      requestedModel: { modelKey: "lumen" },
      privacy: { requiredScope: "direct_enterprise_contract" },
    },
    { registrySnapshot: snapshot },
  );
  assert.equal(scopeMismatchDecision.eligible, false);
  assert.equal(scopeMismatchDecision.reasonCode, ROUTE_DECISION_REASONS.PRIVACY_SCOPE_MISMATCH);
});

// ---------------------------------------------------------------------------
// 5. Context Limits and Reasoning Compatibility
// ---------------------------------------------------------------------------
test("context window limits and reasoning mode compatibility", async () => {
  const snapshot = buildSyntheticSnapshot();

  // Exceed context window
  const overflowContext = await evaluateRoutingDecision(
    {
      plan: "free",
      requestedModel: { modelKey: "lumen" },
      context: { totalRequiredContextTokens: 200000 }, // Lumen limit is 131072
    },
    { registrySnapshot: snapshot },
  );
  assert.equal(overflowContext.eligible, false);
  assert.equal(overflowContext.reasonCode, ROUTE_DECISION_REASONS.CONTEXT_WINDOW_EXCEEDED);

  // Reasoning requested on model that does not support reasoning (Lumen)
  const invalidReasoning = await evaluateRoutingDecision(
    {
      plan: "free",
      requestedModel: { modelKey: "lumen" },
      reasoning: { effort: "high" },
    },
    { registrySnapshot: snapshot },
  );
  assert.equal(invalidReasoning.eligible, false);
  assert.equal(invalidReasoning.reasonCode, ROUTE_DECISION_REASONS.REASONING_NOT_SUPPORTED);

  // Reasoning mode unsupported: Nova supports ["low", "normal"], user requests "max"
  const unsupportedMode = await evaluateRoutingDecision(
    {
      plan: "plus",
      requestedModel: { modelKey: "nova" },
      reasoning: { effort: "max" },
    },
    { registrySnapshot: snapshot },
  );
  assert.equal(unsupportedMode.eligible, false);
  assert.equal(unsupportedMode.reasonCode, ROUTE_DECISION_REASONS.REASONING_MODE_UNSUPPORTED);
});

// ---------------------------------------------------------------------------
// 6. Explicit Selection Never Substituted vs Deterministic Auto Selection
// ---------------------------------------------------------------------------
test("explicit model selection is never silently substituted", async () => {
  const snapshot = buildSyntheticSnapshot();

  // Requesting a non-existent model returns MODEL_NOT_FOUND, never a fallback
  const missing = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { versionTag: "non-existent-model" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(missing.eligible, false);
  assert.equal(missing.reasonCode, ROUTE_DECISION_REASONS.MODEL_NOT_FOUND);

  // An ineligible explicit choice (Free requesting Nebula) is rejected, never replaced with Lumen.
  const ineligible = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "nebula" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(ineligible.eligible, false);
  assert.equal(ineligible.reasonCode, ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE);
  // The same for the paid fixture row that was once Free-included (Nova, retired 2026-11-14): refused, never replaced with Lumen.
  const freeNova = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { modelKey: "nova" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(freeNova.eligible, false);
  assert.equal(freeNova.reasonCode, ROUTE_DECISION_REASONS.PLAN_NOT_ELIGIBLE);
  assert.equal(freeNova.selectedCandidate ?? null, null, "no substitute is selected");
});

test("deterministic Auto selection routes based on task affinity and tie-breakers", async () => {
  const snapshot = buildSyntheticSnapshot();

  // 1. Auto routing with lightweight task for Free user -> selects Lumen
  const autoFree = await evaluateRoutingDecision(
    { plan: "free", requestedModel: { auto: true, task: { classification: "lightweight" } } },
    { registrySnapshot: snapshot },
  );
  assert.equal(autoFree.eligible, true);
  assert.equal(autoFree.selectedCandidate.familySlug, "vibhavgpt/lumen");
  assert.equal(autoFree.metadata.autoSelected, true);

  // 2. Auto routing with reasoning task for Plus user -> steps down to Nebula (High), avoiding Extra High
  const autoPlusReasoning = await evaluateRoutingDecision(
    { plan: "plus", requestedModel: { auto: true, task: { classification: "reasoning" } } },
    { registrySnapshot: snapshot },
  );
  assert.equal(autoPlusReasoning.eligible, true);
  assert.equal(autoPlusReasoning.selectedCandidate.familySlug, "vibhavgpt/nebula");
  assert.equal(autoPlusReasoning.pinnedPricing.consumptionCategory, "high");

  // 3. Auto routing with reasoning task for Pro user -> selects Extra High model
  const autoProReasoning = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { auto: true, task: { classification: "reasoning" } } },
    { registrySnapshot: snapshot },
  );
  assert.equal(autoProReasoning.eligible, true);
  assert.equal(autoProReasoning.pinnedPricing.consumptionCategory, "extra_high");
});

// ---------------------------------------------------------------------------
// 7. Native Vulcan Isolation: Explicit Direct Transport with Zero Cross-Over
// ---------------------------------------------------------------------------
test("native Vulcan preserves explicit direct transport with no fallback to router", async () => {
  const snapshot = buildSyntheticSnapshot();

  // Pro user requests Vulcan with default/explicit direct transport
  const vesperDirect = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "vesper" }, transportPreference: "direct" },
    { registrySnapshot: snapshot },
  );
  assert.equal(vesperDirect.eligible, true);
  assert.equal(vesperDirect.pinnedEndpoint.transportType, "direct");
  assert.equal(vesperDirect.pinnedEndpoint.adapterType, "responses");

  // If direct endpoint is disabled or unapproved, it MUST NOT fall back to router!
  snapshot[4].endpoints[0].endpointState = "disabled";
  const vesperDirectDisabled = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "vesper" }, transportPreference: "direct" },
    { registrySnapshot: snapshot },
  );
  assert.equal(vesperDirectDisabled.eligible, false);
  assert.equal(
    vesperDirectDisabled.reasonCode,
    ROUTE_DECISION_REASONS.ENDPOINT_NOT_ACTIVE,
    "Direct Vulcan never falls back to router transport",
  );
});

// ---------------------------------------------------------------------------
// 8. Snapshot Immutability and Pre-Dispatch Revalidation Boundary
// ---------------------------------------------------------------------------
test("decision snapshot immutability and pre-dispatch revalidation", async () => {
  const snapshot = buildSyntheticSnapshot();

  const decision = await evaluateRoutingDecision(
    { plan: "plus", requestedModel: { modelKey: "nova" } },
    { registrySnapshot: snapshot },
  );
  assert.equal(decision.eligible, true);

  // 1. Verify deep freeze immutability: attempts to mutate decision fail
  assert.throws(() => {
    decision.pinnedPricing.inputPriceMicrosPerM = 999;
  }, /TypeError/);

  // 2. Pre-dispatch revalidation against healthy endpoint -> Valid
  const healthyEndpoint = snapshot[1].endpoints[0];
  const revalPass = revalidateRoutingDecision(decision, healthyEndpoint);
  assert.equal(revalPass.valid, true);

  // 3. Pre-dispatch revalidation detects administrative revocation occurring after decision
  const revokedEndpoint = {
    ...healthyEndpoint,
    privacyReview: {
      ...healthyEndpoint.privacyReview,
      revoked: true,
      revokedAt: new Date().toISOString(),
    },
  };
  const revalFail = revalidateRoutingDecision(decision, revokedEndpoint);
  assert.equal(revalFail.valid, false);
  assert.equal(revalFail.reason, "privacy_approval_revoked");

  // 4. Pre-dispatch revalidation detects disabled endpoint
  const disabledEndpoint = { ...healthyEndpoint, endpointState: "disabled" };
  const revalDisabled = revalidateRoutingDecision(decision, disabledEndpoint);
  assert.equal(revalDisabled.valid, false);
  assert.equal(revalDisabled.reason, "endpoint_no_longer_active");
});

// ---------------------------------------------------------------------------
// 9. Customer-Safe Output Serialization
// ---------------------------------------------------------------------------
test("customer-safe output serialization scrubs wholesale prices and endpoint URLs", async () => {
  const snapshot = buildSyntheticSnapshot();

  const decision = await evaluateRoutingDecision(
    {
      plan: "plus",
      requestedModel: { modelKey: "nova" },
      context: { estimatedInputTokens: 1000, maxOutputTokens: 500 },
    },
    { registrySnapshot: snapshot },
  );
  assert.equal(decision.eligible, true);

  const clientJson = serializeDecisionForClient(decision);

  // Client JSON must include user-facing badges
  assert.equal(clientJson.eligible, true);
  assert.equal(clientJson.model, "nova-flash");
  assert.equal(clientJson.displayName, "VibhavGPT Nova");
  assert.equal(clientJson.consumptionCategory, "medium");
  assert.equal(clientJson.capabilities.vision, true);

  // Client JSON must strictly exclude internal wholesale prices and network URLs
  assert.equal(clientJson.inputPriceMicrosPerM, undefined);
  assert.equal(clientJson.outputPriceMicrosPerM, undefined);
  assert.equal(clientJson.endpointUrl, undefined);
  assert.equal(clientJson.pinnedEndpoint, undefined);
  assert.equal(clientJson.budgetEvaluation, undefined);
  assert.equal(JSON.stringify(clientJson).includes("openrouter.ai"), false);
});

// ---------------------------------------------------------------------------
// 10. Database Loading & Revocation via DB Service
// ---------------------------------------------------------------------------
test("decision service works end-to-end with database snapshot and revocation", async (t) => {
  const { db } = await createTestDb(t);

  const fam = await createModelFamily({ slug: "vibhavgpt/study", displayName: "VibhavGPT Study" }, db);
  const ver = await createModelVersion({
    familyId: fam.id,
    versionTag: "gpt-6-luna",
    planEligibility: PLAN_ELIGIBILITY.PAID,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
    capabilitiesDocumented: { vision: true, tools: true, streaming: true },
  }, db);
  const ep = await createModelEndpoint({
    versionId: ver.id,
    providerName: "study",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
    capabilitiesVerified: { vision: true, tools: true, streaming: true },
    privacyReview: {
      privacyApproved: true,
      trainingPolicy: "training_excluded",
      scope: "direct_enterprise_contract",
    },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  await createPricingSnapshot({
    endpointId: ep.id,
    pricingVersionId: "snap-study-1",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    inputPriceMicrosPerM: 100_000,
    outputPriceMicrosPerM: 500_000,
    pricingConfidence: "verified",
    provenance: "contract",
  }, db);

  // Load immutable snapshot from database
  const loadedSnapshot = await loadRegistrySnapshot(db);
  assert.equal(loadedSnapshot.length, 1);
  assert.equal(loadedSnapshot[0].family.slug, "vibhavgpt/study");

  // Evaluate decision
  const decision = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { familySlug: "vibhavgpt/study" } },
    { registrySnapshot: loadedSnapshot },
  );
  assert.equal(decision.eligible, true);
  assert.equal(decision.selectedCandidate.versionTag, "gpt-6-luna");

  // Revoke endpoint privacy review in database
  await revokeEndpointPrivacyReview(ep.id, { reason: "Compliance audit failure" }, db);

  // Check that current state in DB has revoked: true and endpointState: disabled
  const [updatedEp] = await db.select().from(schema.modelEndpoints).where(eq(schema.modelEndpoints.id, ep.id));
  assert.equal(updatedEp.endpointState, "disabled");
  assert.equal(updatedEp.privacyReview.revoked, true);

  // Pre-dispatch revalidation cleanly rejects
  const reval = revalidateRoutingDecision(decision, updatedEp);
  assert.equal(reval.valid, false);
});

// ---------------------------------------------------------------------------
// 11. Invariant: Existing Live Routing Unaffected with Empty or Populated Registry
// ---------------------------------------------------------------------------
test("existing live routing remains completely unaffected by decision service", async (t) => {
  const { db } = await createTestDb(t);

  // Check live static configs before any registry activity
  const lumenConfig = getModelConfig("lumen");
  const vesperConfig = getModelConfig("vesper");
  const studyConfig = getModelConfig("study");

  assert.equal(lumenConfig.displayName, "VibhavGPT Lumen");
  assert.equal(vesperConfig.displayName, "VibhavGPT Vulcan");
  assert.equal(studyConfig.displayName, "VibhavGPT Study");
  assert.equal(MODEL_ALIASES.spark, "lumen");

  // Evaluate decision with empty registry (clean rejection)
  const emptyDecision = await evaluateRoutingDecision(
    { plan: "pro", requestedModel: { modelKey: "lumen" } },
    { registrySnapshot: [] },
  );
  assert.equal(emptyDecision.eligible, false);
  assert.equal(emptyDecision.reasonCode, ROUTE_DECISION_REASONS.REGISTRY_EMPTY);

  // Live routing remains 100% functional and static
  const liveLumen = getModelConfig("lumen");
  assert.equal(liveLumen.displayName, "VibhavGPT Lumen");
  assert.equal(liveLumen.supportsVision, false);
});
