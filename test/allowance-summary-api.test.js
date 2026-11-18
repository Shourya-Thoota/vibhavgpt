process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import express from "express";

const { config } = await import("../src/config.js");
const {
  shadowCostLedger,
  subscriptions,
  modelFamilies,
  modelVersions,
  modelEndpoints,
  modelPricingSnapshots,
} = await import("../src/db/schema.js");
const allowanceService = await import("../src/usage/allowance-service.js");
const coordinator = await import("../src/models/execution-coordinator.js");
const {
  getAllowanceSummary,
  PAID_USAGE_RESTRICTION_REASONS,
} = await import("../src/usage/allowance-summary.js");
const { createAllowanceRouter } = await import("../src/usage/allowance-router.js");


async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  }
  return { client, db: drizzle(client) };
}

async function seedFreeModel(db, { endpointState = "active", inputPrice = 0, outputPrice = 0, planEligibility = "free" } = {}) {
  const [fam] = await db.insert(modelFamilies).values({
    slug: "vibhavgpt/lumen",
    displayName: "VibhavGPT Lumen",
    familyGroup: "native",
    sortOrder: 1,
  }).returning();
  const [ver] = await db.insert(modelVersions).values({
    familyId: fam.id,
    versionTag: "lumen",
    aliases: ["lumen"],
    capabilitiesDocumented: { tools: true, streaming: true },
    planEligibility,
    lifecycleState: "active",
    isDefaultInFamily: true,
  }).returning();
  const [ep] = await db.insert(modelEndpoints).values({
    versionId: ver.id,
    providerName: "reserve_stage",
    transportType: "direct",
    adapterType: "chat_completions",
    endpointUrl: "https://mock.internal/lumen",
    capabilitiesVerified: { tools: true, streaming: true },
    privacyReview: { privacyApproved: true, scope: "default", zeroDataRetention: true, trainingPolicy: "denied" },
    endpointState,
    sortPriority: 1,
  }).returning();
  await db.insert(modelPricingSnapshots).values({
    endpointId: ep.id,
    pricingVersionId: "pv_lumen_free",
    effectiveFrom: new Date("2026-01-01"),
    currency: "USD",
    billingUnit: "usd_per_1m_tokens",
    inputPriceMicrosPerM: inputPrice,
    outputPriceMicrosPerM: outputPrice,
    cachedReadPriceMicrosPerM: 0,
    consumptionCategory: "low",
    pricingConfidence: "verified",
    provenance: "internal_free_zero_cost",
  });
  return { fam, ver, ep };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_START = (() => {
  const start = new Date(Date.now() - 10 * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  if (start.getUTCDate() > 28) start.setUTCDate(28);
  return start;
})();
const PERIOD_END = (() => { const end = new Date(PERIOD_START); end.setUTCMonth(end.getUTCMonth() + 1); return end; })();
// A moment inside that period and before today, for usage rows.
const NOW = new Date(PERIOD_START.getTime() + 5 * DAY_MS + 12 * 60 * 60 * 1000);
async function setupUser(db, userId, tier, startedAt = PERIOD_START, endsAt = PERIOD_END) {
  await db.execute(sql`INSERT INTO "user" (id, email) VALUES (${userId}, ${userId + "@example.com"}) ON CONFLICT (id) DO NOTHING;`);
  if (tier === "free") return;
  await db.insert(subscriptions).values({
    userId,
    tier,
    status: "active",
    currentPeriodStartedAt: startedAt,
    currentPeriodEndsAt: endsAt,
  });
}

let ledgerSeq = 0;
async function addLedgerRow(db, userId, { status, settled = null, reserved = 0, createdAt = NOW, reservationExpiresAt = null, dispatchedAt = null }) {
  ledgerSeq += 1;
  await db.insert(shadowCostLedger).values({
    userId,
    requestId: `req_summary_${ledgerSeq}`,
    attemptNumber: 1,
    operation: "inference",
    modelKey: "gpt-6.1-terra",
    provider: "openrouter",
    pricingVersionId: "pv_terra_v1",
    pricingSource: "manual",
    reservedCostMicros: reserved,
    settledCostMicros: settled,
    status,
    idempotencyKey: `idem_summary_${ledgerSeq}`,
    reservationExpiresAt,
    dispatchedAt,
    createdAt,
    updatedAt: createdAt,
  });
}

async function createTestApp(t, { db, session = null }) {
  const app = express();
  if (session) app.use((req, _res, next) => { req.authSession = session; next(); });
  app.use("/api/usage/allowance", createAllowanceRouter({ db }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return async (path, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, body };
  };
}

function withGate(t, value) {
  const original = config.featureAllowanceSummaryApi;
  config.featureAllowanceSummaryApi = value;
  t.after(() => { config.featureAllowanceSummaryApi = original; });
}

test("feature gate: FEATURE_ALLOWANCE_SUMMARY_API is the only flag and is off by default", () => {
  assert.equal(config.featureAllowanceSummaryApi, process.env.FEATURE_ALLOWANCE_SUMMARY_API === "true");
  if (process.env.FEATURE_ALLOWANCE_SUMMARY_API === undefined) {
    assert.equal(config.featureAllowanceSummaryApi, false, "allowance summary API must default to disabled");
  }
  assert.equal(config.featureChatAllowanceEnforcement, process.env.FEATURE_CHAT_ALLOWANCE_ENFORCEMENT === "true");
  assert.equal(config.chatAllowanceEnforcedTiers.length === 0 || process.env.CHAT_ALLOWANCE_ENFORCED_TIERS !== undefined, true, "no tier is enforced unless listed");
});

test("approved free group has a single authoritative definition shared by the coordinator", () => {
  assert.equal(coordinator.APPROVED_FREE_MODEL_GROUP, allowanceService.APPROVED_FREE_MODEL_GROUP);
  assert.ok(Object.isFrozen(allowanceService.APPROVED_FREE_MODEL_GROUP));
  assert.equal(allowanceService.APPROVED_FREE_MODEL_GROUP[0].modelKey, "lumen");
});

test("endpoint: disabled returns 404, unauthenticated returns 401, success is private no-store", async (t) => {
  const { db } = await createDatabase(t);
  await setupUser(db, "u_gate", "plus");

  withGate(t, false);
  const disabled = await createTestApp(t, { db, session: { user: { id: "u_gate" } } });
  const off = await disabled("/api/usage/allowance");
  assert.equal(off.status, 404);
  assert.equal(off.body.code, "feature_disabled");

  config.featureAllowanceSummaryApi = true;
  const anonymous = await createTestApp(t, { db, session: null });
  const unauth = await anonymous("/api/usage/allowance");
  assert.equal(unauth.status, 401);

  const member = await createTestApp(t, { db, session: { user: { id: "u_gate" } } });
  const ok = await member("/api/usage/allowance");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.equal(ok.body.plan, "plus");
});

test("plan allowances: Plus $5, Pro $12, Max $30 from server entitlement", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  const expected = { plus: ["$5.00", 5_000_000], pro: ["$12.00", 12_000_000], max: ["$30.00", 30_000_000] };
  for (const [tier, [display, micros]] of Object.entries(expected)) {
    const userId = `u_plan_${tier}`;
    await setupUser(db, userId, tier);
    const summary = await getAllowanceSummary({ userId, db, now: NOW });
    assert.equal(summary.plan, tier);
    assert.equal(summary.allowance.includedMicros, micros);
    assert.equal(summary.allowance.availableMicros, micros);
    assert.equal(summary.allowance.display.included, display);
    assert.equal(summary.allowance.display.available, display);
    assert.equal(summary.allowance.confirmedMicros, 0);
    assert.equal(summary.allowance.pendingMicros, 0);
    assert.equal(summary.allowance.resetCadence, "monthly");
    assert.equal(summary.allowance.resetAt, PERIOD_END.toISOString());
    assert.equal(summary.allowance.billingTermExtendsBeyondReset, false);
    assert.deepEqual(summary.paidUsage, { restricted: false, reason: null });
  }
});

test("free account: no paid allowance is shown and approved free choices remain", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  await setupUser(db, "u_free", "free");
  const summary = await getAllowanceSummary({ userId: "u_free", db, now: NOW });
  assert.equal(summary.plan, "free");
  assert.equal(summary.allowance, null);
  assert.deepEqual(summary.paidUsage, { restricted: true, reason: PAID_USAGE_RESTRICTION_REASONS.NO_PAID_ALLOWANCE });
  assert.equal(summary.freeChoices[0].available, true);
});

test("annual Pro: allowance is granted and reset monthly within the yearly billing term", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  await setupUser(db, "u_annual", "pro", new Date("2026-01-31T12:00:00Z"), new Date("2027-01-31T12:00:00Z"));
  await addLedgerRow(db, "u_annual", { status: "settled", settled: 10_000_000, createdAt: new Date("2026-02-15T12:00:00Z") });

  const feb = await getAllowanceSummary({ userId: "u_annual", db, now: new Date("2026-02-15T12:00:00Z") });
  assert.equal(feb.allowance.includedMicros, 12_000_000);
  assert.equal(feb.allowance.availableMicros, 2_000_000);
  assert.equal(feb.allowance.resetAt, "2026-02-28T12:00:00.000Z");
  assert.equal(feb.allowance.billingTermExtendsBeyondReset, true);

  const march = await getAllowanceSummary({ userId: "u_annual", db, now: new Date("2026-03-15T12:00:00Z") });
  assert.equal(march.allowance.availableMicros, 12_000_000);
  assert.equal(march.allowance.confirmedMicros, 0);
  assert.equal(march.allowance.resetAt, "2026-03-31T12:00:00.000Z");
});

