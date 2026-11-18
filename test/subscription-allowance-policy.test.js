import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

const {
  shadowCostLedger,
  subscriptions,
  modelFamilies,
  modelVersions,
  modelEndpoints,
  modelPricingSnapshots,
} = await import("../src/db/schema.js");

const {
  PLAN_ALLOWANCES,
  ALLOWANCE_LIFECYCLE_STATES,
  AllowanceExceededError,
  estimateInferenceReservationCost,
  getAvailableAllowance,
  reserveAllowance,
  markDispatched,
  settleAllowance,
  markUncertain,
} = await import("../src/usage/allowance-service.js");

const {
  executeWithCoordinator,
  clearAllHeartbeatTimers,
  resetEndpointOverrunTracker,
  APPROVED_FREE_MODEL_GROUP,
  CoordinatorAllowanceError,
  CoordinatorRoutingError,
  COORDINATOR_ERROR_CODES,
} = await import("../src/models/execution-coordinator.js");

const {
  VALID_PRICE_LOOKUP_KEYS,
  tierForPriceLookupKey,
  createCheckoutSession,
} = await import("../src/billing/service.js");

const { tierForSubscription } = await import("../src/usage/service.js");
const { evaluateRoutingDecision } = await import("../src/models/decision.js");
const { PRODUCT_KNOWLEDGE } = await import("../frontend/src/product-knowledge.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(async () => {
    clearAllHeartbeatTimers();
    resetEndpointOverrunTracker();
    await client.close();
  });

  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    const migrationSql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
    await client.exec(migrationSql);
  }
  return { client, db: drizzle(client) };
}

async function seedTestCatalog(db) {
  // Free native model: Lumen
  const [lumenFam] = await db.insert(modelFamilies).values({
    slug: "vibhavgpt/lumen",
    displayName: "VibhavGPT Lumen",
    familyGroup: "native",
    sortOrder: 1,
  }).returning();

  const [lumenVer] = await db.insert(modelVersions).values({
    familyId: lumenFam.id,
    versionTag: "lumen",
    aliases: ["lumen"],
    capabilitiesDocumented: { vision: false, tools: true, streaming: true },
    planEligibility: "free",
    lifecycleState: "active",
    isDefaultInFamily: true,
  }).returning();

  const [lumenEp] = await db.insert(modelEndpoints).values({
    versionId: lumenVer.id,
    providerName: "reserve_stage",
    transportType: "direct",
    adapterType: "chat_completions",
    endpointUrl: "https://mock.internal/lumen",
    capabilitiesVerified: { vision: false, tools: true, streaming: true },
    privacyReview: { privacyApproved: true, scope: "default", zeroDataRetention: true, trainingPolicy: "denied" },
    endpointState: "active",
    sortPriority: 1,
  }).returning();

  await db.insert(modelPricingSnapshots).values({
    endpointId: lumenEp.id,
    pricingVersionId: "pv_lumen_free",
    effectiveFrom: new Date("2026-01-01"),
    currency: "USD",
    billingUnit: "usd_per_1m_tokens",
    inputPriceMicrosPerM: 0,
    outputPriceMicrosPerM: 0,
    cachedReadPriceMicrosPerM: 0,
    consumptionCategory: "low",
    pricingConfidence: "verified",
    provenance: "internal_free_zero_cost",
  });

  // Paid model: Terra (Pro/Max/Plus)
  const [terraFam] = await db.insert(modelFamilies).values({
    slug: "openai/gpt-6.1-terra",
    displayName: "GPT-6.1 Terra",
    familyGroup: "OpenAI",
    sortOrder: 2,
  }).returning();

  const [terraVer] = await db.insert(modelVersions).values({
    familyId: terraFam.id,
    versionTag: "gpt-6.1-terra",
    aliases: ["terra"],
    capabilitiesDocumented: { vision: true, tools: true, streaming: true },
    planEligibility: "paid",
    lifecycleState: "active",
    isDefaultInFamily: true,
  }).returning();

  const [terraEp] = await db.insert(modelEndpoints).values({
    versionId: terraVer.id,
    providerName: "openrouter",
    transportType: "router",
    adapterType: "chat_completions",
    endpointUrl: "https://openrouter.ai/api/v1/chat/completions",
    capabilitiesVerified: { vision: true, tools: true, streaming: true },
    privacyReview: { privacyApproved: true, scope: "default", zeroDataRetention: true, trainingPolicy: "denied" },
    endpointState: "active",
    sortPriority: 10,
  }).returning();

  await db.insert(modelPricingSnapshots).values({
    endpointId: terraEp.id,
    pricingVersionId: "pv_terra_v1",
    effectiveFrom: new Date("2026-01-01"),
    currency: "USD",
    billingUnit: "usd_per_1m_tokens",
    inputPriceMicrosPerM: 1_000_000, // $1.00 / 1M
    outputPriceMicrosPerM: 4_000_000, // $4.00 / 1M
    calculatedMu: 2.5,
    consumptionCategory: "high",
    pricingConfidence: "verified",
    provenance: "provider_pricing_sheet_2026",
  });

  return { lumenFam, terraFam };
}

