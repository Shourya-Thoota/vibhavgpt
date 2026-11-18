import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";

import {
  CONSUMPTION_CATEGORIES,
  calculateConsumptionScore,
  sanitizeConsumptionForClient,
} from "../src/models/consumption.js";
import {
  INVENTORY_SOURCES,
  VERIFIED_PRODUCTION_OBSERVATION,
  buildNativeCompatibilityInventory,
  createConfigurationSnapshot,
} from "../src/models/inventory.js";
import {
  ALLOWLISTED_CATALOG_HOSTS,
  CatalogImportSecurityError,
  importCatalogFromUrl,
  normalizeCatalogItem,
  validateCatalogUrl,
} from "../src/models/importer.js";
import {
  ALLOWED_LIFECYCLE_TRANSITIONS,
  checkModelEligibility,
  createModelEndpoint,
  createModelFamily,
  createModelVersion,
  createPricingSnapshot,
  getEffectivePricingSnapshot,
  getModelFamilyBySlug,
  getModelVersion,
  LIFECYCLE_STATES,
  ModelRegistryValidationError,
  PLAN_ELIGIBILITY,
  seedNativeCompatibilityInventory,
  transitionModelVersionState,
  updateEndpointPrivacyReview,
} from "../src/models/registry.js";
import {
  modelEndpoints,
  modelFamilies,
  modelPricingSnapshots,
  modelVersions,
} from "../src/db/schema.js";
import { getModelConfig } from "../src/chat/providers.js";
import { MODEL_ALIASES } from "../src/chat/model-keys.js";

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    const migrationSql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await client.exec(migrationSql);
  }
  return { client, db: drizzle(client) };
}

// ---------------------------------------------------------------------------
// 1. Migrations: Fresh DB, Preceding Upgrade, and Runner Idempotency
// ---------------------------------------------------------------------------
test("model registry migrations: fresh database and upgrade from 0033", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const migration34Sql = await readFile(new URL("../drizzle/0034_model_registry.sql", import.meta.url), "utf8");

  // Fresh DB applying all migrations including 0034
  const freshClient = new PGlite();
  for (const entry of journal.entries) {
    const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await freshClient.exec(sql);
  }
  const familiesCheck = await freshClient.query("SELECT to_regclass('model_families') AS name");
  const versionsCheck = await freshClient.query("SELECT to_regclass('model_versions') AS name");
  const endpointsCheck = await freshClient.query("SELECT to_regclass('model_endpoints') AS name");
  const pricingCheck = await freshClient.query("SELECT to_regclass('model_pricing_snapshots') AS name");

  assert.equal(familiesCheck.rows[0].name, "model_families");
  assert.equal(versionsCheck.rows[0].name, "model_versions");
  assert.equal(endpointsCheck.rows[0].name, "model_endpoints");
  assert.equal(pricingCheck.rows[0].name, "model_pricing_snapshots");
  await freshClient.close();

  // Upgrade DB at preceding migration 0033 (0..32 entries)
  const upgradeClient = new PGlite();
  for (const entry of journal.entries.slice(0, 33)) {
    const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await upgradeClient.exec(sql);
  }
  const before34 = await upgradeClient.query("SELECT to_regclass('model_families') AS name");
  assert.equal(before34.rows[0].name, null, "model_families does not exist before 0034");

  // Apply migration 0034
  await upgradeClient.exec(migration34Sql);
  const after34 = await upgradeClient.query("SELECT to_regclass('model_families') AS name");
  assert.equal(after34.rows[0].name, "model_families");

  // Idempotency: re-applying 0034 executes without error
  await upgradeClient.exec(migration34Sql);
  await upgradeClient.close();
});

