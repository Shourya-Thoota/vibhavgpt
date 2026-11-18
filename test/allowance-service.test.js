import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

const { shadowCostLedger, subscriptions, userProfiles } = await import("../src/db/schema.js");
const {
  PLAN_ALLOWANCES,
  ALLOWANCE_LIFECYCLE_STATES,
  AllowanceError,
  AllowanceExceededError,
  AllowanceIdempotencyConflictError,
  AllowanceInvalidTransitionError,
  AllowanceNotFoundError,
  ACTIVE_ESTIMATION_POLICY,
  ESTIMATION_POLICY_VERSIONS,
  calculateFallbackUsageEstimate,
  estimateInferenceReservationCost,
  calculateDynamicOutputTokenCap,
  getAvailableAllowance,
  reserveAllowance,
  markDispatched,
  heartbeatReservation,
  settleAllowance,
  releaseAllowance,
  markUncertain,
  reconcileAllowanceReservation,
  recordAttemptCost,
  sweepStaleReservations,
} = await import("../src/usage/allowance-service.js");

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

test("pure math: estimateInferenceReservationCost applies actual-cost pico arithmetic and exact micro-dollar ceil rounding", () => {
  // Nova: input $0.10/1M ($100k pico/token), output $0.50/1M ($500k pico/token)
  // 1,000 input tokens + 512 buffer = 1,512 input tokens.
  // 1,000 output tokens.
  // Input raw: 1,512 * 100,000 = 151,200,000 pico
  // Output raw: 1,000 * 500,000 = 500,000,000 pico
  // Total raw: 651,200,000 pico ($0.0006512) -> rawCostMicros = ceil(651.2) = 652 micro-dollars
  // Deduct actual upstream AI cost without 10% platform markup
  // Reserved micro-dollars = rawCostMicros = 652 micro-dollars
  const est = estimateInferenceReservationCost({
    modelKey: "nova",
    estimatedInputTokens: 1000,
    maxOutputTokens: 1000,
  });

  assert.equal(est.rawCostMicros, 652);
  assert.equal(est.reservedCostMicros, 652);
  assert.equal(est.estimatedInputTokens, 1512);
  assert.equal(est.maxOutputTokens, 1000);
});

test("pure math: calculateDynamicOutputTokenCap calculates affordable output ceiling or returns 0 below floor", () => {
  // Nova: rateIn = 0.10, rateOut = 0.50
  // Suppose user has 1,000 micro-dollars available.
  // Input tokens: 500 (+ 512 buffer = 1,012 tokens).
  // Input cost micros: 1,012 tokens * 100,000 pico = 101,200,000 pico -> 102 micros.
  // Remaining for output: 1,000 - 102 = 898 micros -> 898,000,000 pico.
  // Output rate per token: 500,000 pico / token.
  // Affordable tokens = floor(898,000,000 / 500,000) = 1,796 tokens.
  const capped = calculateDynamicOutputTokenCap({
    availableMicros: 1000,
    estimatedInputTokens: 500,
    rateIn: 0.10,
    rateOut: 0.50,
  });
  assert.equal(capped, 1796);

  // If available allowance cannot support minimum floor of 256 tokens:
  const tooLow = calculateDynamicOutputTokenCap({
    availableMicros: 150,
    estimatedInputTokens: 500,
    rateIn: 0.10,
    rateOut: 0.50,
  });
  assert.equal(tooLow, 0);
});

test("allowance balance: initial balances reflect exact plan allowances across windows", async (t) => {
  const { db } = await createDatabase(t);

  const freeBalance = await getAvailableAllowance("user_free", { plan: "free" }, db);
  assert.equal(freeBalance.plan, "free");
  assert.equal(freeBalance.monthly.limitMicros, 110_000); // $0.11 USD
  assert.equal(freeBalance.monthly.remainingMicros, 110_000);
  assert.equal(freeBalance.daily.limitMicros, 11_000); // $0.011 USD
  assert.equal(freeBalance.daily.remainingMicros, 11_000);
  assert.equal(freeBalance.daily.maxDailyRequests, 20);
  assert.equal(freeBalance.images.maxImages, 0);
  assert.equal(freeBalance.availableImageMicros, 0);
  assert.equal(freeBalance.availableMicros, 11_000); // Bounded by daily window

  const plusBalance = await getAvailableAllowance("user_plus", { plan: "plus" }, db);
  assert.equal(plusBalance.plan, "plus");
  assert.equal(plusBalance.monthly.limitMicros, 5_000_000); // $5.00 USD cycle allowance
  assert.equal(plusBalance.images.maxImages, 25);
  assert.equal(plusBalance.availableMicros, 5_000_000);

  const proBalance = await getAvailableAllowance("user_pro", { plan: "pro" }, db);
  assert.equal(proBalance.plan, "pro");
  assert.equal(proBalance.monthly.limitMicros, 12_000_000); // $12.00 USD cycle allowance
  assert.equal(proBalance.images.maxImages, 60);
  assert.equal(proBalance.availableMicros, 12_000_000);

  const maxBalance = await getAvailableAllowance("user_max", { plan: "max" }, db);
  assert.equal(maxBalance.plan, "max");
  assert.equal(maxBalance.monthly.limitMicros, 30_000_000); // $30.00 USD cycle allowance
  assert.equal(maxBalance.images.maxImages, 200);
  assert.equal(maxBalance.availableMicros, 30_000_000);
});