async function setupUser(db, userId, tier = "plus", currentPeriodStartedAt = null, currentPeriodEndsAt = null) {
  await db.execute(sql`INSERT INTO "user" (id, email) VALUES (${userId}, ${userId + "@example.com"}) ON CONFLICT (id) DO NOTHING;`);
  await db.insert(subscriptions).values({
    userId,
    tier,
    status: "active",
    currentPeriodStartedAt: currentPeriodStartedAt || new Date("2026-10-01T00:00:00Z"),
    currentPeriodEndsAt: currentPeriodEndsAt || new Date("2026-12-01T00:00:00Z"),
  });
}

test("1. Plan table and display pricing: Plus $5, Pro $12, Max $30, Free $0.11", () => {
  // Authoritative owner allowances
  assert.equal(PLAN_ALLOWANCES.plus.monthlyAllowanceMicros, 5_000_000); // $5 USD
  assert.equal(PLAN_ALLOWANCES.pro.monthlyAllowanceMicros, 12_000_000); // $12 USD
  assert.equal(PLAN_ALLOWANCES.max.monthlyAllowanceMicros, 30_000_000); // $30 USD
  assert.equal(PLAN_ALLOWANCES.free.monthlyAllowanceMicros, 110_000);   // $0.11 USD

  // Plus and Pro subscription prices remain strictly unchanged
  const plusPlan = PRODUCT_KNOWLEDGE.plans.find((p) => p.id === "plus");
  assert.equal(plusPlan.monthly, "$4.99");
  assert.equal(plusPlan.yearly, "$49.99");

  const proPlan = PRODUCT_KNOWLEDGE.plans.find((p) => p.id === "pro");
  assert.equal(proPlan.monthly, "$12.99");
  assert.equal(proPlan.yearly, "$129.99");

  // Max plan details: annual launch authorized, internal cost language removed
  const maxPlan = PRODUCT_KNOWLEDGE.plans.find((p) => p.id === "max");
  assert.equal(maxPlan.monthly, "$49.99");
  assert.equal(maxPlan.yearly, "$499.90");
  assert.doesNotMatch(maxPlan.details.join(" "), /\$30 of actual AI cost/);
});

test("2. Actual-cost deductions without 10% platform markup", () => {
  // Nova rates: input $0.10/1M, output $0.50/1M
  // 1,000 input tokens + 512 buffer = 1,512 tokens -> 1,512 * $0.10 = 151,200,000 pico = 152 micros.
  // 1,000 output tokens -> 1,000 * $0.50 = 500,000,000 pico = 500 micros.
  // Total raw cost = 652 micro-dollars.
  // Under authoritative policy: NO 10% platform markup.
  // Customer deduction = 652 micro-dollars (not 717).
  const est = estimateInferenceReservationCost({
    modelKey: "nova",
    estimatedInputTokens: 1000,
    maxOutputTokens: 1000,
  });

  assert.equal(est.rawCostMicros, 652);
  assert.equal(est.reservedCostMicros, 652);
  assert.equal(est.rawCostMicros, est.reservedCostMicros);
});

test("3. Max billing & configuration support: lookup key and missing configuration safety", async () => {
  assert.equal(VALID_PRICE_LOOKUP_KEYS.has("vibhavgpt_max_monthly"), true);
  assert.equal(VALID_PRICE_LOOKUP_KEYS.has("vibhavgpt_max_yearly"), true);
  assert.equal(tierForPriceLookupKey("vibhavgpt_max_monthly"), "max");
  assert.equal(tierForPriceLookupKey("vibhavgpt_max_yearly"), "max");

  // Missing Stripe configuration throws safely without inventing live IDs
  const fakeStripe = {
    prices: {
      list: async () => ({ data: [] }),
    },
  };

  await assert.rejects(
    createCheckoutSession({
      userId: "u_test_checkout",
      email: "test@example.com",
      priceLookupKey: "vibhavgpt_max_monthly",
      origin: "https://vibhavgpt.com",
    }, { stripe: fakeStripe, getCustomer: async () => "cus_mock" }),
    (err) => {
      assert.match(err.message, /The selected plan is unavailable/i);
      return true;
    }
  );
});