test("confirmed usage is reported separately from pending reservations", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  await setupUser(db, "u_pending", "plus");
  const future = new Date(NOW.getTime() + 60_000);
  const past = new Date(NOW.getTime() - 60_000);
  await addLedgerRow(db, "u_pending", { status: "settled", settled: 1_234_567 });
  await addLedgerRow(db, "u_pending", { status: "reconciled", settled: 100_000 });
  await addLedgerRow(db, "u_pending", { status: "reserved", reserved: 40_000, reservationExpiresAt: future });
  await addLedgerRow(db, "u_pending", { status: "dispatched", reserved: 30_000, dispatchedAt: NOW });
  await addLedgerRow(db, "u_pending", { status: "uncertain", reserved: 20_000, dispatchedAt: NOW });
  // An expired, never-dispatched hold no longer counts.
  await addLedgerRow(db, "u_pending", { status: "reserved", reserved: 999_000, reservationExpiresAt: past });
  // A released hold never counts.
  await addLedgerRow(db, "u_pending", { status: "released", reserved: 500_000 });

  const summary = await getAllowanceSummary({ userId: "u_pending", db, now: NOW });
  assert.equal(summary.allowance.confirmedMicros, 1_334_567);
  assert.equal(summary.allowance.pendingMicros, 90_000);
  assert.equal(summary.allowance.availableMicros, 5_000_000 - 1_334_567 - 90_000);
  assert.equal(summary.allowance.display.confirmed, "$1.34", "spending rounds up");
  assert.equal(summary.allowance.display.pending, "$0.09");
  assert.equal(summary.allowance.display.available, "$3.57", "remaining rounds down");
  assert.equal(summary.paidUsage.restricted, false);
});