// ---------------------------------------------------------------------------
// 2. Consumption Score (mu) Formulation and Thresholds
// ---------------------------------------------------------------------------
test("consumption score (mu) calculation matches mathematical specification", () => {
  // Baseline Denominator rates: $1.00 in / $4.00 out per 1M (mu = 1.10) -> Medium
  const baseline = calculateConsumptionScore(1_000_000, 4_000_000);
  assert.equal(baseline.calculatedMu, 1.1);
  assert.equal(baseline.consumptionCategory, CONSUMPTION_CATEGORIES.MEDIUM);

  // Nova rates: $0.10 in / $0.50 out per 1M
  // mu = 1.10 * [ 0.5 * 0.10 + 0.125 * 0.50 ] = 1.10 * [ 0.05 + 0.0625 ] = 1.10 * 0.1125 = 0.1238 -> Low
  const nova = calculateConsumptionScore(100_000, 500_000);
  assert.equal(nova.calculatedMu, 0.1238);
  assert.equal(nova.consumptionCategory, CONSUMPTION_CATEGORIES.LOW);

  // Nebula rates: $0.75 in / $3.75 out per 1M
  // mu = 1.10 * [ 0.5 * 0.75 + 0.125 * 3.75 ] = 1.10 * [ 0.375 + 0.46875 ] = 1.10 * 0.84375 = 0.9281 -> Low
  const nebula = calculateConsumptionScore(750_000, 3_750_000);
  assert.equal(nebula.calculatedMu, 0.9281);
  assert.equal(nebula.consumptionCategory, CONSUMPTION_CATEGORIES.LOW);

  // High tier: $3.00 in / $15.00 out per 1M (mu = 3.7125) -> High (2.0 < mu <= 7.0)
  const highTier = calculateConsumptionScore(3_000_000, 15_000_000);
  assert.equal(highTier.calculatedMu, 3.7125);
  assert.equal(highTier.consumptionCategory, CONSUMPTION_CATEGORIES.HIGH);

  // Extra High tier: $8.00 in / $32.00 out per 1M (mu = 8.8000) -> Extra High (mu > 7.0)
  const extraHigh = calculateConsumptionScore(8_000_000, 32_000_000);
  assert.equal(extraHigh.calculatedMu, 8.8);
  assert.equal(extraHigh.consumptionCategory, CONSUMPTION_CATEGORIES.EXTRA_HIGH);

  // Unknown / Missing pricing: mu must remain null and category pending, NEVER zero
  const unpriced = calculateConsumptionScore(null, null);
  assert.equal(unpriced.calculatedMu, null);
  assert.equal(unpriced.consumptionCategory, CONSUMPTION_CATEGORIES.PENDING);

  // Explicitly verified free tier: $0 in / $0 out -> mu = 0.0, Low
  const freeTier = calculateConsumptionScore(0, 0);
  assert.equal(freeTier.calculatedMu, 0);
  assert.equal(freeTier.consumptionCategory, CONSUMPTION_CATEGORIES.LOW);

  // Client sanitization: hides raw numeric mu score
  const clientSanitized = sanitizeConsumptionForClient(CONSUMPTION_CATEGORIES.HIGH);
  assert.equal(clientSanitized.category, "high");
  assert.equal(clientSanitized.label, "High compute consumption");
  assert.equal("calculatedMu" in clientSanitized, false, "Raw numeric score is never sent to client");
});