test("image allowances: spending sublimit and count ceiling enforce pending image holds", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_img_user', 'u_img@example.com');`);
  await db.insert(subscriptions).values({ userId: "u_img_user", tier: "plus", status: "active" });

  const now = new Date("2026-10-30T10:00:00Z");

  // Initial: Plus has 25 images and $5.00 (5,000,000 micros) sublimit
  const bal0 = await getAvailableAllowance("u_img_user", { now }, db);
  assert.equal(bal0.images.remainingCount, 25);
  assert.equal(bal0.images.remainingMicros, 5_000_000);

  // Reserve 1 image
  const imgRes = await reserveAllowance({
    userId: "u_img_user",
    requestId: "req-img-1",
    modality: "image",
    modelKey: "fixture/image-standard",
    idempotencyKey: "idem-img-1",
    now,
  }, db);

  assert.equal(imgRes.status, "reserved");

  // Pending image reservation must count against remaining count AND remaining sublimit
  const bal1 = await getAvailableAllowance("u_img_user", { now }, db);
  assert.equal(bal1.images.usedCount, 1);
  assert.equal(bal1.images.remainingCount, 24);
  assert.equal(bal1.images.usedMicros, imgRes.reservedCostMicros);
  assert.equal(bal1.images.remainingMicros, 5_000_000 - imgRes.reservedCostMicros);
});

test("reservation lifecycle: reserve, dispatch, heartbeat, and settle with confirmed usage", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_pro_1', 'u_pro_1@example.com');`);
  await db.insert(subscriptions).values({
    userId: "u_pro_1",
    tier: "pro",
    status: "active",
  });

  const now = new Date("2026-10-30T10:00:00Z");

  // 1. Reserve allowance
  const res = await reserveAllowance({
    userId: "u_pro_1",
    requestId: "req-1",
    operation: "chat:completion",
    modelKey: "nova",
    estimatedInputTokens: 500,
    maxOutputTokens: 1000,
    idempotencyKey: "idem-req-1",
    now,
  }, db);

  assert.equal(res.status, "reserved");
  assert.ok(res.reservedCostMicros > 0);
  assert.equal(res.isDuplicate, false);

  // Verify available allowance decreased by reserved amount
  const balAfterRes = await getAvailableAllowance("u_pro_1", { now }, db);
  assert.equal(balAfterRes.rolling.usedMicros, res.reservedCostMicros);
  assert.equal(balAfterRes.availableMicros, 12_000_000 - res.reservedCostMicros);

  // 2. Mark dispatched
  const dispatched = await markDispatched({
    reservationId: res.reservationId,
    leaseDurationMs: 60_000,
    now: new Date("2026-10-30T10:00:01Z"),
  }, db);
  assert.equal(dispatched.status, "dispatched");
  assert.ok(dispatched.dispatchedAt);
  assert.ok(dispatched.leaseExpiresAt);

  // 3. Heartbeat reservation
  const heartbeat = await heartbeatReservation({
    reservationId: res.reservationId,
    leaseDurationMs: 90_000,
    now: new Date("2026-10-30T10:00:30Z"),
  }, db);
  assert.equal(heartbeat.status, "dispatched");
  assert.equal(heartbeat.leaseExpiresAt.toISOString(), new Date("2026-10-30T10:02:00Z").toISOString());

  // 4. Settle allowance with confirmed provider usage
  const settled = await settleAllowance({
    reservationId: res.reservationId,
    usage: { prompt_tokens: 450, completion_tokens: 300 },
    now: new Date("2026-10-30T10:00:45Z"),
  }, db);

  assert.equal(settled.status, "settled");
  assert.equal(settled.usageConfidence, "measured");
  assert.ok(settled.settledCostMicros > 0);
  assert.ok(settled.rawCostMicros > 0);
  assert.equal(settled.isIdempotent, false);

  // In ledger, hold must be 0 and settledCostMicros set
  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, res.reservationId));
  assert.equal(row.status, "settled");
  assert.equal(row.reservedCostMicros, 0);
  assert.equal(row.settledCostMicros, settled.settledCostMicros);
  assert.equal(row.reservationExpiresAt, null);
  assert.equal(row.leaseExpiresAt, null);

  // Balance now reflects exact settled amount (unused reservation released)
  const balAfterSettle = await getAvailableAllowance("u_pro_1", { now: new Date("2026-10-30T10:01:00Z") }, db);
  assert.equal(balAfterSettle.rolling.usedMicros, settled.settledCostMicros);
  assert.equal(balAfterSettle.availableMicros, 12_000_000 - settled.settledCostMicros);

  // 5. Duplicate settlement is idempotent
  const dupeSettle = await settleAllowance({
    reservationId: res.reservationId,
    usage: { prompt_tokens: 450, completion_tokens: 300 },
    now: new Date("2026-10-30T10:01:05Z"),
  }, db);
  assert.equal(dupeSettle.isIdempotent, true);
  assert.equal(dupeSettle.settledCostMicros, settled.settledCostMicros);
});