test("legacy shadow-observation rows (marked-up, never settled) are not counted as allowance usage", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  await setupUser(db, "u_shadow", "plus");
  // Native chat shadow measurement: status reaches "reconciled"/"measured" with only the
  // marked-up shadowDeductionMicros and no settledCostMicros.
  for (const status of ["reconciled", "measured", "estimated", "unpriced"]) {
    ledgerSeq += 1;
    await db.insert(shadowCostLedger).values({
      userId: "u_shadow",
      requestId: `req_shadow_${ledgerSeq}`,
      attemptNumber: 1,
      operation: "inference",
      modelKey: "nova",
      pricingVersionId: "pv_shadow",
      pricingSource: "manual",
      rawCostMicros: 1_000_000,
      shadowDeductionMicros: 1_100_000,
      status,
      idempotencyKey: `idem_shadow_${ledgerSeq}`,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const summary = await getAllowanceSummary({ userId: "u_shadow", db, now: NOW });
  assert.equal(summary.allowance.confirmedMicros, 0);
  assert.equal(summary.allowance.pendingMicros, 0);
  assert.equal(summary.allowance.availableMicros, 5_000_000);
});

test("exhausted allowance restricts paid usage and offers explicit approved free choices", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  await setupUser(db, "u_exhausted", "plus");
  await addLedgerRow(db, "u_exhausted", { status: "settled", settled: 5_000_000 });

  const summary = await getAllowanceSummary({ userId: "u_exhausted", db, now: NOW });
  assert.equal(summary.allowance.availableMicros, 0);
  assert.equal(summary.allowance.display.available, "$0.00");
  assert.deepEqual(summary.paidUsage, { restricted: true, reason: PAID_USAGE_RESTRICTION_REASONS.ALLOWANCE_EXHAUSTED });
  assert.deepEqual(summary.freeChoices, [{
    id: "vibhavgpt-lumen",
    modelKey: "lumen",
    displayName: "VibhavGPT Lumen",
    description: "Lightweight, simple tasks included on all accounts.",
    available: true,
    unavailableReason: null,
  }]);
});

test("remaining allowance held entirely by pending usage is reported as pending, not spent", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  await setupUser(db, "u_held", "plus");
  await addLedgerRow(db, "u_held", { status: "settled", settled: 4_000_000 });
  await addLedgerRow(db, "u_held", { status: "dispatched", reserved: 1_000_000, dispatchedAt: NOW });

  const summary = await getAllowanceSummary({ userId: "u_held", db, now: NOW });
  assert.equal(summary.allowance.availableMicros, 0);
  assert.equal(summary.allowance.confirmedMicros, 4_000_000);
  assert.equal(summary.allowance.pendingMicros, 1_000_000);
  assert.deepEqual(summary.paidUsage, { restricted: true, reason: PAID_USAGE_RESTRICTION_REASONS.PENDING_HOLDS });
});

