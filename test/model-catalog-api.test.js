process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import express from "express";

const { config } = await import("../src/config.js");
const {
  modelFamilies,
  modelVersions,
  modelEndpoints,
  modelPricingSnapshots,
  userProfiles,
  subscriptions,
  shadowCostLedger,
} = await import("../src/db/schema.js");
const {
  createModelFamily,
  createModelVersion,
  createModelEndpoint,
  createPricingSnapshot,
  LIFECYCLE_STATES,
  PLAN_ELIGIBILITY,
} = await import("../src/models/registry.js");
const { CONSUMPTION_CATEGORIES } = await import("../src/models/consumption.js");
const {
  getCatalogForUser,
  getCatalogPreferences,
  updateCatalogPreferences,
  serializeModelForCatalog,
} = await import("../src/models/catalog-service.js");
const {
  catalogRouter,
  meCatalogPreferencesRouter,
  createCatalogRouter,
  createMeCatalogPreferencesRouter,
} = await import("../src/models/catalog-router.js");

// Helper: isolated test database with all migrations applied
async function createDatabase(t) {
  const client = new PGlite();
  if (t?.after) t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    const migrationSql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await client.exec(migrationSql);
  }
  return { client, db: drizzle(client) };
}

// Helper: ephemeral Express test server
async function createTestApp(t, { dbInstance, session = null } = {}) {
  const app = express();
  app.use(express.json());
  if (session) {
    app.use((req, _res, next) => {
      req.authSession = session;
      next();
    });
  }
  app.use("/api/models", createCatalogRouter({ db: dbInstance }));
  app.use("/api/me/catalog-preferences", createMeCatalogPreferencesRouter({ db: dbInstance }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  if (t?.after) {
    t.after(() => new Promise((resolve) => server.close(resolve)));
  }

  const port = server.address().port;
  const request = async (path, { method = "GET", body = null } = {}) => {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    let json = null;
    try {
      json = await res.json();
    } catch {
      // not json
    }
    return { status: res.status, headers: res.headers, body: json };
  };

  return { server, request };
}

// ---------------------------------------------------------------------------
// 1. Database Migration: Fresh DB, Upgrade, and Column Integrity
// ---------------------------------------------------------------------------
test("catalog preferences migration 0035: fresh database, upgrade, and idempotency", async (t) => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const migration35Sql = await readFile(new URL("../drizzle/0035_catalog_preferences.sql", import.meta.url), "utf8");

  // 1A. Fresh database applying all migrations
  const freshClient = new PGlite();
  t.after(() => freshClient.close());
  for (const entry of journal.entries) {
    const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await freshClient.exec(sql);
  }

  const freshColCheck = await freshClient.query(
    `SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'catalog_preferences'`,
  );
  assert.equal(freshColCheck.rows.length, 1);
  assert.equal(freshColCheck.rows[0].column_name, "catalog_preferences");
  assert.equal(freshColCheck.rows[0].data_type, "jsonb");

  // 1B. Upgrade database from 0034
  const upgradeClient = new PGlite();
  t.after(() => upgradeClient.close());
  for (const entry of journal.entries.slice(0, 34)) {
    const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await upgradeClient.exec(sql);
  }

  const beforeCol = await upgradeClient.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'catalog_preferences'`,
  );
  assert.equal(beforeCol.rows.length, 0, "column must not exist before 0035");

  // Apply migration 0035
  await upgradeClient.exec(migration35Sql);
  const afterCol = await upgradeClient.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'catalog_preferences'`,
  );
  assert.equal(afterCol.rows.length, 1, "column must exist after 0035");

  // 1C. Idempotency check: running 0035 again must not error
  await upgradeClient.exec(migration35Sql);
  const idempotentCol = await upgradeClient.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'catalog_preferences'`,
  );
  assert.equal(idempotentCol.rows.length, 1);
});

// ---------------------------------------------------------------------------
// 2. Feature Gate and Authentication Boundaries
// ---------------------------------------------------------------------------
test("catalog endpoint: feature disabled returns 404, unauthenticated returns 401", async (t) => {
  const originalGate = config.featureModelCatalogApi;
  t.after(() => {
    config.featureModelCatalogApi = originalGate;
  });

  const memberSession = { user: { id: "test-user-1", email: "user1@example.com" } };

  // 2A. When feature is disabled (default in production)
  config.featureModelCatalogApi = false;
  const { request: disabledRequest } = await createTestApp(t, { session: memberSession });

  const getCatalog404 = await disabledRequest("/api/models/catalog");
  assert.equal(getCatalog404.status, 404);
  assert.equal(getCatalog404.body?.code, "feature_disabled");

  const getPrefs404 = await disabledRequest("/api/models/preferences");
  assert.equal(getPrefs404.status, 404);
  assert.equal(getPrefs404.body?.code, "feature_disabled");

  const putPrefs404 = await disabledRequest("/api/models/preferences", { method: "PUT", body: { favorites: ["vesper"] } });
  assert.equal(putPrefs404.status, 404);
  assert.equal(putPrefs404.body?.code, "feature_disabled");

  const mePrefs404 = await disabledRequest("/api/me/catalog-preferences");
  assert.equal(mePrefs404.status, 404);
  assert.equal(mePrefs404.body?.code, "feature_disabled");

  // 2B. When feature is enabled, but unauthenticated
  config.featureModelCatalogApi = true;
  const { request: unauthRequest } = await createTestApp(t, { session: null });

  const unauthCatalog = await unauthRequest("/api/models/catalog");
  assert.equal(unauthCatalog.status, 401);

  const unauthPrefs = await unauthRequest("/api/models/preferences");
  assert.equal(unauthPrefs.status, 401);

  const unauthMePrefs = await unauthRequest("/api/me/catalog-preferences");
  assert.equal(unauthMePrefs.status, 401);
});

// ---------------------------------------------------------------------------
// 3. Server-Derived Plan & Client Spoofing Immunity
// ---------------------------------------------------------------------------
test("catalog endpoint: plan is strictly derived from server subscription, client spoofing is ignored", async (t) => {
  const originalGate = config.featureModelCatalogApi;
  config.featureModelCatalogApi = true;
  t.after(() => {
    config.featureModelCatalogApi = originalGate;
  });

  const { db } = await createDatabase(t);

  // Seed user with free subscription
  const freeUser = { user: { id: "free-user", email: "free@example.com" } };
  await db.insert(subscriptions).values({
    userId: freeUser.user.id,
    tier: "free",
    status: "active",
    billingSource: "stripe",
  });

  // Seed user with pro subscription
  const proUser = { user: { id: "pro-user", email: "pro@example.com" } };
  await db.insert(subscriptions).values({
    userId: proUser.user.id,
    tier: "pro",
    status: "active",
    billingSource: "stripe",
  });

  // Free user request: attempts spoofing via query params and request body
  const catalogForFree = await getCatalogForUser({ userId: freeUser.user.id, db });
  assert.equal(catalogForFree.userPlan, "free");

  // Pro user request
  const catalogForPro = await getCatalogForUser({ userId: proUser.user.id, db });
  assert.equal(catalogForPro.userPlan, "pro");
});

// ---------------------------------------------------------------------------
// 4. Honest Empty State
// ---------------------------------------------------------------------------
test("catalog endpoint: returns honest empty state when no approved records exist", async (t) => {
  const { db } = await createDatabase(t);

  const res = await getCatalogForUser({ userId: "empty-user", userPlan: "plus", db });
  assert.deepEqual(res.models, []);
  assert.deepEqual(res.groups, []);
  assert.equal(res.userPlan, "plus");
});

// ---------------------------------------------------------------------------
// 5. Plan Restrictions (Free, Plus, Pro) & Consumption Gating
// ---------------------------------------------------------------------------
test("catalog presentation: plan boundaries enforce Free, Plus, and Pro restrictions", async (t) => {
  const { db } = await createDatabase(t);

  // 1. Model: Free entry model (Lumen)
  const famLumen = await createModelFamily({
    slug: "vibhavgpt/lumen",
    displayName: "VibhavGPT Lumen",
    familyGroup: "native",
    description: "Everyday lightweight model",
    sortOrder: 10,
  }, db);
  const verLumen = await createModelVersion({
    familyId: famLumen.id,
    versionTag: "lumen-standard",
    planEligibility: PLAN_ELIGIBILITY.FREE,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  const epLumen = await createModelEndpoint({
    versionId: verLumen.id,
    providerName: "direct-endpoint",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
    privacyReview: { privacyApproved: true },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  await createPricingSnapshot({
    endpointId: epLumen.id,
    pricingVersionId: "pv_lumen",
    inputPriceMicrosPerM: 50_000,
    outputPriceMicrosPerM: 100_000,
    provenance: "contract",
  }, db);

  // 2. Model: a registry row for the retired Nova tier (retired 2026-11-14). It stays seeded so the test proves it is never served.
  const famNova = await createModelFamily({
    slug: "vibhavgpt/nova",
    displayName: "VibhavGPT Nova",
    familyGroup: "native",
    description: "Fast general model",
    sortOrder: 20,
  }, db);
  const verNova = await createModelVersion({
    familyId: famNova.id,
    versionTag: "nova-standard",
    planEligibility: PLAN_ELIGIBILITY.PAID,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  const epNova = await createModelEndpoint({
    versionId: verNova.id,
    providerName: "direct-endpoint",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
    privacyReview: { privacyApproved: true },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  await createPricingSnapshot({
    endpointId: epNova.id,
    pricingVersionId: "pv_nova",
    inputPriceMicrosPerM: 500_000,
    outputPriceMicrosPerM: 2_000_000,
    provenance: "contract",
  }, db);

  // 3. Model: Extra High model (Vulcan Extra High)
  const famVesper = await createModelFamily({
    slug: "vibhavgpt/vesper",
    displayName: "VibhavGPT Vulcan",
    familyGroup: "native",
    description: "Frontier reasoning model",
    sortOrder: 30,
  }, db);
  const verVesper = await createModelVersion({
    familyId: famVesper.id,
    versionTag: "vesper-frontier",
    planEligibility: PLAN_ELIGIBILITY.PAID,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  const epVesper = await createModelEndpoint({
    versionId: verVesper.id,
    providerName: "direct-endpoint",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
    privacyReview: { privacyApproved: true },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  await createPricingSnapshot({
    endpointId: epVesper.id,
    pricingVersionId: "pv_vesper",
    inputPriceMicrosPerM: 10_000_000,
    outputPriceMicrosPerM: 40_000_000,
    provenance: "contract",
  }, db);

  // 4. Model: Pro-only model
  const famProOnly = await createModelFamily({
    slug: "vibhavgpt/pro-exclusive",
    displayName: "Pro Exclusive Model",
    familyGroup: "native",
    description: "Exclusive model",
    sortOrder: 40,
  }, db);
  const verProOnly = await createModelVersion({
    familyId: famProOnly.id,
    versionTag: "pro-v1",
    planEligibility: PLAN_ELIGIBILITY.PRO_ONLY,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  const epProOnly = await createModelEndpoint({
    versionId: verProOnly.id,
    providerName: "direct-endpoint",
    transportType: "direct",
    endpointUrl: "https://api.openai.com/v1",
    privacyReview: { privacyApproved: true },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  await createPricingSnapshot({
    endpointId: epProOnly.id,
    pricingVersionId: "pv_pro",
    inputPriceMicrosPerM: 2_000_000,
    outputPriceMicrosPerM: 8_000_000,
    provenance: "contract",
  }, db);

  // --- Evaluate FREE user ---
  // Customer catalog uses canonical VibhavGPT ids (lumen/vesper); a retired tier is never served, even with a registry row.
  // Non-tier registry rows like pro-exclusive stay out of the customer payload.
  const freeCat = await getCatalogForUser({ userId: "u-free", userPlan: "free", db });
  const freeLumen = freeCat.models.find((m) => m.id === "lumen");
  const freeNova = freeCat.models.find((m) => m.id === "nova");
  const freeVesper = freeCat.models.find((m) => m.id === "vesper");
  const freeProOnly = freeCat.models.find((m) => m.id === "pro-exclusive" || m.id === "vibhavgpt-pro-exclusive");

  assert.ok(freeLumen);
  assert.equal(freeLumen.selectability.selectable, true);
  assert.equal(freeLumen.selectability.locked, false);

  assert.equal(freeNova, undefined, "Nova is retired: not served, even with a registry row");

  assert.ok(freeVesper);
  assert.equal(freeVesper.selectability.selectable, false);
  assert.equal(freeVesper.selectability.lockType, "subscription");

  assert.equal(freeProOnly, undefined);

  // --- Evaluate PLUS user ---
  const plusCat = await getCatalogForUser({ userId: "u-plus", userPlan: "plus", db });
  const plusLumen = plusCat.models.find((m) => m.id === "lumen");
  const plusNova = plusCat.models.find((m) => m.id === "nova");
  const plusVesper = plusCat.models.find((m) => m.id === "vesper");
  const plusProOnly = plusCat.models.find((m) => m.id === "pro-exclusive" || m.id === "vibhavgpt-pro-exclusive");

  assert.equal(plusLumen.selectability.selectable, true);
  assert.equal(plusNova, undefined, "Nova is retired");

  // Extra High is locked for Plus users
  assert.equal(plusVesper.selectability.selectable, false);
  assert.equal(plusVesper.selectability.lockType, "subscription");
  assert.match(plusVesper.selectability.lockReason, /Pro members/i);

  assert.equal(plusProOnly, undefined);

  // --- Evaluate PRO user ---
  const proCat = await getCatalogForUser({ userId: "u-pro", userPlan: "pro", db });
  const proLumen = proCat.models.find((m) => m.id === "lumen");
  const proNova = proCat.models.find((m) => m.id === "nova");
  const proVesper = proCat.models.find((m) => m.id === "vesper");
  const proProOnly = proCat.models.find((m) => m.id === "pro-exclusive" || m.id === "vibhavgpt-pro-exclusive");

  assert.equal(proLumen.selectability.selectable, true);
  assert.equal(proNova, undefined, "Nova is retired");
  assert.equal(proVesper.selectability.selectable, true);
  assert.equal(proProOnly, undefined);
});

test("catalog presentation: a configuration block (no active endpoint) locks a current tier on every plan, and an upgrade does not solve it", async (t) => {
  const { db } = await createDatabase(t);
  const fam = await createModelFamily({ slug: "vibhavgpt/lumen", displayName: "Lumen", familyGroup: "vibhavgpt", sortOrder: 10 }, db);
  const ver = await createModelVersion({
    familyId: fam.id,
    versionTag: "lumen",
    planEligibility: PLAN_ELIGIBILITY.FREE,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
    metadata: { publicId: "lumen", displayName: "Lumen" },
  }, db);
  await createModelEndpoint({
    versionId: ver.id,
    providerName: "inactive-provider",
    transportType: "direct",
    endpointUrl: "https://api.example.com",
    privacyReview: { privacyApproved: true },
    endpointState: LIFECYCLE_STATES.CANDIDATE,
  }, db);
  for (const plan of ["free", "plus", "pro"]) {
    const cat = await getCatalogForUser({ userId: `cfg-${plan}`, userPlan: plan, db });
    const cfgModel = cat.models.find((m) => m.id === "lumen");
    assert.ok(cfgModel);
    assert.equal(cfgModel.selectability.selectable, false, `must be locked for ${plan}`);
    assert.equal(cfgModel.selectability.lockType, "configuration");
    assert.match(cfgModel.selectability.lockReason, /temporarily unavailable/i);
    assert.doesNotMatch(cfgModel.selectability.lockReason, /upgrade/i, "must not claim upgrade solves configuration");
  }
});

// ---------------------------------------------------------------------------
// 6. Compliance, Pricing, and Configuration Blocks across ALL Plans
// ---------------------------------------------------------------------------
test("catalog presentation: compliance, pricing, and configuration blocks lock across ALL plans (an upgrade does not solve them)", async (t) => {
  const { db } = await createDatabase(t);

  // Use customer-facing VibhavGPT tiers so the catalog includes them.
  // 1. Compliance Block on Lumen
  const famCompliance = await createModelFamily({
    slug: "vibhavgpt/lumen",
    displayName: "Lumen",
    familyGroup: "vibhavgpt",
    sortOrder: 10,
  }, db);
  const verCompliance = await createModelVersion({
    familyId: famCompliance.id,
    versionTag: "lumen",
    planEligibility: PLAN_ELIGIBILITY.FREE,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
    metadata: { publicId: "lumen", displayName: "Lumen" },
  }, db);
  const epCompliance = await createModelEndpoint({
    versionId: verCompliance.id,
    providerName: "unapproved-provider",
    transportType: "direct",
    endpointUrl: "https://api.example.com",
    privacyReview: { privacyApproved: false },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  await createPricingSnapshot({
    endpointId: epCompliance.id,
    pricingVersionId: "pv_comp",
    consumptionCategory: CONSUMPTION_CATEGORIES.LOW,
    provenance: "contract",
  }, db);

  // 2. Pricing Block on Vulcan (Nova carried it until it was retired on 2026-11-14)
  const famPricing = await createModelFamily({
    slug: "vibhavgpt/vesper",
    displayName: "Vulcan",
    familyGroup: "vibhavgpt",
    sortOrder: 20,
  }, db);
  const verPricing = await createModelVersion({
    familyId: famPricing.id,
    versionTag: "vesper",
    planEligibility: PLAN_ELIGIBILITY.FREE,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
    metadata: { publicId: "vesper", displayName: "Vulcan" },
  }, db);
  const epPricing = await createModelEndpoint({
    versionId: verPricing.id,
    providerName: "approved-provider",
    transportType: "direct",
    endpointUrl: "https://api.example.com",
    privacyReview: { privacyApproved: true },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);
  await createPricingSnapshot({
    endpointId: epPricing.id,
    pricingVersionId: "pv_pending_price",
    consumptionCategory: CONSUMPTION_CATEGORIES.PENDING,
    provenance: "contract",
  }, db);

  // 3. A registry row for the retired Nebula tier, with a configuration block: never served (the configuration lock itself is tested
  //    on a current tier below).
  const famConfig = await createModelFamily({
    slug: "vibhavgpt/nebula",
    displayName: "Nebula",
    familyGroup: "vibhavgpt",
    sortOrder: 30,
  }, db);
  const verConfig = await createModelVersion({
    familyId: famConfig.id,
    versionTag: "nebula",
    planEligibility: PLAN_ELIGIBILITY.FREE,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
    metadata: { publicId: "nebula", displayName: "Nebula" },
  }, db);
  await createModelEndpoint({
    versionId: verConfig.id,
    providerName: "inactive-provider",
    transportType: "direct",
    endpointUrl: "https://api.example.com",
    privacyReview: { privacyApproved: true },
    endpointState: LIFECYCLE_STATES.CANDIDATE,
  }, db);

  // Third-party vendor rows must never appear in the customer catalog.
  await createModelFamily({
    slug: "vendor/should-not-appear",
    displayName: "Hidden Vendor Model",
    familyGroup: "anthropic",
    sortOrder: 99,
  }, db);

  for (const plan of ["free", "plus", "pro"]) {
    const cat = await getCatalogForUser({ userId: `user-${plan}`, userPlan: plan, db });

    assert.equal(
      cat.models.find((m) => /anthropic|claude|gpt-|openai/i.test(`${m.id} ${m.displayName} ${m.developer}`)),
      undefined,
    );

    const compModel = cat.models.find((m) => m.id === "lumen");
    assert.ok(compModel);
    assert.equal(compModel.selectability.selectable, false, `must be locked for ${plan}`);
    assert.equal(compModel.selectability.lockType, "compliance");
    assert.match(compModel.selectability.lockReason, /privacy and compliance/i);
    assert.doesNotMatch(compModel.selectability.lockReason, /upgrade/i, "must not claim upgrade solves compliance");

    const priceModel = cat.models.find((m) => m.id === "vesper");
    assert.ok(priceModel);
    assert.equal(priceModel.selectability.selectable, false, `must be locked for ${plan}`);
    assert.equal(priceModel.selectability.lockType, "pricing");
    assert.match(priceModel.selectability.lockReason, /rate classification/i);
    assert.doesNotMatch(priceModel.selectability.lockReason, /upgrade/i, "must not claim upgrade solves pricing");

    assert.equal(cat.models.find((m) => m.id === "nebula"), undefined, "Nebula is retired: not served, even with a registry row");
  }
});

// ---------------------------------------------------------------------------
// 7. Strict Allowlisted DTO & Deep Recursive Data Boundary Check
// ---------------------------------------------------------------------------
test("catalog presentation: strict allowlisted DTO recursively excludes wholesale prices, mu, endpoints, and credentials", async (t) => {
  const { db } = await createDatabase(t);

  const SECRET_TOKEN = "SUPER_SECRET_VENDOR_BEARER_TOKEN_999";
  const SECRET_URL = "https://confidential-cluster.internal.network/v1";
  const SECRET_AUDIT_NOTES = "INTERNAL_PRIVACY_AUDIT_NOTE_CLASSIFIED";

  const fam = await createModelFamily({
    slug: "vibhavgpt/vesper",
    displayName: "Vulcan",
    familyGroup: "vibhavgpt",
    description: "Detailed description for synthesis",
    sortOrder: 15,
  }, db);

  const ver = await createModelVersion({
    familyId: fam.id,
    versionTag: "vesper",
    capabilitiesDocumented: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      reasoningSupported: true,
      reasoningModes: ["low", "high"],
      contextWindowTokens: 200000,
    },
    planEligibility: PLAN_ELIGIBILITY.PAID,
    lifecycleState: LIFECYCLE_STATES.ACTIVE,
    metadata: { publicId: "nova", displayName: "Nova" },
  }, db);

  const ep = await createModelEndpoint({
    versionId: ver.id,
    providerName: "internal-direct",
    transportType: "direct",
    endpointUrl: SECRET_URL,
    capabilitiesVerified: { vision: true, tools: true, streaming: true },
    privacyReview: {
      privacyApproved: true,
      auditRef: SECRET_AUDIT_NOTES,
      reviewedBy: "auditor@internal",
    },
    endpointState: LIFECYCLE_STATES.ACTIVE,
  }, db);

  await createPricingSnapshot({
    endpointId: ep.id,
    pricingVersionId: "pv_secret_123",
    inputPriceMicrosPerM: 3000000,
    outputPriceMicrosPerM: 15000000,
    cachedReadPriceMicrosPerM: 300000,
    calculatedMu: 3.45,
    consumptionCategory: CONSUMPTION_CATEGORIES.HIGH,
    provenance: `token:${SECRET_TOKEN}`,
  }, db);

  // Third-party registry rows must be omitted entirely from the customer payload.
  await createModelFamily({
    slug: "anthropic/claude-test",
    displayName: "Claude Test Model",
    familyGroup: "anthropic",
    sortOrder: 99,
  }, db);

  const catalog = await getCatalogForUser({ userId: "user-boundary-check", userPlan: "pro", db });
  assert.equal(catalog.models.length, 1);
  const model = catalog.models[0];
  assert.equal(model.id, "vesper");
  assert.equal(model.developer, "VibhavGPT");
  assert.equal(/anthropic|claude|openai/i.test(JSON.stringify(catalog)), false);

  // 7A. Verify exact allowlisted keys on model object
  const allowedTopLevelKeys = new Set([
    "id",
    "displayName",
    "group",
    "developer",
    "performanceCategory",
    "description",
    "modalities",
    "contextWindowTokens",
    "supportedReasoningEfforts",
    "capabilities",
    "consumptionCategory",
    "sortRank",
    "selectability",
    // A house model carries its intelligence label. Public, and nothing about what runs it. No model is badged "Recommended", so
    // "recommended" and "recommendedLabel" are no longer allowed.
    "house",
    "intelligence",
  ]);

  for (const key of Object.keys(model)) {
    assert.ok(allowedTopLevelKeys.has(key), `Disallowed property "${key}" present on public model DTO`);
  }

  // 7B. Recursive walk through the entire response asserting no leak of sensitive tokens or keys
  const forbiddenKeyRegex = /^(wholesale|inputPrice|outputPrice|cachedRead|calculatedMu|mu$|pricingVersion|endpointUrl|baseUrl|providerName|provider_name|providerKey|apiKey|auditRef|reviewedBy|secret|credentials|diagnostic|mau|userCount)/i;

  function recursiveVerify(node, path = "") {
    if (node === null || typeof node !== "object") {
      if (typeof node === "string") {
        assert.doesNotMatch(node, new RegExp(SECRET_TOKEN), `Secret token leaked at path "${path}"`);
        assert.doesNotMatch(node, new RegExp(SECRET_URL), `Internal endpoint URL leaked at path "${path}"`);
        assert.doesNotMatch(node, new RegExp(SECRET_AUDIT_NOTES), `Audit notes leaked at path "${path}"`);
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, idx) => recursiveVerify(item, `${path}[${idx}]`));
      return;
    }

    for (const [k, v] of Object.entries(node)) {
      assert.doesNotMatch(k, forbiddenKeyRegex, `Forbidden internal key "${k}" exposed at "${path}.${k}"`);
      recursiveVerify(v, `${path}.${k}`);
    }
  }

  recursiveVerify(catalog, "catalog");
});

// ---------------------------------------------------------------------------
// 8. Zero Side Effects (Provider, Allowance, and Ledger Checks)
// ---------------------------------------------------------------------------
test("catalog endpoint: reading catalog causes ZERO provider calls, zero allowance deductions, and zero shadow ledger writes", async (t) => {
  const { db } = await createDatabase(t);

  const beforeLedgerCount = (await db.select().from(shadowCostLedger)).length;

  // Reading catalog multiple times for multiple plans
  for (let i = 0; i < 5; i++) {
    await getCatalogForUser({ userId: `user-zero-side-effects-${i}`, userPlan: "pro", db });
  }

  const afterLedgerCount = (await db.select().from(shadowCostLedger)).length;
  assert.equal(afterLedgerCount, beforeLedgerCount, "Zero rows may be written to shadow_cost_ledger on catalog reads");
});

// ---------------------------------------------------------------------------
// 9. Account-Scoped Catalog Preferences Persistence & Cross-Account Isolation
// ---------------------------------------------------------------------------
test("catalog preferences: cross-account isolation, validation bounds, deduplication, and non-destructive updates", async (t) => {
  const originalGate = config.featureModelCatalogApi;
  config.featureModelCatalogApi = true;
  t.after(() => {
    config.featureModelCatalogApi = originalGate;
  });

  const { db } = await createDatabase(t);

  // Setup user profiles with existing profile preferences
  await db.insert(userProfiles).values({
    userId: "alice",
    preferredModel: "lumen",
    lastUsedModel: "nova",
    thinkingEffort: "high",
    customInstructions: "Instructions for Alice",
  });
  await db.insert(userProfiles).values({
    userId: "bob",
    preferredModel: "vesper",
    lastUsedModel: "vesper",
    thinkingEffort: "normal",
    customInstructions: "Instructions for Bob",
  });

  // 9A. Default preferences for Alice
  const aliceInitial = await getCatalogPreferences("alice", db);
  assert.deepEqual(aliceInitial, { favorites: [], hiddenBrands: [], brandOrder: [] });

  // 9B. Alice updates preferences
  const aliceUpdated = await updateCatalogPreferences(
    "alice",
    {
      favorites: ["vibhavgpt-lumen", "vibhavgpt-nova", "vibhavgpt-lumen"], // has duplicate
      hiddenBrands: ["vendor-x"],
      brandOrder: ["vibhavgpt", "anthropic"],
    },
    db,
  );

  // Deduplication check
  assert.deepEqual(aliceUpdated.favorites, ["vibhavgpt-lumen", "vibhavgpt-nova"]);
  assert.deepEqual(aliceUpdated.hiddenBrands, ["vendor-x"]);
  assert.deepEqual(aliceUpdated.brandOrder, ["vibhavgpt", "anthropic"]);

  // 9C. Cross-Account Isolation: Bob's preferences remain empty and unaffected
  const bobPrefs = await getCatalogPreferences("bob", db);
  assert.deepEqual(bobPrefs, { favorites: [], hiddenBrands: [], brandOrder: [] });

  // 9D. Preservation of unrelated profile columns for Alice
  const [aliceProfile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, "alice")).limit(1);
  assert.equal(aliceProfile.preferredModel, "lumen");
  assert.equal(aliceProfile.lastUsedModel, "nova");
  assert.equal(aliceProfile.thinkingEffort, "high");
  assert.equal(aliceProfile.customInstructions, "Instructions for Alice");

  // 9E. Non-destructive partial update: Alice updates only hiddenBrands
  const alicePartial = await updateCatalogPreferences(
    "alice",
    {
      hiddenBrands: ["vendor-y"],
    },
    db,
  );
  assert.deepEqual(alicePartial.favorites, ["vibhavgpt-lumen", "vibhavgpt-nova"], "favorites must be preserved");
  assert.deepEqual(alicePartial.hiddenBrands, ["vendor-y"], "hiddenBrands updated");
  assert.deepEqual(alicePartial.brandOrder, ["vibhavgpt", "anthropic"], "brandOrder must be preserved");

  // 9F. Bounds enforcement: list exceeding 50 items must be rejected
  const oversizedList = Array.from({ length: 51 }, (_, i) => `item-${i}`);
  await assert.rejects(
    updateCatalogPreferences("alice", { favorites: oversizedList }, db),
    (err) => err.code === "bounds_exceeded",
  );

  // 9G. Format validation: invalid character strings must be rejected
  await assert.rejects(
    updateCatalogPreferences("alice", { favorites: ["<script>alert(1)</script>"] }, db),
    (err) => err.code === "invalid_id_format",
  );
  await assert.rejects(
    updateCatalogPreferences("alice", { brandOrder: ["invalid brand with spaces"] }, db),
    (err) => err.code === "invalid_id_format",
  );
});

// ---------------------------------------------------------------------------
// 10. HTTP Route Endpoints: /api/models/preferences and /api/me/catalog-preferences
// ---------------------------------------------------------------------------
test("preferences endpoints: both /api/models/preferences and /api/me/catalog-preferences operate correctly and set no-store", async (t) => {
  const originalGate = config.featureModelCatalogApi;
  config.featureModelCatalogApi = true;
  t.after(() => {
    config.featureModelCatalogApi = originalGate;
  });

  const { db } = await createDatabase(t);
  const session = { user: { id: "http-pref-user", email: "http@example.com" } };
  const { request } = await createTestApp(t, { dbInstance: db, session });

  // GET initial preferences
  const get1 = await request("/api/models/preferences");
  assert.equal(get1.status, 200);
  assert.equal(get1.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(get1.body?.preferences, { favorites: [], hiddenBrands: [], brandOrder: [] });

  // PUT via /api/models/preferences
  const put1 = await request("/api/models/preferences", {
    method: "PUT",
    body: { favorites: ["vesper"], brandOrder: ["native"] },
  });
  assert.equal(put1.status, 200);
  assert.deepEqual(put1.body?.preferences?.favorites, ["vesper"]);
  assert.deepEqual(put1.body?.preferences?.brandOrder, ["native"]);

  // GET via alias /api/me/catalog-preferences
  const get2 = await request("/api/me/catalog-preferences");
  assert.equal(get2.status, 200);
  assert.equal(get2.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(get2.body?.preferences?.favorites, ["vesper"]);

  // PUT via alias /api/me/catalog-preferences
  const put2 = await request("/api/me/catalog-preferences", {
    method: "PUT",
    body: { hiddenBrands: ["blocked-group"] },
  });
  assert.equal(put2.status, 200);
  assert.deepEqual(put2.body?.preferences?.favorites, ["vesper"], "previous favorites preserved");
  assert.deepEqual(put2.body?.preferences?.hiddenBrands, ["blocked-group"]);
});