test("safe release and post-dispatch protection: pre-dispatch abort restores balance; dispatched release requires confirmed zero usage", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_plus_rel', 'u_plus_rel@example.com');`);
  await db.insert(subscriptions).values({
    userId: "u_plus_rel",
    tier: "plus",
    status: "active",
  });

  const now = new Date("2026-10-30T12:00:00Z");

  // Pre-dispatch reservation
  const res = await reserveAllowance({
    userId: "u_plus_rel",
    requestId: "req-rel-1",
    modelKey: "nova",
    estimatedInputTokens: 1000,
    maxOutputTokens: 2000,
    idempotencyKey: "idem-rel-1",
    now,
  }, db);

  // 1. Release pre-dispatch reservation
  const rel = await releaseAllowance({
    reservationId: res.reservationId,
    reason: "client_abort_before_generation",
    now: new Date("2026-10-30T12:00:02Z"),
  }, db);

  assert.equal(rel.status, "released");
  assert.equal(rel.releasedCostMicros, res.reservedCostMicros);
  assert.equal(rel.isIdempotent, false);

  // Balance fully restored
  const bal = await getAvailableAllowance("u_plus_rel", { now: new Date("2026-10-30T12:00:05Z") }, db);
  assert.equal(bal.rolling.usedMicros, 0);
  assert.equal(bal.availableMicros, 5_000_000);

  // Attempting to settle a released reservation MUST throw AllowanceInvalidTransitionError
  await assert.rejects(
    async () => {
      await settleAllowance({
        reservationId: res.reservationId,
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }, db);
    },
    (err) => err instanceof AllowanceInvalidTransitionError && err.code === "invalid_lifecycle_transition"
  );

  // 2. Post-dispatch protection: Dispatched reservation without confirmedZeroUsage MUST be rejected
  const resDisp = await reserveAllowance({
    userId: "u_plus_rel",
    requestId: "req-disp-2",
    modelKey: "nova",
    idempotencyKey: "idem-disp-2",
    now,
  }, db);
  await markDispatched({ reservationId: resDisp.reservationId, now }, db);

  await assert.rejects(
    async () => {
      await releaseAllowance({
        reservationId: resDisp.reservationId,
        reason: "upstream_500_unknown_consumption",
        confirmedZeroUsage: false, // NOT confirmed zero
        now,
      }, db);
    },
    (err) => err instanceof AllowanceInvalidTransitionError && err.message.includes("confirmed zero upstream usage")
  );

  // 3. Permitted post-dispatch release: confirmedZeroUsage === true
  const relZero = await releaseAllowance({
    reservationId: resDisp.reservationId,
    reason: "gateway_429_prior_to_compute",
    confirmedZeroUsage: true,
    now,
  }, db);
  assert.equal(relZero.status, "released");
  assert.equal(relZero.row.metadata.confirmedZeroUsage, true);
});