test("free choices are unavailable when the endpoint is disabled, not zero-cost, not classified free, or missing", async (t) => {
  const cases = [
    ["disabled endpoint", { endpointState: "disabled" }],
    ["non-zero pricing despite a free label", { outputPrice: 1 }],
    ["version not classified free", { planEligibility: "all_limited" }],
  ];
  for (const [label, options] of cases) {
    const { db } = await createDatabase(t);
    await seedFreeModel(db, options);
    await setupUser(db, "u_unavailable", "plus");
    await addLedgerRow(db, "u_unavailable", { status: "settled", settled: 5_000_000 });
    const summary = await getAllowanceSummary({ userId: "u_unavailable", db, now: NOW });
    assert.equal(summary.freeChoices[0].available, false, label);
    assert.equal(summary.freeChoices[0].unavailableReason, "This model is temporarily unavailable.", label);
  }

  const { db } = await createDatabase(t);
  await setupUser(db, "u_no_registry", "plus");
  const empty = await getAllowanceSummary({ userId: "u_no_registry", db, now: NOW });
  assert.equal(empty.freeChoices[0].available, false, "empty registry");
});

test("cross-account isolation: the session decides the account; query parameters are ignored", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  await setupUser(db, "u_alpha", "max");
  await setupUser(db, "u_beta", "plus");
  await addLedgerRow(db, "u_alpha", { status: "settled", settled: 7_000_000 });
  withGate(t, true);

  const asBeta = await createTestApp(t, { db, session: { user: { id: "u_beta" } } });
  const res = await asBeta("/api/usage/allowance?userId=u_alpha&plan=max");
  assert.equal(res.status, 200);
  assert.equal(res.body.plan, "plus");
  assert.equal(res.body.allowance.includedMicros, 5_000_000);
  assert.equal(res.body.allowance.confirmedMicros, 0);

  const asAlpha = await createTestApp(t, { db, session: { user: { id: "u_alpha" } } });
  const alpha = await asAlpha("/api/usage/allowance");
  assert.equal(alpha.body.allowance.confirmedMicros, 7_000_000);
});