test("4. Server-authoritative Max entitlement and capability inheritance", async () => {
  const activeMaxSub = {
    tier: "max",
    status: "active",
    currentPeriodEndsAt: new Date(Date.now() + 86400000),
  };
  assert.equal(tierForSubscription(activeMaxSub), "max");

  // Max users inherit eligibility for paid and pro_only models
  const proDecision = await evaluateRoutingDecision({
    plan: "max",
    requestedModel: { modelKey: "gpt-6.1-terra" },
    context: { estimatedInputTokens: 100, maxOutputTokens: 500 },
  }, {
    registrySnapshot: [
      {
        family: { id: "fam_1", slug: "openai/gpt-6.1-terra", familyGroup: "OpenAI", sortOrder: 1 },
        version: {
          id: "ver_1",
          familyId: "fam_1",
          versionTag: "gpt-6.1-terra",
          aliases: ["gpt-6.1-terra"],
          planEligibility: "pro_only",
          lifecycleState: "active",
          capabilitiesDocumented: {},
        },
        endpoints: [
          {
            id: "ep_1",
            versionId: "ver_1",
            providerName: "openrouter",
            transportType: "router",
            endpointState: "active",
            privacyReview: { privacyApproved: true, scope: "default" },
            pricing: {
              pricingVersionId: "pv_terra_v1",
              effectiveFrom: new Date("2026-01-01"),
              effectiveTo: null,
              calculatedMu: 8.0,
              consumptionCategory: "extra_high",
              pricingConfidence: "verified",
              inputPriceMicrosPerM: 1_000_000,
              outputPriceMicrosPerM: 4_000_000,
            },
          },
        ],
      },
    ],
  });

  assert.equal(proDecision.eligible, true);
  assert.equal(proDecision.selectedCandidate.versionTag, "gpt-6.1-terra");
});

test("5. Reservation and settlement consistency with actual-cost deduction", async (t) => {
  const { db } = await createDatabase(t);
  await seedTestCatalog(db);
  const userId = "u_consist_user";
  await setupUser(db, userId, "plus");

  // Plus user has $5.00 (5,000,000 micro-dollars)
  const initialBal = await getAvailableAllowance(userId, {}, db);
  assert.equal(initialBal.availableMicros, 5_000_000);

  const result = await executeWithCoordinator({
    userId,
    logicalRequestId: "req_consist_1",
    modelKey: "gpt-6.1-terra",
    prompt: "Hello Terra",
    context: { estimatedInputTokens: 100, maxOutputTokens: 500 },
    transport: async () => ({
      text: "Terra response",
      usage: { prompt_tokens: 100, completion_tokens: 200 },
    }),
    db,
  });

  assert.equal(result.success, true);
  // Confirmed usage: 100 in ($1/1M = 100 micros) + 200 out ($4/1M = 800 micros) = 900 micro-dollars.
  assert.equal(result.settlement.settledCostMicros, 900);

  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_consist_1"));
  assert.equal(row.status, ALLOWANCE_LIFECYCLE_STATES.SETTLED);
  assert.equal(row.settledCostMicros, 900);
  assert.equal(row.rawCostMicros, 900); // 100% actual cost, no markup!

  // Final user balance reflects exact deduction of actual cost
  const finalBal = await getAvailableAllowance(userId, {}, db);
  assert.equal(finalBal.availableMicros, 5_000_000 - 900);
});