test("missing usage policy: server-controlled policy defaults to uncertain hold, preventing caller flags from establishing financial charges", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_missing_usage', 'u_missing@example.com');`);
  await db.insert(subscriptions).values({ userId: "u_missing_usage", tier: "pro", status: "active" });

  const now = new Date("2026-10-30T13:00:00Z");

  // Verify server-controlled active policy is disabled by default
  assert.equal(ACTIVE_ESTIMATION_POLICY, ESTIMATION_POLICY_VERSIONS.DISABLED);

  // 1. Missing usage -> transitions to UNCERTAIN, hold retained, metadata records policy
  const res1 = await reserveAllowance({
    userId: "u_missing_usage",
    requestId: "req-miss-1",
    modelKey: "nova",
    idempotencyKey: "idem-miss-1",
    now,
  }, db);
  await markDispatched({ reservationId: res1.reservationId, now }, db);

  const settleUncertain = await settleAllowance({
    reservationId: res1.reservationId,
    usage: null, // Missing usage
    now,
  }, db);

  assert.equal(settleUncertain.status, "uncertain");
  assert.equal(settleUncertain.requiresReconciliation, true);
  assert.equal(settleUncertain.reservedCostMicros, res1.reservedCostMicros);
  assert.equal(settleUncertain.row.metadata.estimationPolicy, "disabled");

  // Available balance retains the hold
  const balUncertain = await getAvailableAllowance("u_missing_usage", { now }, db);
  assert.equal(balUncertain.rolling.usedMicros, res1.reservedCostMicros);

  // 2. Caller passing text or estimation flags MUST NOT bypass server policy: still transitions to UNCERTAIN
  const res2 = await reserveAllowance({
    userId: "u_missing_usage",
    requestId: "req-miss-2",
    modelKey: "nova",
    idempotencyKey: "idem-miss-2",
    now,
  }, db);
  await markDispatched({ reservationId: res2.reservationId, now }, db);

  const settleStillUncertain = await settleAllowance({
    reservationId: res2.reservationId,
    usage: null,
    promptText: "A".repeat(700), // 700 bytes
    responseText: "B".repeat(350), // 350 chars
    now,
  }, db);

  assert.equal(settleStillUncertain.status, "uncertain");
  assert.equal(settleStillUncertain.requiresReconciliation, true);
  assert.equal(settleStillUncertain.reservedCostMicros, res2.reservedCostMicros);

  // 3. Pure diagnostic estimation helper calculateFallbackUsageEstimate works as an internal diagnostic tool
  const pureEstimate = calculateFallbackUsageEstimate({
    promptText: "A".repeat(700), // 700 bytes -> Math.ceil(700/3.5) = 200 * 1.15 = 230
    responseText: "B".repeat(350), // 350 chars -> Math.ceil(350/3.5) = 100 * 1.15 = 115
  });
  assert.equal(pureEstimate.promptTokens, 230);
  assert.equal(pureEstimate.completionTokens, 115);
  assert.equal(pureEstimate.bufferMultiplier, 1.15);
  assert.equal(pureEstimate.promptBytes, 700);
  assert.equal(pureEstimate.responseChars, 350);
});

test("window boundaries: unresolved holds older than 5 hours must NOT vanish from rolling or monthly windows", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_window_rollover', 'u_rollover@example.com');`);
  await db.insert(subscriptions).values({ userId: "u_window_rollover", tier: "plus", status: "active" });

  const sixHoursAgo = new Date("2026-10-30T06:00:00Z");

  // Create an in-flight dispatched reservation 6 hours ago
  const oldRes = await reserveAllowance({
    userId: "u_window_rollover",
    requestId: "req-old-dispatched",
    modelKey: "nova",
    idempotencyKey: "idem-old-disp",
    ttlMs: 24 * 60 * 60 * 1000,
    now: sixHoursAgo,
  }, db);
  await markDispatched({
    reservationId: oldRes.reservationId,
    leaseDurationMs: 24 * 60 * 60 * 1000,
    now: sixHoursAgo,
  }, db);

  // Now is 12:00 PM (6 hours later, outside 5-hour rolling window)
  const now = new Date("2026-10-30T12:00:00Z");
  const bal = await getAvailableAllowance("u_window_rollover", { now }, db);

  // Invariant: The active unresolved hold must still be included in rolling and monthly consumption!
  assert.equal(bal.rolling.usedMicros, oldRes.reservedCostMicros);
  assert.equal(bal.monthly.usedMicros, oldRes.reservedCostMicros);
  assert.equal(bal.availableMicros, 5_000_000 - oldRes.reservedCostMicros);
});