test("reading the summary makes no provider requests and writes nothing to the ledger", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  await setupUser(db, "u_readonly", "pro");
  await addLedgerRow(db, "u_readonly", { status: "dispatched", reserved: 50_000, dispatchedAt: NOW });
  const before = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.userId, "u_readonly"));

  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => { outboundCalls += 1; throw new Error("unexpected outbound request"); };
  try {
    for (let i = 0; i < 3; i++) await getAllowanceSummary({ userId: "u_readonly", db, now: NOW });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const after = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.userId, "u_readonly"));
  assert.equal(outboundCalls, 0);
  assert.deepEqual(after, before, "ledger rows are unchanged by reads");
});

test("response is an allowlisted DTO without ledger, provider, endpoint, or rate details", async (t) => {
  const { db } = await createDatabase(t);
  await seedFreeModel(db);
  await setupUser(db, "u_privacy", "pro");
  await addLedgerRow(db, "u_privacy", { status: "settled", settled: 1_000_000 });
  await addLedgerRow(db, "u_privacy", { status: "dispatched", reserved: 10_000, dispatchedAt: NOW });
  const summary = await getAllowanceSummary({ userId: "u_privacy", db, now: NOW });

  assert.deepEqual(Object.keys(summary).sort(), ["allowance", "enforcedModels", "enforcementConnected", "freeChoices", "paidUsage", "plan"]);
  assert.deepEqual(Object.keys(summary.allowance).sort(), [
    "availableMicros", "billingTermExtendsBeyondReset", "confirmedMicros", "currency", "display",
    "includedMicros", "pendingMicros", "periodStartedAt", "resetAt", "resetCadence",
  ]);
  const json = JSON.stringify(summary);
  for (const secret of ["openrouter", "reserve_stage", "mock.internal", "pv_", "req_summary", "idem_", "u_privacy", "gpt-6.1-terra", "PriceMicros", "provider", "endpoint"]) {
    assert.equal(json.includes(secret), false, `summary must not expose ${secret}`);
  }
});

test("native chat reaches the coordinator only through the gated gateway, and enforcement is off by default", async () => {
  const chatRouterSource = await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8");
  // The router's only ties to the allowance system: the gateway factory (which returns null unless
  // enforcement is on for this tier, plan and time) and the typed exhaustion error it maps to a response.
  assert.doesNotMatch(chatRouterSource, /allowance-summary|allowance-service|executeWithCoordinator|reserveAllowance/);
  assert.match(chatRouterSource, /maybeCreateChatAllowanceGateway/);
  const fresh = { featureChatAllowanceEnforcement: false, chatAllowanceActivatedAt: null, chatAllowanceEnforcedTiers: [] };
  const { enforcedTiersFor } = await import("../src/usage/chat-allowance-policy.js");
  for (const plan of ["free", "plus", "pro", "max"]) assert.deepEqual(enforcedTiersFor({ plan, settings: fresh }), []);
  const serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(serverSource, /app\.use\("\/api\/usage\/allowance", allowanceRouter\)/);
  assert.match(serverSource, /app\.use\("\/api\/chat", chatRouter\)/);
});