test("6. Concurrent requests near the allowance boundary serialize cleanly", async (t) => {
  const { db } = await createDatabase(t);
  await seedTestCatalog(db);
  const userId = "u_boundary_race";
  await setupUser(db, userId, "plus");

  const now = new Date("2026-10-30T10:00:00Z");

  // Pre-consume balance so only 700 micros remain in the Plus cycle pool ($5.00 / 5,000,000 cap)
  // Request 1 will consume 652 micros, leaving only 48 micros (< minimum 256 token floor) for Request 2.
  await db.insert(shadowCostLedger).values({
    userId,
    requestId: "req_preconsume",
    attemptNumber: 1,
    operation: "inference",
    modelKey: "nova",
    pricingVersionId: "pricing_snapshot_2026_10",
    pricingSource: "manual",
    reservedCostMicros: 0,
    settledCostMicros: 4_999_300,
    status: "settled",
    idempotencyKey: "race_preconsume_key",
    createdAt: now,
    updatedAt: now,
  });

  const balBefore = await getAvailableAllowance(userId, { now }, db);
  assert.equal(balBefore.availableMicros, 700);

  // Two parallel reservations each requesting 652 micros (together = 1304 > 700)
  const [res1, res2] = await Promise.allSettled([
    reserveAllowance({
      userId,
      requestId: "req_race_1",
      modelKey: "nova",
      estimatedInputTokens: 1000,
      maxOutputTokens: 1000,
      idempotencyKey: "race_idem_1",
      now,
    }, db),
    reserveAllowance({
      userId,
      requestId: "req_race_2",
      modelKey: "nova",
      estimatedInputTokens: 1000,
      maxOutputTokens: 1000,
      idempotencyKey: "race_idem_2",
      now,
    }, db),
  ]);

  const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
  const rejected = [res1, res2].filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof AllowanceExceededError);

  const balAfter = await getAvailableAllowance(userId, { now }, db);
  assert.equal(balAfter.monthly.usedMicros, 4_999_300 + fulfilled[0].value.reservedCostMicros);
});

test("7. Exhaustion restricts paid models but offers approved free choices with clear reset", async (t) => {
  const { db } = await createDatabase(t);
  await seedTestCatalog(db);
  const userId = "u_exhausted_user";
  const cycleStart = new Date("2026-10-15T00:00:00Z");
  await setupUser(db, userId, "plus", cycleStart);

  const now = new Date("2026-10-20T12:00:00Z");

  // Fully consume the $5.00 allowance
  await db.insert(shadowCostLedger).values({
    userId,
    requestId: "req_full_consume",
    attemptNumber: 1,
    operation: "inference",
    modelKey: "gpt-6.1-terra",
    pricingVersionId: "pv_terra_v1",
    pricingSource: "manual",
    reservedCostMicros: 0,
    settledCostMicros: 5_000_000,
    status: "settled",
    idempotencyKey: "full_consume_key",
    createdAt: now,
    updatedAt: now,
  });

  const bal = await getAvailableAllowance(userId, { now }, db);
  assert.equal(bal.availableMicros, 0);

  // 1. Attempting paid model dispatch throws CoordinatorAllowanceError with structured exhaustion info
  let paidTransportCalled = false;
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_exhausted_attempt",
      modelKey: "gpt-6.1-terra",
      prompt: "Can I use Terra?",
      transport: async () => { paidTransportCalled = true; },
      db,
      now: () => now,
      options: { now },
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorAllowanceError);
      assert.equal(err.code, COORDINATOR_ERROR_CODES.ALLOWANCE_EXCEEDED);
      assert.equal(err.paidModelRestricted, true);
      assert.equal(err.remainingIncludedAllowanceMicros, 0);
      assert.ok(err.resetAt != null);
      assert.ok(Array.isArray(err.availableFreeChoices));
      assert.equal(err.availableFreeChoices[0].modelKey, "lumen");
      assert.match(err.customerMessage, /free model group/i);
      return true;
    }
  );

  assert.equal(paidTransportCalled, false);

  // 2. Customer explicitly chooses an approved free model (VibhavGPT Lumen)
  // That free request successfully executes through the injected fake transport!
  let freeTransportCalled = false;
  let transportModelKey = null;
  const freeResult = await executeWithCoordinator({
    userId,
    logicalRequestId: "req_free_continuation",
    modelKey: "lumen",
    prompt: "Hello Lumen, please summarize this note.",
    transport: async ({ model, context }) => {
      freeTransportCalled = true;
      transportModelKey = model;
      return {
        text: "Here is your summary from Lumen.",
        usage: { prompt_tokens: 50, completion_tokens: 100 },
      };
    },
    db,
    now: () => now,
    options: { now },
  });

  assert.equal(freeTransportCalled, true);
  assert.equal(freeResult.success, true);
  assert.equal(freeResult.model, "lumen");
  assert.equal(freeResult.displayName, "VibhavGPT Lumen");
  assert.equal(freeResult.familyGroup, "native");
  assert.equal(freeResult.output, "Here is your summary from Lumen.");
  assert.equal(freeResult.settlement.settledCostMicros, 0);

  // No paid fallback occurred
  assert.equal(paidTransportCalled, false);
  assert.notEqual(transportModelKey, "gpt-6.1-terra");

  // No paid allowance was required or incorrectly deducted
  const balAfterFree = await getAvailableAllowance(userId, { now }, db);
  assert.equal(balAfterFree.availableMicros, 0);
  assert.equal(balAfterFree.monthly.usedMicros, 5_000_000); // Unchanged!

  // 3. If the approved free route is unavailable (e.g. disabled/maintenance),
  // return an honest unavailable state; do NOT silently fall back to a paid endpoint!
  const [lumenVersionRow] = await db.select().from(modelVersions).where(eq(modelVersions.versionTag, "lumen"));
  await db.update(modelEndpoints)
    .set({ endpointState: "disabled" })
    .where(eq(modelEndpoints.versionId, lumenVersionRow.id));

  let fallbackAttempted = false;
  await assert.rejects(
    executeWithCoordinator({
      userId,
      logicalRequestId: "req_free_unavailable",
      modelKey: "lumen",
      prompt: "Hello?",
      transport: async () => { fallbackAttempted = true; },
      db,
      options: { now },
    }),
    (err) => {
      assert.ok(err instanceof CoordinatorRoutingError);
      assert.match(err.customerMessage, /unavailable|not eligible|not available|no eligible/i);
      return true;
    }
  );
  assert.equal(fallbackAttempted, false);
});