test("reconciliation auditability: append-only history, explicit ownership context, admin override, duplicate idempotency, and raw cost capture", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_audit_user', 'u_audit@example.com');`);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_other_user', 'u_other@example.com');`);
  await db.insert(subscriptions).values({ userId: "u_audit_user", tier: "pro", status: "active" });
  await db.insert(subscriptions).values({ userId: "u_other_user", tier: "pro", status: "active" });

  const now = new Date("2026-10-30T15:00:00Z");

  const res = await reserveAllowance({
    userId: "u_audit_user",
    requestId: "req-audit-1",
    modelKey: "nova",
    idempotencyKey: "idem-audit-1",
    now,
  }, db);
  await markDispatched({ reservationId: res.reservationId, now }, db);
  await markUncertain({ reservationId: res.reservationId, reason: "upstream_stream_drop", now }, db);

  // 1. Reconciling without userId and without adminOverride MUST be rejected
  await assert.rejects(
    async () => {
      await reconcileAllowanceReservation({
        reservationId: res.reservationId,
        userId: null,
        confirmedRawCostMicros: 3500,
        confirmedCustomerDeductionMicros: 3850,
      }, db);
    },
    (err) => err instanceof AllowanceError && err.code === "missing_user_id"
  );

  // 2. Cross-account unauthorized reconciliation attempt MUST be blocked with AllowanceNotFoundError
  await assert.rejects(
    async () => {
      await reconcileAllowanceReservation({
        reservationId: res.reservationId,
        userId: "u_other_user", // Mismatched user
        confirmedRawCostMicros: 3500,
        confirmedCustomerDeductionMicros: 3850,
        now: new Date("2026-10-30T22:15:00Z"),
      }, db);
    },
    (err) => err instanceof AllowanceNotFoundError
  );

  // 3. Admin override without adminContext.actorId MUST be rejected
  await assert.rejects(
    async () => {
      await reconcileAllowanceReservation({
        reservationId: res.reservationId,
        adminOverride: true,
        adminContext: null,
        confirmedRawCostMicros: 3500,
        confirmedCustomerDeductionMicros: 3850,
      }, db);
    },
    (err) => err instanceof AllowanceError && err.code === "invalid_admin_context"
  );

  // 4. Authorized account reconciliation with verified userId succeeds
  const reconciled = await reconcileAllowanceReservation({
    reservationId: res.reservationId,
    userId: "u_audit_user",
    confirmedUsage: { prompt_tokens: 5000, completion_tokens: 5000 },
    confirmedRawCostMicros: 3500, // $0.0035 raw cost
    confirmedCustomerDeductionMicros: 3850, // 1.10x
    reason: "provider_monthly_invoice_audit",
    now: new Date("2026-10-30T22:00:00Z"),
  }, db);

  assert.equal(reconciled.status, "reconciled");
  assert.equal(reconciled.rawCostMicros, 3500);
  assert.equal(reconciled.settledCostMicros, 3850);

  // Verify append-only audit trail in metadata
  const [row] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, res.reservationId));
  assert.ok(Array.isArray(row.metadata.auditLog));
  assert.equal(row.metadata.auditLog.length, 1);
  assert.equal(row.metadata.auditLog[0].previousStatus, "uncertain");
  assert.equal(row.metadata.auditLog[0].confirmedRawCostMicros, 3500);
  assert.deepEqual(row.metadata.auditLog[0].reconciledBy, { type: "user", userId: "u_audit_user" });

  // 5. Duplicate reconciliation with identical values is idempotent
  const dupeReconcile = await reconcileAllowanceReservation({
    reservationId: res.reservationId,
    userId: "u_audit_user",
    confirmedRawCostMicros: 3500,
    confirmedCustomerDeductionMicros: 3850,
    now: new Date("2026-10-30T22:05:00Z"),
  }, db);
  assert.equal(dupeReconcile.isIdempotent, true);

  // 6. Conflicting reconciliation replay MUST be rejected
  await assert.rejects(
    async () => {
      await reconcileAllowanceReservation({
        reservationId: res.reservationId,
        userId: "u_audit_user",
        confirmedRawCostMicros: 9999,
        confirmedCustomerDeductionMicros: 10999,
        now: new Date("2026-10-30T22:10:00Z"),
      }, db);
    },
    (err) => err instanceof AllowanceInvalidTransitionError && err.message.includes("already reconciled")
  );

  // 7. Administrative reconciliation path with adminOverride and adminContext succeeds
  const resAdmin = await reserveAllowance({
    userId: "u_other_user",
    requestId: "req-admin-audit",
    modelKey: "nova",
    idempotencyKey: "idem-admin-audit",
    now,
  }, db);
  await markDispatched({ reservationId: resAdmin.reservationId, now }, db);
  await markUncertain({ reservationId: resAdmin.reservationId, reason: "upstream_timeout", now }, db);

  const adminReconciled = await reconcileAllowanceReservation({
    reservationId: resAdmin.reservationId,
    adminOverride: true,
    adminContext: { actorId: "admin_finance_lead", role: "finance_ops" },
    confirmedUsage: { prompt_tokens: 1000, completion_tokens: 1000 },
    confirmedRawCostMicros: 700,
    confirmedCustomerDeductionMicros: 770,
    reason: "billing_ops_manual_adjustment",
    now: new Date("2026-10-30T23:00:00Z"),
  }, db);

  assert.equal(adminReconciled.status, "reconciled");
  const [rowAdmin] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, resAdmin.reservationId));
  assert.equal(rowAdmin.metadata.auditLog.length, 1);
  assert.deepEqual(rowAdmin.metadata.auditLog[0].reconciledBy, {
    type: "admin",
    actorId: "admin_finance_lead",
    role: "finance_ops",
  });
});

test("concurrency races: competing reservations near limit, duplicate keys, conflicting keys, settle vs release, and sweep races", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_race_user', 'u_race@example.com');`);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_race_idem', 'u_idem@example.com');`);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_race_sr', 'u_sr@example.com');`);
  await db.insert(subscriptions).values({ userId: "u_race_user", tier: "plus", status: "active" });
  await db.insert(subscriptions).values({ userId: "u_race_idem", tier: "pro", status: "active" });
  await db.insert(subscriptions).values({ userId: "u_race_sr", tier: "pro", status: "active" });

  const now = new Date("2026-10-30T16:00:00Z");

  // Pre-consume balance so only 700 micros remain in the Plus cycle pool (5,000,000 cap)
  // Request 1 will consume 652 micros, leaving only 48 micros (< minimum 256 token floor) for Request 2.
  await db.insert(shadowCostLedger).values({
    userId: "u_race_user",
    requestId: "req-race-preconsume",
    attemptNumber: 1,
    operation: "inference",
    modelKey: "nova",
    pricingVersionId: "pricing_snapshot_2026_10",
    pricingSource: "manual",
    reservedCostMicros: 0,
    settledCostMicros: 4_999_300,
    status: "settled",
    idempotencyKey: "race-preconsume-key",
    createdAt: now,
    updatedAt: now,
  });

  const balBefore = await getAvailableAllowance("u_race_user", { now }, db);
  assert.equal(balBefore.availableMicros, 700);

  // Race 1: Two parallel reservations each requesting 652 micros (together = 1,304 > 700)
  const [raceRes1, raceRes2] = await Promise.allSettled([
    reserveAllowance({
      userId: "u_race_user",
      requestId: "req-race-a",
      modelKey: "nova",
      estimatedInputTokens: 1000,
      maxOutputTokens: 1000,
      idempotencyKey: "race-key-a",
      now,
    }, db),
    reserveAllowance({
      userId: "u_race_user",
      requestId: "req-race-b",
      modelKey: "nova",
      estimatedInputTokens: 1000,
      maxOutputTokens: 1000,
      idempotencyKey: "race-key-b",
      now,
    }, db),
  ]);

  // Serialized by advisory lock: Exactly ONE must succeed and ONE must fail with AllowanceExceededError
  const succeeded = [raceRes1, raceRes2].filter((r) => r.status === "fulfilled");
  const failed = [raceRes1, raceRes2].filter((r) => r.status === "rejected");
  assert.equal(succeeded.length, 1);
  assert.equal(failed.length, 1);
  assert.ok(failed[0].reason instanceof AllowanceExceededError);

  // Final persisted balance reflects exactly the single winner's reservation
  const balAfter = await getAvailableAllowance("u_race_user", { now }, db);
  assert.equal(balAfter.monthly.usedMicros, 4_999_300 + succeeded[0].value.reservedCostMicros);
  assert.equal(balAfter.rolling.usedMicros, 4_999_300 + succeeded[0].value.reservedCostMicros);

  // Race 2: Concurrent identical idempotency keys return identical reservation
  const [idemA, idemB] = await Promise.allSettled([
    reserveAllowance({
      userId: "u_race_idem",
      requestId: "req-idem-same",
      modelKey: "nova",
      idempotencyKey: "shared-idem-key",
      now,
    }, db),
    reserveAllowance({
      userId: "u_race_idem",
      requestId: "req-idem-same",
      modelKey: "nova",
      idempotencyKey: "shared-idem-key",
      now,
    }, db),
  ]);
  assert.equal(idemA.status, "fulfilled");
  assert.equal(idemB.status, "fulfilled");
  assert.equal(idemA.value.reservationId, idemB.value.reservationId);

  // Race 3: Concurrent conflicting payloads for the same idempotency key
  const [conflictA, conflictB] = await Promise.allSettled([
    reserveAllowance({
      userId: "u_race_idem",
      requestId: "req-conflict-a",
      operation: "operation_alpha",
      modelKey: "nova",
      idempotencyKey: "key-with-conflict",
      now,
    }, db),
    reserveAllowance({
      userId: "u_race_idem",
      requestId: "req-conflict-b",
      operation: "operation_beta",
      modelKey: "nova",
      idempotencyKey: "key-with-conflict",
      now,
    }, db),
  ]);
  const conflictWins = [conflictA, conflictB].filter((r) => r.status === "fulfilled");
  const conflictLoss = [conflictA, conflictB].filter((r) => r.status === "rejected");
  assert.equal(conflictWins.length, 1);
  assert.equal(conflictLoss.length, 1);
  assert.ok(conflictLoss[0].reason instanceof AllowanceIdempotencyConflictError);

  // Race 4: Settle versus release
  const resSettleRelease = await reserveAllowance({
    userId: "u_race_sr",
    requestId: "req-sr-1",
    modelKey: "nova",
    idempotencyKey: "idem-sr-1",
    now,
  }, db);

  const [settleOutcome, releaseOutcome] = await Promise.allSettled([
    settleAllowance({
      reservationId: resSettleRelease.reservationId,
      usage: { prompt_tokens: 100, completion_tokens: 100 },
      now,
    }, db),
    releaseAllowance({
      reservationId: resSettleRelease.reservationId,
      reason: "client_abort_race",
      now,
    }, db),
  ]);

  // One operation must win; the losing operation must fail with AllowanceInvalidTransitionError
  const terminalSuccess = [settleOutcome, releaseOutcome].filter((r) => r.status === "fulfilled");
  const terminalFailure = [settleOutcome, releaseOutcome].filter((r) => r.status === "rejected");
  assert.equal(terminalSuccess.length, 1);
  assert.equal(terminalFailure.length, 1);
  assert.ok(terminalFailure[0].reason instanceof AllowanceInvalidTransitionError);

  // Race 5: Settlement versus stale sweep
  const resSweepRace = await reserveAllowance({
    userId: "u_race_sr",
    requestId: "req-sw-1",
    modelKey: "nova",
    idempotencyKey: "idem-sw-1",
    now,
  }, db);
  await markDispatched({
    reservationId: resSweepRace.reservationId,
    leaseDurationMs: 10, // Expired immediately
    now: new Date(now.getTime() - 100000),
  }, db);

  const [settleRaceRes, sweepRaceRes] = await Promise.allSettled([
    settleAllowance({
      reservationId: resSweepRace.reservationId,
      usage: { prompt_tokens: 200, completion_tokens: 200 },
      now,
    }, db),
    sweepStaleReservations({
      leaseGracePeriodMs: 0,
      now,
    }, db),
  ]);

  // Both complete cleanly without database deadlocks; final state is terminal settled or uncertain
  const [persistedRow] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, resSweepRace.reservationId));
  assert.ok(persistedRow.status === "settled" || persistedRow.status === "uncertain");
});

test("stale reservation sweep: undispatched released, dispatched transitioned to uncertain", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_sweep_1', 'u_sweep_1@example.com');`);
  await db.insert(subscriptions).values({ userId: "u_sweep_1", tier: "pro", status: "active" });

  const past = new Date("2026-10-30T09:00:00Z");

  // 1. Undispatched reservation whose TTL expired 10 minutes ago
  const undispatched = await reserveAllowance({
    userId: "u_sweep_1",
    requestId: "req-sweep-undispatched",
    modelKey: "nova",
    idempotencyKey: "idem-sweep-undisp",
    ttlMs: 60_000,
    now: past,
  }, db);

  // 2. Dispatched reservation whose worker lease expired 10 minutes ago
  const dispatched = await reserveAllowance({
    userId: "u_sweep_1",
    requestId: "req-sweep-dispatched",
    modelKey: "nova",
    idempotencyKey: "idem-sweep-disp",
    ttlMs: 600_000,
    now: past,
  }, db);
  await markDispatched({
    reservationId: dispatched.reservationId,
    leaseDurationMs: 60_000,
    now: past,
  }, db);

  const sweepNow = new Date("2026-10-30T09:10:00Z");
  const sweepResult = await sweepStaleReservations({
    leaseGracePeriodMs: 60_000,
    reservationGracePeriodMs: 60_000,
    now: sweepNow,
  }, db);

  assert.equal(sweepResult.releasedCount, 1);
  assert.equal(sweepResult.uncertainCount, 1);

  // Undispatched must be released and hold cleared
  const [rowUndisp] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, undispatched.reservationId));
  assert.equal(rowUndisp.status, "released");
  assert.equal(rowUndisp.reservedCostMicros, 0);

  // Dispatched must NEVER be silently released: it must be uncertain, retaining hold
  const [rowDisp] = await db.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, dispatched.reservationId));
  assert.equal(rowDisp.status, "uncertain");
  assert.ok(rowDisp.reservedCostMicros > 0);
});