// ---------------------------------------------------------------------------
// 3. Model, Version, Endpoint, and Pricing Separation
// ---------------------------------------------------------------------------
test("relational registry separates family, version, endpoint, and pricing", async (t) => {
  const { db } = await createDatabase(t);

  // 1. Model Family (Stable lineage)
  const family = await createModelFamily({
    slug: "openai/gpt-6.1-terra",
    displayName: "GPT-6.1 Terra",
    familyGroup: "openai",
    sortOrder: 1,
  }, db);
  assert.ok(family.id);

  // 2. Specific Model Version
  const version = await createModelVersion({
    familyId: family.id,
    versionTag: "gpt-6.1-terra-2026-09-01",
    aliases: ["terra-0901"],
    capabilitiesDocumented: { vision: true, tools: true, contextWindowTokens: 1_000_000 },
    planEligibility: PLAN_ELIGIBILITY.PRO_ONLY,
  }, db);
  assert.ok(version.id);
  assert.equal(version.lifecycleState, LIFECYCLE_STATES.CANDIDATE);

  // 3. Distinct Endpoints for the SAME version:
  // Endpoint A: Direct OpenAI connection
  const directEndpoint = await createModelEndpoint({
    versionId: version.id,
    providerName: "direct",
    transportType: "direct",
    adapterType: "responses",
    endpointUrl: "https://api.openai.com/v1",
    capabilitiesVerified: { streaming: true, tools: true, vision: true },
    privacyReview: { privacyApproved: true, zeroDataRetention: false, dataRetentionDays: 30 },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);

  // Endpoint B: Router OpenRouter connection (different endpoint URL and verified capabilities)
  const routerEndpoint = await createModelEndpoint({
    versionId: version.id,
    providerName: "openrouter",
    transportType: "router",
    adapterType: "chat_completions",
    endpointUrl: "https://openrouter.ai/api/v1",
    capabilitiesVerified: { streaming: true, tools: true, vision: false }, // Vision unverified on router
    privacyReview: { privacyApproved: false },
    endpointState: LIFECYCLE_STATES.CANDIDATE,
  }, db);

  assert.notEqual(directEndpoint.id, routerEndpoint.id);
  assert.equal(directEndpoint.capabilitiesVerified.vision, true);
  assert.equal(routerEndpoint.capabilitiesVerified.vision, false);

  // 4. Point-in-time Pricing Snapshot
  const pricing = await createPricingSnapshot({
    endpointId: directEndpoint.id,
    pricingVersionId: "pricing_snapshot_2026_10",
    inputPriceMicrosPerM: 1_000_000,
    outputPriceMicrosPerM: 5_000_000,
    cachedReadPriceMicrosPerM: 50_000,
    pricingConfidence: "verified_published",
    provenance: "contract_ref:direct_openai",
  }, db);

  assert.equal(pricing.inputPriceMicrosPerM, 1_000_000);
  assert.equal(pricing.calculatedMu, 1.2375);
  assert.equal(pricing.consumptionCategory, CONSUMPTION_CATEGORIES.MEDIUM);
});

// ---------------------------------------------------------------------------
// 4. Strict Lifecycle State Transitions
// ---------------------------------------------------------------------------
test("lifecycle transitions follow strict validated state machine", async (t) => {
  const { db } = await createDatabase(t);

  const family = await createModelFamily({
    slug: "test/lifecycle-model",
    displayName: "Lifecycle Test Model",
  }, db);

  const version = await createModelVersion({
    familyId: family.id,
    versionTag: "v1.0.0",
  }, db);
  assert.equal(version.lifecycleState, LIFECYCLE_STATES.CANDIDATE);

  // Invalid: Candidate -> Active directly is forbidden
  await assert.rejects(
    transitionModelVersionState(version.id, LIFECYCLE_STATES.ACTIVE, {}, db),
    (err) => err instanceof ModelRegistryValidationError && err.code === "invalid_transition",
  );

  // Valid: Candidate -> Reviewed
  const reviewed = await transitionModelVersionState(version.id, LIFECYCLE_STATES.REVIEWED, { reason: "Code audit passed" }, db);
  assert.equal(reviewed.lifecycleState, LIFECYCLE_STATES.REVIEWED);

  // Invalid: Reviewed -> Active without privacy-approved endpoint is forbidden
  await assert.rejects(
    transitionModelVersionState(version.id, LIFECYCLE_STATES.ACTIVE, {}, db),
    (err) => err instanceof ModelRegistryValidationError && err.code === "privacy_approval_required",
  );

  // Add a privacy-approved endpoint
  const endpoint = await createModelEndpoint({
    versionId: version.id,
    providerName: "approved-provider",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
    privacyReview: { privacyApproved: true, zeroDataRetention: true },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  assert.ok(endpoint.id);

  // Valid: Reviewed -> Active now succeeds
  const active = await transitionModelVersionState(version.id, LIFECYCLE_STATES.ACTIVE, { reason: "Approved for deployment" }, db);
  assert.equal(active.lifecycleState, LIFECYCLE_STATES.ACTIVE);

  // Valid: Active -> Deprecated
  const deprecated = await transitionModelVersionState(version.id, LIFECYCLE_STATES.DEPRECATED, { reason: "Superseded" }, db);
  assert.equal(deprecated.lifecycleState, LIFECYCLE_STATES.DEPRECATED);

  // Valid: Deprecated -> Disabled
  const disabled = await transitionModelVersionState(version.id, LIFECYCLE_STATES.DISABLED, { reason: "End of life" }, db);
  assert.equal(disabled.lifecycleState, LIFECYCLE_STATES.DISABLED);

  // Invalid: Disabled -> Active directly is forbidden
  await assert.rejects(
    transitionModelVersionState(version.id, LIFECYCLE_STATES.ACTIVE, {}, db),
    (err) => err instanceof ModelRegistryValidationError && err.code === "invalid_transition",
  );
});

// ---------------------------------------------------------------------------
// 5. Model Replacement Does NOT Inherit Privacy Approval
// ---------------------------------------------------------------------------
test("model replacement does not inherit privacy approval from previous versions", async (t) => {
  const { db } = await createDatabase(t);

  const family = await createModelFamily({
    slug: "anthropic/claude-sonnet",
    displayName: "Claude Sonnet Family",
  }, db);

  // Version 1 is active with verified privacy approval
  const v1 = await createModelVersion({
    familyId: family.id,
    versionTag: "claude-3-7-sonnet-20250219",
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  await createModelEndpoint({
    versionId: v1.id,
    providerName: "anthropic-direct",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
    privacyReview: { privacyApproved: true, auditRef: "audit-2025-01" },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);

  // Version 2 arrives as a candidate replacement
  const v2 = await createModelVersion({
    familyId: family.id,
    versionTag: "claude-3-8-sonnet-20261001",
    lifecycleState: LIFECYCLE_STATES.CANDIDATE,
  }, db);

  // Create endpoint for Version 2: default privacyApproved is false
  const ep2 = await createModelEndpoint({
    versionId: v2.id,
    providerName: "anthropic-direct",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
    endpointState: LIFECYCLE_STATES.CANDIDATE,
  }, db);

  assert.equal(v2.lifecycleState, LIFECYCLE_STATES.CANDIDATE);
  assert.equal(ep2.privacyReview.privacyApproved, false, "Replacement does NOT inherit privacy approval");

  // Attempting to transition Version 2 to active must fail
  await transitionModelVersionState(v2.id, LIFECYCLE_STATES.REVIEWED, {}, db);
  await assert.rejects(
    transitionModelVersionState(v2.id, LIFECYCLE_STATES.ACTIVE, {}, db),
    (err) => err instanceof ModelRegistryValidationError && err.code === "privacy_approval_required",
  );
});

// ---------------------------------------------------------------------------
// 6. Capability-Aware and Plan-Aware Eligibility Checking
// ---------------------------------------------------------------------------
test("model eligibility checks evaluate capabilities, plan, and endpoint compliance", async (t) => {
  const { db } = await createDatabase(t);

  const family = await createModelFamily({
    slug: "test/eligibility-family",
    displayName: "Eligibility Test",
  }, db);

  const version = await createModelVersion({
    familyId: family.id,
    versionTag: "v1-pro",
    capabilitiesDocumented: { vision: true, tools: false },
    planEligibility: PLAN_ELIGIBILITY.PRO_ONLY,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
  }, db);

  await createModelEndpoint({
    versionId: version.id,
    providerName: "provider-direct",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
    capabilitiesVerified: { vision: true, tools: false, streaming: true },
    privacyReview: { privacyApproved: true },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);

  // Free user denied (model requires pro)
  const freeCheck = await checkModelEligibility(version.id, { userPlan: "free" }, db);
  assert.equal(freeCheck.eligible, false);
  assert.equal(freeCheck.reason, "requires_pro_plan");

  // Plus user denied
  const plusCheck = await checkModelEligibility(version.id, { userPlan: "plus" }, db);
  assert.equal(plusCheck.eligible, false);

  // Pro user allowed
  const proCheck = await checkModelEligibility(version.id, { userPlan: "pro" }, db);
  assert.equal(proCheck.eligible, true);

  // Tool requirement fails (model does not support tools)
  const toolCheck = await checkModelEligibility(version.id, { userPlan: "pro", requiresTools: true }, db);
  assert.equal(toolCheck.eligible, false);
  assert.equal(toolCheck.reason, "tools_unsupported");

  // Vision requirement succeeds
  const visionCheck = await checkModelEligibility(version.id, { userPlan: "pro", requiresVision: true }, db);
  assert.equal(visionCheck.eligible, true);
});

// ---------------------------------------------------------------------------
// 7. Security: Zero Credential Storage Prohibited
// ---------------------------------------------------------------------------
test("security: endpoint URLs reject embedded API keys or tokens", async (t) => {
  const { db } = await createDatabase(t);
  const family = await createModelFamily({ slug: "test/security", displayName: "Sec" }, db);
  const version = await createModelVersion({ familyId: family.id, versionTag: "sec-1" }, db);

  await assert.rejects(
    createModelEndpoint({
      versionId: version.id,
      providerName: "leaky-provider",
      transportType: "direct",
      endpointUrl: "https://api.openai.com/v1?key=sk-secret-123456",
    }, db),
    (err) => err instanceof ModelRegistryValidationError && err.code === "credential_storage_prohibited",
  );
});

// ---------------------------------------------------------------------------
// 8. Catalog Importer: Allowlisted Hosts, Streaming Read Limits, Redirects, and Deadlines
// ---------------------------------------------------------------------------
test("catalog importer enforces allowlist, dryRun safety, and candidate status", async () => {
  // Non-allowlisted host rejected
  assert.throws(
    () => validateCatalogUrl("https://untrusted-third-party.com/models"),
    (err) => err instanceof CatalogImportSecurityError && err.code === "unauthorized_catalog_host",
  );

  // Non-HTTPS rejected
  assert.throws(
    () => validateCatalogUrl("http://openrouter.ai/api/v1/models"),
    (err) => err instanceof CatalogImportSecurityError && err.code === "insecure_protocol",
  );

  // Embedded credentials rejected
  assert.throws(
    () => validateCatalogUrl("https://user:pass@openrouter.ai/api/v1/models"),
    (err) => err instanceof CatalogImportSecurityError && err.code === "credentials_in_url",
  );

  // Mock OpenRouter response
  const mockOpenRouterCatalog = {
    data: [
      {
        id: "meta-llama/llama-3.3-70b-instruct",
        name: "Meta: Llama 3.3 70B Instruct",
        context_length: 131072,
        pricing: {
          prompt: "0.00000012", // $0.12 / 1M
          completion: "0.00000030", // $0.30 / 1M
        },
        architecture: { modality: "text->text" },
      },
      {
        id: "deepseek/deepseek-r1",
        name: "DeepSeek R1",
        context_length: 65536,
        pricing: {
          prompt: "0.00000055", // $0.55 / 1M
          completion: "0.00000219", // $2.19 / 1M
        },
        architecture: { modality: "text->text" },
      },
    ],
  };

  const mockFetch = async () => ({
    ok: true,
    headers: new Map([["content-length", "1024"]]),
    text: async () => JSON.stringify(mockOpenRouterCatalog),
  });

  // Default dryRun: true parses candidates without writing to database
  const dryRunResult = await importCatalogFromUrl("https://openrouter.ai/api/v1/models", {
    fetchImpl: mockFetch,
    dryRun: true,
  });

  assert.equal(dryRunResult.dryRun, true);
  assert.equal(dryRunResult.candidatesFound, 2);
  assert.equal(dryRunResult.candidates[0].familySlug, "meta-llama/llama-3.3-70b-instruct");
  assert.equal(dryRunResult.candidates[0].pricing.inputPriceMicrosPerM, 120_000);
  assert.equal(dryRunResult.candidates[0].pricing.outputPriceMicrosPerM, 300_000);
  assert.equal(dryRunResult.candidates[0].pricing.consumptionCategory, CONSUMPTION_CATEGORIES.LOW);

  // Bounded read while streaming: exceeding maxBytes aborts reader immediately
  let readerCancelled = false;
  const streamingGiantFetch = async () => ({
    ok: true,
    headers: new Map([]),
    body: {
      getReader: () => {
        let count = 0;
        return {
          read: async () => {
            count++;
            if (count > 5) return { done: true, value: undefined };
            return { done: false, value: new Uint8Array(500) }; // 500 bytes per chunk
          },
          cancel: async () => {
            readerCancelled = true;
          },
        };
      },
    },
  });

  await assert.rejects(
    importCatalogFromUrl("https://openrouter.ai/api/v1/models", { fetchImpl: streamingGiantFetch, maxBytes: 1000 }),
    (err) => err instanceof CatalogImportSecurityError && err.code === "response_too_large",
  );
  assert.equal(readerCancelled, true, "Streaming reader is cancelled immediately when byte limit exceeded");

  // Redirect rejection
  const redirectFetch = async () => ({
    status: 302,
    ok: false,
    headers: new Map([["location", "https://malicious.com/api"]]),
  });
  await assert.rejects(
    importCatalogFromUrl("https://openrouter.ai/api/v1/models", { fetchImpl: redirectFetch }),
    (err) => err instanceof CatalogImportSecurityError && err.code === "redirect_prohibited",
  );

  // Final destination host validation: if redirected to unallowlisted host, rejects
  const redirectDestinationFetch = async () => ({
    ok: true,
    url: "https://evil-unauthorized-host.com/models",
    headers: new Map([]),
    text: async () => JSON.stringify(mockOpenRouterCatalog),
  });
  await assert.rejects(
    importCatalogFromUrl("https://openrouter.ai/api/v1/models", { fetchImpl: redirectDestinationFetch }),
    (err) => err instanceof CatalogImportSecurityError && err.code === "unauthorized_catalog_host",
  );

  // Total deadline timeout test
  const hangingFetch = async (_url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  await assert.rejects(
    importCatalogFromUrl("https://openrouter.ai/api/v1/models", { fetchImpl: hangingFetch, timeoutMs: 30 }),
    (err) => err instanceof CatalogImportSecurityError && err.code === "catalog_import_timeout",
  );

  // Negative price rejection
  const negativePricingFetch = async () => ({
    ok: true,
    headers: new Map([["content-length", "1024"]]),
    text: async () => JSON.stringify({
      data: [{ id: "bad/negative-model", pricing: { prompt: "-0.50", completion: "1.00" } }],
    }),
  });
  await assert.rejects(
    importCatalogFromUrl("https://openrouter.ai/api/v1/models", { fetchImpl: negativePricingFetch }),
    (err) => err instanceof CatalogImportSecurityError && err.code === "invalid_price",
  );
});

test("catalog importer persists candidate records idempotently without overwriting approvals", async (t) => {
  const { db } = await createDatabase(t);

  const mockCatalog = {
    data: [
      {
        id: "mistralai/mistral-large-2411",
        name: "Mistral Large 2411",
        context_length: 128000,
        pricing: { prompt: "0.000002", completion: "0.000006" },
      },
    ],
  };

  const mockFetch = async () => ({
    ok: true,
    headers: new Map([["content-length", "500"]]),
    text: async () => JSON.stringify(mockCatalog),
  });

  // 1. Initial import with dryRun: false
  const import1 = await importCatalogFromUrl("https://openrouter.ai/api/v1/models", {
    fetchImpl: mockFetch,
    dryRun: false,
  }, db);

  assert.equal(import1.importedCount, 1);
  const v1 = import1.records[0].version;
  const ep1 = import1.records[0].endpoint;
  assert.equal(v1.lifecycleState, LIFECYCLE_STATES.CANDIDATE);
  assert.equal(ep1.privacyReview.privacyApproved, false);

  // 2. An auditor reviews and approves the endpoint
  await updateEndpointPrivacyReview(ep1.id, {
    privacyApproved: true,
    trainingPolicy: "denied",
    zeroDataRetention: true,
    auditRef: "audit-mistral-2026",
    reviewedBy: "compliance_officer",
  }, db);
  await transitionModelVersionState(v1.id, LIFECYCLE_STATES.REVIEWED, {}, db);
  await transitionModelVersionState(v1.id, LIFECYCLE_STATES.ACTIVE, {}, db);

  // 3. A subsequent re-import occurs
  const import2 = await importCatalogFromUrl("https://openrouter.ai/api/v1/models", {
    fetchImpl: mockFetch,
    dryRun: false,
  }, db);
  assert.equal(import2.importedCount, 1);

  // 4. Verify that reviewed/active lifecycle state and privacy approval were preserved
  const recheckedVersion = await getModelVersion(v1.id, db);
  const [recheckedEndpoint] = await db.select().from(modelEndpoints).where(eq(modelEndpoints.id, ep1.id));

  assert.equal(recheckedVersion.lifecycleState, LIFECYCLE_STATES.ACTIVE, "Re-import does NOT downgrade active state");
  assert.equal(recheckedEndpoint.privacyReview.privacyApproved, true, "Re-import does NOT overwrite privacy approval");
});

test("pricing snapshot point-in-time immutability", async (t) => {
  const { db } = await createDatabase(t);

  const family = await createModelFamily({ slug: "test/immutability", displayName: "Immutability Test" }, db);
  const version = await createModelVersion({ familyId: family.id, versionTag: "imm-1" }, db);
  const endpoint = await createModelEndpoint({
    versionId: version.id,
    providerName: "direct",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
  }, db);

  // Initial pricing effective Jan 1, 2026 ($1.00 in / $4.00 out)
  const jan1 = new Date("2026-01-01T00:00:00Z");
  const snap1 = await createPricingSnapshot({
    endpointId: endpoint.id,
    pricingVersionId: "snap_jan_2026",
    effectiveFrom: jan1,
    effectiveTo: new Date("2026-06-01T00:00:00Z"),
    inputPriceMicrosPerM: 1_000_000,
    outputPriceMicrosPerM: 4_000_000,
    provenance: "contract_v1",
  }, db);

  // Price change effective June 1, 2026 ($0.50 in / $2.00 out)
  const june1 = new Date("2026-06-01T00:00:00Z");
  const snap2 = await createPricingSnapshot({
    endpointId: endpoint.id,
    pricingVersionId: "snap_june_2026",
    effectiveFrom: june1,
    effectiveTo: null,
    inputPriceMicrosPerM: 500_000,
    outputPriceMicrosPerM: 2_000_000,
    provenance: "contract_v2",
  }, db);

  // Querying at March 2026 returns snap1 unchanged
  const marchSnapshot = await getEffectivePricingSnapshot(endpoint.id, new Date("2026-03-15T00:00:00Z"), db);
  assert.equal(marchSnapshot.pricingVersionId, "snap_jan_2026");
  assert.equal(marchSnapshot.inputPriceMicrosPerM, 1_000_000);

  // Querying at July 2026 returns snap2
  const julySnapshot = await getEffectivePricingSnapshot(endpoint.id, new Date("2026-07-01T00:00:00Z"), db);
  assert.equal(julySnapshot.pricingVersionId, "snap_june_2026");
  assert.equal(julySnapshot.inputPriceMicrosPerM, 500_000);
});

// ---------------------------------------------------------------------------
// 9. Native Compatibility Inventory: Source Separation & Production Observation
// ---------------------------------------------------------------------------
test("native compatibility inventory accurately represents verified production observation", async (t) => {
  const inventory = buildNativeCompatibilityInventory({
    source: INVENTORY_SOURCES.PRODUCTION_OBSERVED,
  });
  assert.equal(inventory.length, 5, "Covers Lumen, Nova, Study, Nebula, and Vulcan");

  // 1. Study: Must be Direct connection to OpenAI, NOT router!
  const study = inventory.find((item) => item.family.slug === "vibhavgpt/study");
  assert.ok(study);
  assert.equal(study.version.versionTag, "gpt-6-luna");
  assert.equal(study.endpoints.length, 1);
  assert.equal(study.endpoints[0].transportType, "direct");
  assert.equal(study.endpoints[0].endpointUrl, "https://api.openai.com/v1");
  assert.equal(study.endpoints[0].providerName, "study");
  assert.equal(study.endpoints[0].privacyReview.privacyApproved, false, "Configured flag does NOT automatically become registry approval");
  assert.equal(study.endpoints[0].privacyReview.registryApprovalState, "pending_audit");

  // 2. Nova: Router allowlist with 5 providers
  const nova = inventory.find((item) => item.family.slug === "vibhavgpt/nova");
  assert.ok(nova);
  assert.equal(nova.version.versionTag, "deepseek/deepseek-v4.1-flash");
  assert.equal(nova.endpoints.length, 1);
  assert.equal(nova.endpoints[0].transportType, "router");
  assert.equal(nova.endpoints[0].endpointUrl, "https://openrouter.ai/api/v1");
  assert.equal(nova.endpoints[0].operatorConfig.allowlist.length, 5);
  assert.equal(nova.endpoints[0].privacyReview.privacyApproved, false);

  // 3. Nebula: Router allowlist with 5 providers, verified data policy
  const nebula = inventory.find((item) => item.family.slug === "vibhavgpt/nebula");
  assert.ok(nebula);
  assert.equal(nebula.version.versionTag, "moonshotai/kimi-k2.6");
  assert.equal(nebula.endpoints[0].transportType, "router");
  assert.equal(nebula.endpoints[0].operatorConfig.dataPolicyVerified, true);
  assert.equal(nebula.endpoints[0].operatorConfig.allowlist.length, 5);
  assert.equal(nebula.endpoints[0].privacyReview.privacyApproved, false);

  // 4. Lumen: 4 independent providers with distinct endpoints & actual approval states
  const lumen = inventory.find((item) => item.family.slug === "vibhavgpt/lumen");
  assert.ok(lumen);
  assert.equal(lumen.version.versionTag, "openai/gpt-oss-20b");
  assert.equal(lumen.endpoints.length, 4);

  const primaryEp = lumen.endpoints.find((ep) => ep.providerName === "primaryFree");
  const gatewayEp = lumen.endpoints.find((ep) => ep.providerName === "gatewayFree");
  const secondaryEp = lumen.endpoints.find((ep) => ep.providerName === "secondaryFree");
  const reserveEp = lumen.endpoints.find((ep) => ep.providerName === "reserveFree");

  assert.equal(primaryEp.endpointUrl, "https://api.groq.com/openai/v1");
  assert.equal(primaryEp.model, "openai/gpt-oss-20b");
  assert.equal(primaryEp.operatorConfig.configuredFlag, true);
  assert.equal(primaryEp.operatorConfig.pinMatches, true);

  assert.equal(gatewayEp.endpointUrl, "https://api.bazaarlink.ai/v1");
  assert.equal(gatewayEp.model, "qwen/qwen3.7-flash");
  assert.equal(gatewayEp.operatorConfig.configuredFlag, true);
  assert.equal(gatewayEp.operatorConfig.pinMatches, true);

  // Secondary and reserve are unapproved in production
  assert.equal(secondaryEp.endpointUrl, "https://api.bytez.com/models/v2/openai/v1");
  assert.equal(secondaryEp.model, "Qwen/Qwen3-4B");
  assert.equal(secondaryEp.operatorConfig.configuredFlag, false);
  assert.equal(secondaryEp.privacyReview.registryApprovalState, "unapproved");
  assert.equal(secondaryEp.endpointState, "disabled");

  assert.equal(reserveEp.endpointUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(reserveEp.model, "gemini-3.5-flash-lite");
  assert.equal(reserveEp.operatorConfig.configuredFlag, false);
  assert.equal(reserveEp.privacyReview.registryApprovalState, "unapproved");
  assert.equal(reserveEp.endpointState, "disabled");

  // 5. Vulcan: Decomposed into Direct vs Router selectable transports (NO automatic fallback!)
  const vesper = inventory.find((item) => item.family.slug === "vibhavgpt/vesper");
  assert.ok(vesper);
  assert.equal(vesper.version.versionTag, "gpt-6.1-terra");
  assert.equal(vesper.version.metadata.transportIsolation.activeSelectedTransport, "direct");
  assert.equal(vesper.version.metadata.transportIsolation.crossTransportFallback, false, "No automatic cross-transport fallback");

  const directEp = vesper.endpoints.find((ep) => ep.transportType === "direct");
  const routerEp = vesper.endpoints.find((ep) => ep.transportType === "router");
  assert.ok(directEp);
  assert.ok(routerEp);

  assert.equal(directEp.endpointUrl, "https://api.openai.com/v1");
  assert.equal(directEp.model, "gpt-6.1-terra");
  assert.equal(directEp.adapterType, "responses");
  assert.equal(directEp.isSelectedTransport, true);
  assert.equal(directEp.privacyReview.privacyApproved, false);

  assert.equal(routerEp.endpointUrl, "https://openrouter.ai/api/v1");
  assert.equal(routerEp.model, "x-ai/grok-4.7");
  assert.equal(routerEp.adapterType, "chat_completions");
  assert.equal(routerEp.isSelectedTransport, false);
  assert.equal(routerEp.operatorConfig.role, "alternate_selectable_transport");
  assert.equal(routerEp.privacyReview.registryApprovalState, "unapproved");

  // Seed into database idempotently
  const { db } = await createDatabase(t);
  const seedRun1 = await seedNativeCompatibilityInventory(db, { source: INVENTORY_SOURCES.PRODUCTION_OBSERVED });
  assert.equal(seedRun1.length, 5);

  const seedRun2 = await seedNativeCompatibilityInventory(db, { source: INVENTORY_SOURCES.PRODUCTION_OBSERVED });
  assert.equal(seedRun2.length, 5, "Repeated execution is strictly idempotent");

  const families = await db.select().from(modelFamilies);
  assert.equal(families.length, 5);
});

// ---------------------------------------------------------------------------
// 10. Realistic Configuration Differences & Strict Source Boundaries
// ---------------------------------------------------------------------------
test("source boundaries, fixture isolation, and uninvented missing values", async (t) => {
  // 1. Fixture configuration is explicitly labeled as a fixture
  const fixtureInventory = buildNativeCompatibilityInventory({
    isFixture: true,
    rawConfig: {
      chatModels: { study: "fixture/study-model" },
      providerBaseUrls: { study: "https://study.test/v1" },
    },
  });
  const studyFixture = fixtureInventory.find((item) => item.family.slug === "vibhavgpt/study");
  assert.equal(studyFixture.version.metadata.evidence.isFixture, true);
  assert.equal(studyFixture.version.metadata.evidence.source, INVENTORY_SOURCES.TEST_FIXTURE);
  assert.equal(studyFixture.version.versionTag, "fixture/study-model");

  // 2. Incomplete snapshot leaves missing values unconfigured/missing, never populating invented defaults
  const emptyInventory = buildNativeCompatibilityInventory({
    source: INVENTORY_SOURCES.REPOSITORY_DEFAULTS,
  });
  const emptyNova = emptyInventory.find((item) => item.family.slug === "vibhavgpt/nova");
  assert.equal(emptyNova.version.versionTag, "unconfigured");
  assert.equal(emptyNova.endpoints[0].endpointUrl, null);
  assert.equal(emptyNova.endpoints[0].operatorConfig.configuredFlag, false);

  // 3. Seeding an unconfigured inventory does not create invalid versions
  const { db } = await createDatabase(t);
  const emptySeed = await seedNativeCompatibilityInventory(db, {
    source: INVENTORY_SOURCES.REPOSITORY_DEFAULTS,
  });
  assert.equal(emptySeed.length, 5);
  // Families exist, but unconfigured versions are omitted
  const emptyVersions = await db.select().from(modelVersions);
  assert.equal(emptyVersions.length, 0, "Unconfigured versions are not inserted into database");
});

// ---------------------------------------------------------------------------
// 11. Existing Routing Invariant
// ---------------------------------------------------------------------------
test("existing chat routing is unaffected whether registry is empty or populated", async (t) => {
  // Check static model configs before DB seeding
  const lumenConfig = getModelConfig("lumen");
  const vesperConfig = getModelConfig("vesper");
  const studyConfig = getModelConfig("study");

  assert.equal(lumenConfig.displayName, "VibhavGPT Lumen");
  assert.equal(vesperConfig.displayName, "VibhavGPT Vulcan");
  assert.equal(studyConfig.displayName, "VibhavGPT Study");
  assert.equal(MODEL_ALIASES.spark, "lumen");

  // Seed registry in DB with verified production observation
  const { db } = await createDatabase(t);
  await seedNativeCompatibilityInventory(db, { source: INVENTORY_SOURCES.PRODUCTION_OBSERVED });

  // Verify routing configs remain completely identical
  const postSeedLumen = getModelConfig("lumen");
  const postSeedVesper = getModelConfig("vesper");
  assert.equal(postSeedLumen.displayName, lumenConfig.displayName);
  assert.equal(postSeedVesper.displayName, vesperConfig.displayName);
});