test("8. Allowance resets at subscription billing-cycle boundary", async (t) => {
  const { db } = await createDatabase(t);
  await seedTestCatalog(db);
  const userId = "u_cycle_reset_user";

  // Cycle 1: Started Oct 1, 2026
  const cycle1Start = new Date("2026-10-01T00:00:00Z");
  await setupUser(db, userId, "plus", cycle1Start);

  // Consume $4.00 during cycle 1
  await db.insert(shadowCostLedger).values({
    userId,
    requestId: "req_cycle1",
    attemptNumber: 1,
    operation: "inference",
    modelKey: "gpt-6.1-terra",
    pricingVersionId: "pv_terra_v1",
    pricingSource: "manual",
    reservedCostMicros: 0,
    settledCostMicros: 4_000_000,
    status: "settled",
    idempotencyKey: "cycle1_key",
    createdAt: new Date("2026-10-10T12:00:00Z"),
    updatedAt: new Date("2026-10-10T12:00:00Z"),
  });

  // Near end of Cycle 1: remaining is $1.00 (1,000,000 micros)
  const balCycle1 = await getAvailableAllowance(userId, { now: new Date("2026-10-25T12:00:00Z") }, db);
  assert.equal(balCycle1.availableMicros, 1_000_000);

  // Cycle 2: In November 2026, after billing cycle boundary
  const balCycle2 = await getAvailableAllowance(userId, { now: new Date("2026-11-05T12:00:00Z") }, db);
  // Full $5.00 (5,000,000 micros) is restored; no prior cycle debt carry-over!
  assert.equal(balCycle2.availableMicros, 5_000_000);
  assert.equal(balCycle2.monthly.usedMicros, 0);
});

test("9. Missing usage remains pending reconciliation without invented charges", async (t) => {
  const { db } = await createDatabase(t);
  const now = new Date("2026-10-30T10:00:00Z");
  const userId = "u_missing_usage";
  await setupUser(db, userId, "plus");

  const res = await reserveAllowance({
    userId,
    requestId: "req_missing_1",
    modelKey: "nova",
    idempotencyKey: "idem_missing_1",
    now,
  }, db);

  await markDispatched({ reservationId: res.reservationId, now }, db);

  // Upstream returns missing/corrupt usage:
  const settled = await settleAllowance({
    reservationId: res.reservationId,
    usage: null,
    now,
  }, db);

  // Transitions to UNCERTAIN state, retaining hold pending reconciliation
  assert.equal(settled.status, ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN);
  assert.equal(settled.requiresReconciliation, true);
  assert.equal(settled.settledCostMicros, null); // NEVER invent charges!

  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, res.reservationId));
  assert.equal(row.status, ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN);
  assert.equal(row.settledCostMicros, null);
});