test("attempt cost recording: retries log upstream vendor costs but customer settled cost remains 0", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_retry_1', 'u_retry_1@example.com');`);
  await db.insert(subscriptions).values({ userId: "u_retry_1", tier: "pro", status: "active" });

  const now = new Date("2026-10-30T16:00:00Z");

  const parent = await reserveAllowance({
    userId: "u_retry_1",
    requestId: "req-retry-parent",
    modelKey: "nova",
    idempotencyKey: "idem-retry-parent",
    now,
  }, db);

  // Record failed attempt 1 (e.g. timeout after 500 input tokens)
  const attempt1 = await recordAttemptCost({
    parentReservationId: parent.reservationId,
    attemptNumber: 1,
    modelKey: "nova",
    usage: { prompt_tokens: 500, completion_tokens: 0 },
    isFailed: true,
    failureReason: "upstream_504_gateway_timeout",
    now,
  }, db);

  assert.equal(attempt1.status, "attempt_failed");
  assert.ok(attempt1.rawCostMicros > 0);
  assert.equal(attempt1.settledCostMicros, 0); // Customer is charged $0 for failed attempt

  // Settle parent reservation on attempt 2
  const settled = await settleAllowance({
    reservationId: parent.reservationId,
    usage: { prompt_tokens: 500, completion_tokens: 200 },
    now,
  }, db);

  assert.equal(settled.status, "settled");

  // Verify attempt 1 did not add duplicate charges to customer's allowance
  const bal = await getAvailableAllowance("u_retry_1", { now }, db);
  assert.equal(bal.rolling.usedMicros, settled.settledCostMicros);
});

