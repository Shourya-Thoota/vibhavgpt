import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) {
  await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
}
const db = drizzle(client);

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (text, params) => client.query(text, params) } },
});

const schema = await import("../src/db/schema.js");
const {
  reserveAllowance,
  dispatchAllowance,
  settleAllowance,
  releaseAllowance,
  reconcileAllowance,
  getAvailableAllowance,
  calculateDynamicOutputTokenCap,
  estimateInferenceReservationCost,
  ALLOWANCE_LIFECYCLE_STATES,
  AllowanceInvalidTransitionError,
} = await import("../src/usage/allowance-service.js");

const {
  reserveUsage,
  estimateTurnReservationHoldMicros,
} = await import("../src/usage/service.js");

async function createTestUser(userId, tier = "plus") {
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, `${userId}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  await db.insert(schema.subscriptions).values({
    userId,
    tier,
    status: "active",
    currentPeriodStartedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    currentPeriodEndsAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
  });
}

test("Lifecycle (a): Dispatched request with no usage, >5 minutes elapsed retains budget hold", async () => {
  const userId = "u_lifecycle_a";
  await createTestUser(userId, "plus");

  const now = new Date();
  const res = await reserveAllowance({
    userId,
    requestId: "req-a",
    idempotencyKey: `idem-a-${Date.now()}`,
    modelKey: "nova",
    estimatedInputTokens: 500,
    maxOutputTokens: 1000,
    now,
  }, db);

  // Dispatch to provider
  await dispatchAllowance({ reservationId: res.reservationId, now }, db);

  // 10 minutes pass without provider reply or settlement
  const tenMinutesLater = new Date(now.getTime() + 10 * 60 * 1000);
  const bal = await getAvailableAllowance(userId, { now: tenMinutesLater }, db);

  // The dispatched reservation must still be held (monthly.pendingMicros > 0)
  assert.ok(bal.monthly.pendingMicros > 0, "Dispatched request must retain pending hold after 10 minutes");
  assert.equal(
    bal.availableMicros,
    bal.monthly.limitMicros - bal.monthly.pendingMicros,
    "Available budget must remain reduced by the pending hold"
  );
});

test("Lifecycle (b): Confirmed pre-dispatch cancellation releases capacity immediately", async () => {
  const userId = "u_lifecycle_b";
  await createTestUser(userId, "plus");

  const now = new Date();
  const res = await reserveAllowance({
    userId,
    requestId: "req-b",
    idempotencyKey: `idem-b-${Date.now()}`,
    modelKey: "nova",
    estimatedInputTokens: 500,
    maxOutputTokens: 1000,
    now,
  }, db);

  let bal = await getAvailableAllowance(userId, { now }, db);
  assert.ok(bal.monthly.pendingMicros > 0);

  // Client aborts before dispatch
  const rel = await releaseAllowance({
    reservationId: res.reservationId,
    reason: "client_pre_dispatch_abort",
    confirmedZeroUsage: true,
    now,
  }, db);
  assert.equal(rel.status, ALLOWANCE_LIFECYCLE_STATES.RELEASED);

  bal = await getAvailableAllowance(userId, { now }, db);
  assert.equal(bal.monthly.pendingMicros, 0, "Capacity must be fully released on pre-dispatch abort");
  assert.equal(bal.availableMicros, bal.monthly.limitMicros);
});

test("Lifecycle (c): Dispatched request with zero local token counters but unconfirmed upstream usage retains hold", async () => {
  const userId = "u_lifecycle_c";
  await createTestUser(userId, "plus");

  const now = new Date();
  const res = await reserveAllowance({
    userId,
    requestId: "req-c",
    idempotencyKey: `idem-c-${Date.now()}`,
    modelKey: "nova",
    now,
  }, db);
  await dispatchAllowance({ reservationId: res.reservationId, now }, db);

  // Attempting release without confirmedZeroUsage must throw and keep hold
  await assert.rejects(
    () => releaseAllowance({ reservationId: res.reservationId, confirmedZeroUsage: false, now }, db),
    (err) => err instanceof AllowanceInvalidTransitionError
  );

  const bal = await getAvailableAllowance(userId, { now }, db);
  assert.ok(bal.monthly.pendingMicros > 0, "Unconfirmed release attempt must NOT release budget hold");
});

test("Lifecycle (d): Late settlement after lease expiry records exactly one debit and no duplicate hold", async () => {
  const userId = "u_lifecycle_d";
  await createTestUser(userId, "plus");

  const now = new Date();
  const res = await reserveAllowance({
    userId,
    requestId: "req-d",
    idempotencyKey: `idem-d-${Date.now()}`,
    modelKey: "nova",
    now,
  }, db);
  await dispatchAllowance({ reservationId: res.reservationId, leaseDurationMs: 5000, now }, db);

  // 15 seconds later (lease expired)
  const late = new Date(now.getTime() + 15000);
  const settled = await settleAllowance({
    reservationId: res.reservationId,
    usage: { prompt_tokens: 300, completion_tokens: 200 },
    now: late,
  }, db);

  assert.equal(settled.status, ALLOWANCE_LIFECYCLE_STATES.SETTLED);
  assert.ok(settled.settledCostMicros > 0);

  const bal = await getAvailableAllowance(userId, { now: late }, db);
  assert.equal(bal.monthly.pendingMicros, 0, "No lingering pending hold after settlement");
  assert.equal(bal.monthly.confirmedMicros, settled.settledCostMicros, "Exactly one settled debit recorded");
});

test("Lifecycle (e): Duplicate cancellation, settlement, and reconciliation are idempotent", async () => {
  const userId = "u_lifecycle_e";
  await createTestUser(userId, "plus");

  const now = new Date();
  // 1. Duplicate release
  const res1 = await reserveAllowance({ userId, requestId: "req-e1", idempotencyKey: `idem-e1-${Date.now()}`, modelKey: "nova", now }, db);
  const rel1 = await releaseAllowance({ reservationId: res1.reservationId, confirmedZeroUsage: true, now }, db);
  const rel2 = await releaseAllowance({ reservationId: res1.reservationId, confirmedZeroUsage: true, now }, db);
  assert.equal(rel2.isIdempotent, true, "Duplicate release must be idempotent");

  // 2. Duplicate settlement
  const res2 = await reserveAllowance({ userId, requestId: "req-e2", idempotencyKey: `idem-e2-${Date.now()}`, modelKey: "nova", now }, db);
  await dispatchAllowance({ reservationId: res2.reservationId, now }, db);
  const set1 = await settleAllowance({ reservationId: res2.reservationId, usage: { prompt_tokens: 100, completion_tokens: 100 }, now }, db);
  const set2 = await settleAllowance({ reservationId: res2.reservationId, usage: { prompt_tokens: 100, completion_tokens: 100 }, now }, db);
  assert.equal(set2.isIdempotent, true, "Duplicate settlement must be idempotent");
  assert.equal(set1.settledCostMicros, set2.settledCostMicros);

  // 3. Duplicate reconciliation
  const rec1 = await reconcileAllowance({
    reservationId: res2.reservationId,
    userId,
    confirmedRawCostMicros: 500,
    confirmedCustomerDeductionMicros: 500,
    reason: "audit_adjustment",
    now,
  }, db);
  const rec2 = await reconcileAllowance({
    reservationId: res2.reservationId,
    userId,
    confirmedRawCostMicros: 500,
    confirmedCustomerDeductionMicros: 500,
    reason: "audit_adjustment",
    now,
  }, db);
  assert.equal(rec2.isIdempotent, true, "Duplicate reconciliation must be idempotent");
});

test("Lifecycle (f): Worker resumes after undispatched reservation expires: cannot dispatch", async () => {
  const userId = "u_lifecycle_f";
  await createTestUser(userId, "plus");

  const now = new Date();
  const res = await reserveAllowance({
    userId,
    requestId: "req-f",
    idempotencyKey: `idem-f-${Date.now()}`,
    modelKey: "nova",
    reservationTtlMs: 5000, // 5s TTL
    now,
  }, db);

  // Worker resumes 10s later (undispatched reservation has expired)
  const tenSecondsLater = new Date(now.getTime() + 10000);
  await assert.rejects(
    () => dispatchAllowance({ reservationId: res.reservationId, now: tenSecondsLater }, db),
    (err) => {
      assert.ok(err instanceof AllowanceInvalidTransitionError);
      assert.equal(err.code, "reservation_expired");
      return true;
    }
  );
});

test("Reservation Size: estimateTurnReservationHoldMicros covers long input and output ceilings", async () => {
  // Use seeded Nebula rates (speculative anthropic-claude-sonnet-5.5 is not in seed and
  // falls back to mu 0.5, which understates holds and skips real pricing).
  const holdModel = "nebula";
  const longInputHold = estimateTurnReservationHoldMicros(holdModel, 0, {
    estimatedInputTokens: 15000,
    maxOutputTokens: 1000,
  });
  assert.ok(longInputHold >= 45000, "Hold must scale with large serialized input context");

  const heavyOutputHold = estimateTurnReservationHoldMicros(holdModel, 0, {
    estimatedInputTokens: 500,
    maxOutputTokens: 4096,
  });
  assert.ok(heavyOutputHold >= 47000, "Hold must cover maximum requested output tokens");
});

test("Reservation Size: dynamic output token cap clamps ceiling near MTAB exhaustion", async () => {
  // User has only 5,000 micros left ($0.005)
  // Model rates: in = $2.00/M, out = $10.00/M
  // Input tokens = 500 (+ 512 buffer = 1012 tokens) -> input cost = ~2024 micros
  // Remaining for output = 5000 - 2024 = 2976 micros
  // Affordable output tokens = floor(2976 * 1M / 10M) = 297 tokens
  const cap = calculateDynamicOutputTokenCap({
    availableMicros: 5000,
    estimatedInputTokens: 500,
    rateIn: 2.00,
    rateOut: 10.00,
  });
  assert.ok(cap >= 256 && cap <= 300, `Cap must be clamped to affordable tokens: ${cap}`);

  // User has insufficient budget for input prompt + 256 token floor -> returns 0
  const zeroCap = calculateDynamicOutputTokenCap({
    availableMicros: 1000,
    estimatedInputTokens: 1000,
    rateIn: 2.00,
    rateOut: 10.00,
  });
  assert.equal(zeroCap, 0, "Returns 0 when minimum affordable floor cannot be met");
});