test("10. Zero customer debt: upstream overrun is capped at authorized hold with no surprise card charges", async (t) => {
  const { db } = await createDatabase(t);
  await seedTestCatalog(db);
  const userId = "u_zero_debt_user";
  await setupUser(db, userId, "plus");

  // Reservation hold: 100 in, 500 out on Terra -> 100*1 + 500*4 = 2100 micros
  const result = await executeWithCoordinator({
    userId,
    logicalRequestId: "req_overrun_zero_debt",
    modelKey: "gpt-6.1-terra",
    prompt: "Prompt",
    context: { estimatedInputTokens: 100, maxOutputTokens: 500 },
    transport: async () => ({
      text: "Massive unexpected response",
      usage: { prompt_tokens: 100, completion_tokens: 3000 }, // 3000 tokens returned!
    }),
    db,
  });

  assert.equal(result.success, true);
  // Actual vendor cost for 100 in + 3000 out: 100*1 + 3000*4 = 12,100 micros
  // Authorized reservation hold was ceil( (100+512)*1 + 500*4 ) = 612 + 2000 = 2612 micros
  // Customer deduction MUST be capped at the authorized hold!
  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.requestId, "req_overrun_zero_debt"));
  assert.equal(row.settledCostMicros, row.metadata.authorizedReservedCostMicros);
  assert.ok(row.rawCostMicros >= 12_100);
  assert.equal(row.metadata.platformAbsorbedOverrun, true);
  assert.ok(row.metadata.overrunMicros > 0);

  // Customer balance was deducted only by the capped hold; never negative, no carryover debt!
  const balance = await getAvailableAllowance(userId, {}, db);
  assert.ok(balance.availableMicros >= 0);
  assert.equal(balance.availableMicros, 5_000_000 - row.settledCostMicros);
});

test("11. Plus/Pro annual subscriptions: monthly allowance grants and date-clamping anchor", async (t) => {
  const { db } = await createDatabase(t);
  const userId = "u_annual_pro_user";

  // Pro annual subscriber: currentPeriodStartedAt Jan 31, 2026, currentPeriodEndsAt Jan 31, 2027
  const annualStart = new Date("2026-01-31T12:00:00Z");
  const annualEnd = new Date("2027-01-31T12:00:00Z");
  await setupUser(db, userId, "pro", annualStart, annualEnd);

  // Interval 1 (February): Date clamps to Feb 28 in a non-leap year
  const febMid = new Date("2026-02-15T12:00:00Z");
  const balFeb = await getAvailableAllowance(userId, { now: febMid }, db);
  // Pro user gets $12.00 (12,000,000 micros) per month, NOT $12 for the entire year or $144 upfront
  assert.equal(balFeb.availableMicros, 12_000_000);
  assert.equal(balFeb.monthly.periodStart.toISOString(), "2026-01-31T12:00:00.000Z");
  assert.equal(balFeb.monthly.periodEnd.toISOString(), "2026-02-28T12:00:00.000Z");

  // Consume $10.00 in February
  await db.insert(shadowCostLedger).values({
    userId,
    requestId: "req_annual_feb",
    attemptNumber: 1,
    operation: "inference",
    modelKey: "gpt-6.1-terra",
    pricingVersionId: "pv_terra_v1",
    pricingSource: "manual",
    reservedCostMicros: 0,
    settledCostMicros: 10_000_000,
    status: "settled",
    idempotencyKey: "annual_feb_key",
    createdAt: febMid,
    updatedAt: febMid,
  });

  const balFebAfter = await getAvailableAllowance(userId, { now: febMid }, db);
  assert.equal(balFebAfter.availableMicros, 2_000_000); // $2.00 remaining in February

  // Interval 2 (March): Date clamps back to March 31
  const marchMid = new Date("2026-03-15T12:00:00Z");
  const balMarch = await getAvailableAllowance(userId, { now: marchMid }, db);
  assert.equal(balMarch.availableMicros, 12_000_000); // Full $12.00 restored for March!
  assert.equal(balMarch.monthly.periodStart.toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(balMarch.monthly.periodEnd.toISOString(), "2026-03-31T12:00:00.000Z");

  // Max annual launch authorized
  assert.equal(VALID_PRICE_LOOKUP_KEYS.has("vibhavgpt_max_yearly"), true);
});