test("pinned pricing invariant: catalog edits after reservation do not reprice settled operation", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_pin_1', 'u_pin_1@example.com');`);
  await db.insert(subscriptions).values({ userId: "u_pin_1", tier: "pro", status: "active" });

  const now = new Date("2026-10-30T18:00:00Z");

  const res = await reserveAllowance({
    userId: "u_pin_1",
    requestId: "req-pin-1",
    modelKey: "nova",
    pricingVersionId: "pricing_snapshot_2026_10",
    idempotencyKey: "idem-pin-1",
    now,
  }, db);

  assert.equal(res.pricingVersionId, "pricing_snapshot_2026_10");

  const settled = await settleAllowance({
    reservationId: res.reservationId,
    usage: { prompt_tokens: 1000, completion_tokens: 1000 },
    now: new Date("2026-10-30T18:05:00Z"),
  }, db);

  assert.equal(settled.settledCostMicros, 600);
  assert.equal(settled.rawCostMicros, 600);
});

test("cross-account isolation: User A operations do not impact User B balances", async (t) => {
  const { db, client } = await createDatabase(t);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_iso_a', 'u_iso_a@example.com');`);
  await client.exec(`INSERT INTO "user" (id, email) VALUES ('u_iso_b', 'u_iso_b@example.com');`);
  await db.insert(subscriptions).values({ userId: "u_iso_a", tier: "plus", status: "active" });
  await db.insert(subscriptions).values({ userId: "u_iso_b", tier: "plus", status: "active" });

  const now = new Date("2026-10-30T19:00:00Z");

  await reserveAllowance({
    userId: "u_iso_a",
    requestId: "req-iso-a",
    modelKey: "nova",
    estimatedInputTokens: 5000,
    maxOutputTokens: 20000,
    idempotencyKey: "idem-iso-a",
    now,
  }, db);

  const balA = await getAvailableAllowance("u_iso_a", { now }, db);
  const balB = await getAvailableAllowance("u_iso_b", { now }, db);

  assert.ok(balA.rolling.usedMicros > 0);
  assert.equal(balB.rolling.usedMicros, 0);
  assert.equal(balB.availableMicros, 5_000_000);
});
