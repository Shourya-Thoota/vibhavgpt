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
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (text, params) => client.query(text, params) } },
});

mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: { requireSession: (_req, _res, next) => next(), loadOptionalSession: (_req, _res, next) => next() },
});

const schema = await import("../src/db/schema.js");
const { config } = await import("../src/config.js");
const service = await import("../src/usage/service.js");
const {
  reserveUsage, finalizeUsage, cancelUsageReservation, createUsageTracker, estimateTurnReservationHoldMicros,
  getCreditsSummary, creditsPeriodFor, reserveImageGeneration, actualApiCostUsd,
} = service;
const { calculateUnifiedLedgerDeductionMicros } = await import("../src/models/pricing-engine.js");
const { chatAllowanceEnforcement } = await import("../src/usage/chat-allowance-policy.js");
const { requireAllowanceSummaryApiEnabled } = await import("../src/usage/allowance-router.js");
const { CREDIT_MICROS, allocationSchedule } = await import("../frontend/src/credits-policy.js");
const { resolveCreditsPolicy } = await import("../src/usage/credits.js");

const DAY = 86_400_000;
const NOW = new Date("2026-04-10T12:00:00.000Z"); // Free: April (30 days), in its second week (Apr 8 to Apr 15)
const at = (iso) => new Date(iso);

/** Runs `fn` with the credits policy set, then puts the settings back exactly as they were. */
const ACTIVATED = new Date("2026-04-01T00:00:00.000Z"); // the start of the fixture month, so there is no partial first week
async function withCredits({ enabled = true, mode = "expiry", activatedAt = ACTIVATED } = {}, fn) {
  const before = { enabled: config.creditsPolicyEnabled, mode: config.creditsCarryMode, at: config.creditsActivatedAt };
  config.creditsPolicyEnabled = enabled;
  config.creditsCarryMode = mode;
  config.creditsActivatedAt = activatedAt;
  try { return await fn(); } finally { config.creditsPolicyEnabled = before.enabled; config.creditsCarryMode = before.mode; config.creditsActivatedAt = before.at; }
}
const off = (fn) => withCredits({ enabled: false, mode: "", activatedAt: null }, fn);

let counter = 0;
async function user(tier = "free", subscription = {}) {
  const userId = `credits_user_${++counter}_${tier}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, `${userId}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  if (tier !== "free") {
    await db.insert(schema.subscriptions).values({
      userId, tier, status: "active",
      currentPeriodStartedAt: at("2026-03-15T13:45:00.000Z"),
      currentPeriodEndsAt: at("2026-05-15T13:45:00.000Z"),
      updatedAt: NOW,
      ...subscription,
    });
  }
  return userId;
}

/** The raw provider cost whose marked-up debit is the smallest one at or above `targetMicros`. */
function rawFor(targetMicros) {
  let raw = Math.max(0, Math.floor(targetMicros / 1.1) - 3);
  while (calculateUnifiedLedgerDeductionMicros(raw) < targetMicros) raw += 1;
  return { raw, debit: calculateUnifiedLedgerDeductionMicros(raw) };
}
async function settled(userId, { model = "lumen", target, createdAt }) {
  const { raw, debit } = rawFor(target);
  await db.insert(schema.usageEvents).values({ userId, model, costMicros: raw, inputTokens: 1000, outputTokens: 100, createdAt });
  return debit;
}
const reserve = (userId, model = "lumen", tokenBudget = 0, now = NOW, effort = "low") =>
  reserveUsage(userId, model, effort, tokenBudget, db, now, { enforceThrottles: true });
const eventCount = async (userId) => Number((await db.select({ n: sql`count(*)::int` }).from(schema.usageEvents).where(eq(schema.usageEvents.userId, userId)))[0].n);
const summary = (userId, now = NOW) => getCreditsSummary(userId, db, now);
const HOLD = estimateTurnReservationHoldMicros("lumen", 0);

test("fixture sanity: the admission hold and the debit helper behave as these tests assume", () => {
  assert.ok(HOLD > 0 && HOLD < 5_000, `a default hold is a small number of micros (${HOLD})`);
  assert.equal(rawFor(50_000).debit, 50_000, "exactly one credit is reachable");
  assert.equal(calculateUnifiedLedgerDeductionMicros(1_000_000), 1_100_000, "the markup is 10%");
});

// ---- Off by default; the old gates are intact ---------------------------------------

test("credits are off by default; every part of the activation is needed, and a future instant keeps the old gates", async () => {
  assert.equal(config.creditsPolicyEnabled, false, "the shipped default");
  assert.equal(config.creditsCarryMode, "");
  assert.equal(config.creditsActivatedAt, null, "no activation instant is set by default");
  assert.equal(await summary(await user("free")), null, "no credits object while inactive");
  await withCredits({ enabled: true, mode: "" }, async () => {
    assert.equal(await summary(await user("free")), null, "enabled without a choice stays inactive");
  });
  await withCredits({ enabled: true, mode: "sometimes" }, async () => {
    assert.equal(await summary(await user("free")), null, "an unrecognised mode is not a choice");
  });
  await withCredits({ enabled: false, mode: "expiry" }, async () => {
    assert.equal(await summary(await user("free")), null, "a mode without the enable flag is inactive");
  });
  await withCredits({ enabled: true, mode: "expiry", activatedAt: null }, async () => {
    assert.equal(await summary(await user("free")), null, "enabled with a mode but no activation instant is inactive");
  });
  await withCredits({ enabled: true, mode: "expiry", activatedAt: new Date("2026-05-01T00:00:00Z") }, async () => {
    assert.equal(await summary(await user("free")), null, "an activation instant in the future is not active yet");
  });
});

test("the policy turns on at the exact activation instant and not before, and says why it is off", () => {
  const settings = { creditsPolicyEnabled: true, creditsCarryMode: "carry", creditsActivatedAt: new Date("2026-04-10T12:00:00.000Z") };
  const before = resolveCreditsPolicy(settings, new Date("2026-04-10T11:59:59.999Z"));
  assert.equal(before.active, false);
  assert.equal(before.reason, "before_activation");
  assert.equal(before.carryMode, "carry", "the choice is known; only the time has not come");
  const exactly = resolveCreditsPolicy(settings, new Date("2026-04-10T12:00:00.000Z"));
  assert.equal(exactly.active, true, "active at the very instant");
  assert.equal(exactly.reason, "active");
  assert.equal(resolveCreditsPolicy({ ...settings, creditsActivatedAt: null }, NOW).reason, "activation_time_unset");
  assert.equal(resolveCreditsPolicy({ ...settings, creditsActivatedAt: new Date("garbage") }, NOW).reason, "activation_time_unset");
  assert.equal(resolveCreditsPolicy({ ...settings, creditsCarryMode: "" }, NOW).reason, "carry_mode_unselected");
  assert.equal(resolveCreditsPolicy({ ...settings, creditsPolicyEnabled: false }, NOW).reason, "disabled");
});

test("with credits off the existing gates still apply: Free 15 per 24 hours, Plus 40 per 5 hours, the monthly budget, Study token caps", async () => {
  await off(async () => {
    const free = await user("free");
    await db.insert(schema.usageEvents).values(Array.from({ length: 15 }, (_, i) => ({ userId: free, model: "lumen", costMicros: 100, createdAt: new Date(NOW.getTime() - 60_000 * (i + 1)) })));
    await assert.rejects(reserve(free), (error) => error.code === "free_daily_prompts_exceeded");

    const plus = await user("plus");
    await db.insert(schema.usageEvents).values(Array.from({ length: 40 }, (_, i) => ({ userId: plus, model: "nova", costMicros: 100, createdAt: new Date(NOW.getTime() - 60_000 * (i + 1)) })));
    await assert.rejects(reserve(plus, "nova"), (error) => error.code === "plus_high_compute_throttled");

    const budget = await user("plus");
    await settled(budget, { model: "nova", target: 3_000_000, createdAt: at("2026-04-02T00:00:00Z") });
    await assert.rejects(reserve(budget, "nova"), (error) => error.code === "allowance_exceeded");

    const study = await user("free");
    await db.insert(schema.usageEvents).values({ userId: study, model: "study", inputTokens: 600_000, costMicros: 10, createdAt: new Date(NOW.getTime() - 3 * DAY) });
    await assert.rejects(reserve(study, "study"), (error) => error.code === "usage-limit");
  });
});

// ---- Active: the superseded gates are gone ---------------------------------------------

test("active: the daily count, the 5-hour throttles and the per-model token caps no longer gate text usage", async () => {
  await withCredits({ mode: "expiry" }, async () => {
    // The same fixtures as above, now admitted: their spend is tiny, so credits allow them.
    const free = await user("free");
    await db.insert(schema.usageEvents).values(Array.from({ length: 15 }, (_, i) => ({ userId: free, model: "lumen", costMicros: 100, createdAt: new Date(NOW.getTime() - 60_000 * (i + 1)) })));
    assert.ok((await reserve(free)).id, "Free is no longer limited to 15 prompts in 24 hours");

    const plus = await user("plus");
    await db.insert(schema.usageEvents).values(Array.from({ length: 41 }, (_, i) => ({ userId: plus, model: "nova", costMicros: 100, createdAt: new Date(NOW.getTime() - 60_000 * (i + 1)) })));
    assert.ok((await reserve(plus, "nova")).id, "Plus has no 5-hour high-compute throttle");

    const pro = await user("pro");
    await db.insert(schema.usageEvents).values(Array.from({ length: 121 }, (_, i) => ({ userId: pro, model: "nova", costMicros: 100, createdAt: new Date(NOW.getTime() - 60_000 * (i + 1)) })));
    assert.ok((await reserve(pro, "nova")).id, "Pro has no 5-hour throttle");

    const max = await user("max");
    await db.insert(schema.usageEvents).values(Array.from({ length: 401 }, (_, i) => ({ userId: max, model: "vesper", costMicros: 10, createdAt: new Date(NOW.getTime() - 60_000 * (i + 1)) })));
    assert.ok((await reserve(max, "vesper")).id, "Max has no 5-hour Extra High throttle");

    const study = await user("free");
    await db.insert(schema.usageEvents).values({ userId: study, model: "study", inputTokens: 600_000, costMicros: 10, createdAt: new Date(NOW.getTime() - 3 * DAY) });
    assert.ok((await reserve(study, "study")).id, "Study has no per-model token cap; its tokens are not what limits it");
  });
});

test("active: plan access is untouched, so models a plan does not include are still refused", async () => {
  await withCredits({ mode: "carry" }, async () => {
    const free = await user("free");
    await assert.rejects(reserve(free, "nebula"), (error) => error.code === "free_restricted_to_green_dot" && error.status === 403, "Free cannot use Nebula");
    await assert.rejects(reserve(free, "vesper"), (error) => error.status === 403, "Free cannot use Vulcan");
    await assert.rejects(reserve(free, "nova", 0, NOW, "high"), (error) => error.reason === "plan", "Free cannot raise thinking effort");
    await assert.rejects(reserve(free, "mystery-model"), (error) => error.reason === "plan", "an unknown non-seed model needs a plan that includes it");
    const plus = await user("plus");
    await assert.rejects(reserve(plus, "vesper"), (error) => error.code === "plus_forbidden_extra_high", "Plus cannot use the Extra High tier");
    const pro = await user("pro");
    assert.ok((await reserve(pro, "vesper")).id, "Pro can");
    assert.ok((await reserve(free, "study")).id, "Free includes Study");
  });
});

// ---- The two carry policies, through admission -----------------------------------------

test("expiry and carry differ exactly where they should: what an unused week leaves behind", async () => {
  const userId = await user("free");
  // Find a request whose hold needs more than one week's credit but less than two.
  let tokenBudget = 1000;
  while (estimateTurnReservationHoldMicros("lumen", tokenBudget) <= 60_000) tokenBudget += 1000;
  const bigHold = estimateTurnReservationHoldMicros("lumen", tokenBudget);
  assert.ok(bigHold > CREDIT_MICROS && bigHold < 2 * CREDIT_MICROS, `fixture hold ${bigHold} sits between one and two credits`);

  await withCredits({ mode: "expiry" }, async () => {
    const view = await summary(userId);
    assert.equal(view.available.micros, CREDIT_MICROS, "expiry: just this week's 1 credit");
    await assert.rejects(reserve(userId, "lumen", tokenBudget), (error) => {
      assert.equal(error.code, "credits_request_exceeds_balance");
      assert.equal(error.requestTooLarge, true);
      assert.equal(error.window, "week");
      return true;
    });
    assert.equal(await eventCount(userId), 0, "a refusal leaves nothing behind");
  });
  await withCredits({ mode: "carry" }, async () => {
    const view = await summary(userId);
    assert.equal(view.available.micros, 2 * CREDIT_MICROS, "carry: weeks 1 and 2 are both spendable; week 3 is not available early");
    assert.equal(view.available.carriedInMicros, CREDIT_MICROS);
    assert.ok((await reserve(userId, "lumen", tokenBudget)).id, "the same request is admitted");
  });
});

test("week boundaries: the exact instant a week ends, its credits reset (expiry) or arrive (carry)", async () => {
  const userId = await user("free");
  await settled(userId, { target: CREDIT_MICROS, createdAt: at("2026-04-09T10:00:00Z") }); // all of week 2's single credit
  const justBefore = at("2026-04-14T23:59:59.999Z");
  const exactly = at("2026-04-15T00:00:00.000Z");

  await withCredits({ mode: "expiry" }, async () => {
    await assert.rejects(reserve(userId, "lumen", 0, justBefore), (error) => error.code === "credits_week_exhausted" && error.window === "week");
    const next = await reserve(userId, "lumen", 0, exactly);
    assert.ok(next.id, "week 3 opens with its own credit at the exact boundary");
    const view = await summary(userId, exactly);
    assert.equal(view.week.index, 2);
    assert.equal(view.week.startsAt, "2026-04-15T00:00:00.000Z");
  });
  const carryUser = await user("free");
  await settled(carryUser, { target: CREDIT_MICROS, createdAt: at("2026-04-09T10:00:00Z") });
  await withCredits({ mode: "carry" }, async () => {
    const view = await summary(carryUser, exactly);
    assert.equal(view.available.micros, 2 * CREDIT_MICROS, "three credits allocated by week 3, one spent");
  });
});

test("the refusal names what ran out, with the accurate time", async () => {
  await withCredits({ mode: "expiry" }, async () => {
    const week = await user("free");
    await settled(week, { target: CREDIT_MICROS, createdAt: at("2026-04-09T10:00:00Z") });
    await assert.rejects(reserve(week), (error) => {
      assert.equal(error.code, "credits_week_exhausted");
      assert.equal(error.status, 429);
      assert.equal(error.reason, "quota");
      assert.equal(error.feature, "AI credits");
      assert.equal(error.window, "week");
      assert.equal(error.resetAt, "2026-04-15T00:00:00.000Z", "this week's reset");
      assert.equal(error.detail.resetKind, "week-reset");
      assert.match(error.message, /this week's AI credits/i);
      assert.doesNotMatch(error.message, /token|5-hour|24-hour|rolling|\$0\.25/i);
      return true;
    });
  });
  await withCredits({ mode: "carry" }, async () => {
    const week = await user("free");
    await settled(week, { target: 2 * CREDIT_MICROS, createdAt: at("2026-04-09T10:00:00Z") });
    await assert.rejects(reserve(week), (error) => {
      assert.equal(error.code, "credits_week_exhausted");
      assert.equal(error.detail.resetKind, "next-allocation");
      assert.equal(error.resetAt, "2026-04-15T00:00:00.000Z");
      assert.match(error.message, /allocated so far this month/i);
      return true;
    });
  });
  await withCredits({ mode: "expiry" }, async () => {
    const month = await user("free");
    await settled(month, { target: 5 * CREDIT_MICROS, createdAt: at("2026-04-09T10:00:00Z") });
    const final = at("2026-04-30T12:00:00Z"); // the final partial window, Apr 29 to May 1
    await assert.rejects(reserve(month, "lumen", 0, final), (error) => {
      assert.equal(error.code, "credits_month_exhausted");
      assert.equal(error.window, "month");
      assert.equal(error.resetAt, "2026-05-01T00:00:00.000Z", "the monthly reset, not a weekly one");
      assert.equal(error.detail.resetKind, "monthly-reset");
      return true;
    });
    // Spending the whole month before the final window is a monthly exhaustion too.
    await assert.rejects(reserve(month), (error) => error.code === "credits_month_exhausted");
  });
});

// ---- Accounting ----------------------------------------------------------------------

test("the markup is applied once: a $1.00 provider cost is 22 credits, not 1.21 times that", async () => {
  await withCredits({ mode: "carry" }, async () => {
    const userId = await user("plus");
    await db.insert(schema.usageEvents).values({ userId, model: "nova", costMicros: 1_000_000, inputTokens: 1, outputTokens: 1, createdAt: at("2026-04-09T10:00:00Z") });
    const view = await summary(userId);
    assert.equal(view.monthly.consumedMicros, 1_100_000);
    assert.equal(view.monthly.consumedMicros / CREDIT_MICROS, 22);
    assert.equal(view.monthly.consumedMicros, calculateUnifiedLedgerDeductionMicros(1_000_000), "the ledger's own debit, unchanged");
  });
});

test("fractional spend is exact and a balance under one credit still admits requests", async () => {
  await withCredits({ mode: "expiry" }, async () => {
    const userId = await user("free");
    // 0.97 credits of the week's 1 credit, leaving 1,500 micros (0.03 credit).
    const debit = await settled(userId, { target: CREDIT_MICROS - 1_500, createdAt: at("2026-04-09T10:00:00Z") });
    const view = await summary(userId);
    assert.equal(view.available.micros, CREDIT_MICROS - debit);
    assert.ok(view.available.micros > 0 && view.available.micros < CREDIT_MICROS);
    assert.equal(view.exhausted, null, "a fraction of a credit is not exhausted");
    assert.ok((await reserve(userId)).id, "and it can still fund a small request");
    // The credit is never rounded up per call: two small calls cost their exact total.
    const first = await settled(await user("plus"), { target: 3_000, createdAt: at("2026-04-09T10:00:00Z") });
    assert.ok(first < CREDIT_MICROS / 10, "a call far below one credit is charged far below one credit");
  });
});

test("the sum of many calls is exact; each is its own debit and none is rounded to a whole credit", async () => {
  await withCredits({ mode: "carry" }, async () => {
    const userId = await user("plus");
    let expected = 0;
    for (let i = 0; i < 7; i += 1) expected += await settled(userId, { model: "nova", target: 4_000 + i * 123, createdAt: new Date(NOW.getTime() - (i + 1) * 3_600_000) });
    const view = await summary(userId);
    assert.equal(view.monthly.consumedMicros, expected);
    assert.notEqual(view.monthly.consumedMicros % CREDIT_MICROS, 0, "a total that is not a whole credit stays that way");
  });
});

test("an overlapping reservation, a repeated settlement and a released hold are each counted once", async () => {
  await withCredits({ mode: "carry" }, async () => {
    const userId = await user("plus");
    const baseline = (await summary(userId)).monthly.consumedMicros;
    const held = await reserve(userId, "nova");
    const holdOnly = (await summary(userId)).monthly.consumedMicros;
    assert.equal(holdOnly - baseline, estimateTurnReservationHoldMicros("nova", 1000), "an unsettled call counts its hold");

    const usage = { prompt_tokens: 2_000, completion_tokens: 400 };
    await finalizeUsage(held.id, usage, db, "nova");
    const once = (await summary(userId)).monthly.consumedMicros;
    const debit = calculateUnifiedLedgerDeductionMicros(Math.round(actualApiCostUsd("nova", usage) * 1_000_000));
    assert.equal(once - baseline, debit, "settled: the hold is replaced by the real debit");
    await finalizeUsage(held.id, usage, db, "nova"); // a duplicate settlement
    assert.equal((await summary(userId)).monthly.consumedMicros, once, "a duplicate settlement charges nothing more");
    assert.equal(await eventCount(userId), 1, "one row for one call");

    await cancelUsageReservation(held.id, null, db, { confirmedZeroUsage: true });
    assert.equal((await summary(userId)).monthly.consumedMicros, once, "a settled call is billable and a release does not undo it");
  });
});

test("a released hold frees its credits, and an unconfirmed one keeps them held", async () => {
  await withCredits({ mode: "expiry" }, async () => {
    const userId = await user("free");
    const before = (await summary(userId)).available.micros;
    const released = await reserve(userId);
    assert.ok((await summary(userId)).available.micros < before, "the hold takes credit while the call runs");
    await cancelUsageReservation(released.id, null, db, { confirmedZeroUsage: true });
    assert.equal((await summary(userId)).available.micros, before, "a confirmed-unused call gives it all back");

    const unconfirmed = await reserve(userId);
    await cancelUsageReservation(unconfirmed.id, null, db, { confirmedZeroUsage: false });
    assert.ok((await summary(userId)).available.micros < before, "dispatched with unknown usage: the hold stays");
  });
});

test("a multi-call turn charges each call once and the admission hold is released", async () => {
  await withCredits({ mode: "carry" }, async () => {
    const userId = await user("plus");
    const baseline = (await summary(userId)).monthly.consumedMicros;
    const admission = await reserve(userId, "nova");
    const tracker = createUsageTracker(userId, "nova", "low", db, { requestId: "req-multi" });
    const calls = [{ prompt_tokens: 1_200, completion_tokens: 300 }, { prompt_tokens: 1_800, completion_tokens: 120 }, { prompt_tokens: 2_400, completion_tokens: 600 }];
    let expected = 0;
    for (const usage of calls) {
      await tracker.beforeCall([{ role: "user", content: "hi" }], undefined, 500);
      await tracker.record(usage);
      expected += calculateUnifiedLedgerDeductionMicros(Math.round(actualApiCostUsd("nova", usage) * 1_000_000));
    }
    await cancelUsageReservation(admission.id, null, db, { confirmedZeroUsage: true });
    const view = await summary(userId);
    assert.equal(view.monthly.consumedMicros - baseline, expected, "three calls, three debits, nothing doubled and no leftover hold");
    assert.equal(await eventCount(userId), 3);
  });
});

test("concurrent requests cannot spend the same remaining credit", async () => {
  await withCredits({ mode: "expiry" }, async () => {
    const userId = await user("free");
    // Leave room for exactly one default hold in this week's single credit.
    const target = CREDIT_MICROS - HOLD - 10;
    const debit = await settled(userId, { target, createdAt: at("2026-04-09T10:00:00Z") });
    const headroom = CREDIT_MICROS - debit;
    assert.ok(headroom >= HOLD && headroom < 2 * HOLD, `fixture leaves room for exactly one hold (${headroom} vs ${HOLD})`);

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserve(userId)));
    const admitted = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    assert.equal(admitted.length, 1, "exactly one of six simultaneous requests is admitted");
    assert.equal(refused.length, 5);
    assert.ok(refused.every((result) => ["credits_week_exhausted", "credits_request_exceeds_balance"].includes(result.reason.code)));
    assert.equal(await eventCount(userId), 2, "the earlier spend plus the one new hold, nothing more");
  });
});

test("concurrency with room for several: exactly as many are admitted as fit", async () => {
  await withCredits({ mode: "carry" }, async () => {
    const userId = await user("free");
    // Carry on Apr 10 allows 2 credits; leave room for exactly three holds.
    const target = 2 * CREDIT_MICROS - 3 * HOLD - 40;
    const debit = await settled(userId, { target, createdAt: at("2026-04-09T10:00:00Z") });
    const room = Math.floor((2 * CREDIT_MICROS - debit) / HOLD);
    assert.ok(room >= 3, "fixture room");
    const results = await Promise.allSettled(Array.from({ length: room + 4 }, () => reserve(userId)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, room, "never more than the credits cover");
  });
});

// ---- What is and is not charged ---------------------------------------------------------

test("image, document and voice rows do not draw on AI credits, and their entitlements are unchanged", async () => {
  await withCredits({ mode: "carry" }, async () => {
    const userId = await user("plus");
    const baseline = (await summary(userId)).monthly.consumedMicros;
    await db.insert(schema.usageEvents).values([
      ...Array.from({ length: 30 }, () => ({ userId, model: "__image__", createdAt: at("2026-04-09T10:00:00Z") })),
      ...Array.from({ length: 10 }, () => ({ userId, model: "__document__", createdAt: at("2026-04-09T10:00:00Z") })),
      { userId, model: "__voice__", costMicros: 2_000_000, inputTokens: 5, outputTokens: 5, createdAt: at("2026-04-09T10:00:00Z") },
    ]);
    assert.equal((await summary(userId)).monthly.consumedMicros, baseline, "none of them is AI credit spend");

    // The count-based image entitlement still stops generation at its limit.
    const imaged = await user("plus", { currentPeriodStartedAt: new Date(Date.now() - 5 * DAY), currentPeriodEndsAt: new Date(Date.now() + 25 * DAY) });
    await db.insert(schema.usageEvents).values(Array.from({ length: 100 }, () => ({ userId: imaged, model: "__image__", createdAt: new Date(Date.now() - 3_600_000) })));
    await assert.rejects(reserveImageGeneration(imaged), (error) => error.code === "image_quota_exhausted");
  });
});

test("Flex Credits are a separate balance: they never fund text, and text never spends them", async () => {
  await withCredits({ mode: "expiry" }, async () => {
    const userId = await user("free");
    await db.insert(schema.creditLedger).values({ userId, credits: 500, kind: "stripe_purchase", externalReference: `test:${userId}` });
    await settled(userId, { target: CREDIT_MICROS, createdAt: at("2026-04-09T10:00:00Z") });
    const view = await summary(userId);
    assert.equal(view.purchased.balance, 500, "shown on its own");
    assert.equal(view.purchased.coversText, false);
    assert.equal(view.exhausted, "week");
    await assert.rejects(reserve(userId), (error) => error.code === "credits_week_exhausted", "500 Flex Credits do not unlock chat");
    assert.equal((await summary(userId)).purchased.balance, 500, "and the refusal did not touch them");
  });
});

// ---- Periods and activation ----------------------------------------------------------------

test("every plan uses the same UTC calendar month, whatever its billing dates", async () => {
  const period = creditsPeriodFor(NOW);
  assert.equal(period.basis, "utc-calendar-month");
  assert.equal(period.start.toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(creditsPeriodFor(NOW, "max", { currentPeriodStartedAt: at("2026-04-03T00:00:00Z") }).start.toISOString(), period.start.toISOString(), "only the clock matters: a plan or subscription argument cannot move it");

  await withCredits({ mode: "carry" }, async () => {
    const ids = [
      await user("free"),
      await user("plus"), // billed from the 15th
      await user("pro", { currentPeriodStartedAt: at("2026-02-27T08:00:00Z") }),
      await user("max", { currentPeriodStartedAt: at("2026-04-03T23:59:00Z") }), // billed from the 3rd
    ];
    const views = [];
    for (const id of ids) views.push(await summary(id));
    assert.deepEqual(views.map((view) => view.monthly.credits), [5, 60, 180, 800]);
    for (const view of views) {
      assert.equal(view.period.basis, "utc-calendar-month");
      assert.equal(view.period.startsAt, "2026-04-01T00:00:00.000Z");
      assert.equal(view.period.endsAt, "2026-05-01T00:00:00.000Z");
      assert.equal(view.week.startsAt, "2026-04-08T00:00:00.000Z", "the same fixed week for every plan");
      assert.equal(view.week.endsAt, "2026-04-15T00:00:00.000Z");
      assert.equal(view.resetsAt, "2026-05-01T00:00:00.000Z");
      assert.deepEqual(view.schedule.map((week) => week.startsAt), ["2026-04-01", "2026-04-08", "2026-04-15", "2026-04-22", "2026-04-29"].map((day) => `${day}T00:00:00.000Z`));
    }
  });
});

test("an annual subscriber receives one month of credits at a time, never a year at once", async () => {
  await withCredits({ mode: "carry" }, async () => {
    const annual = await user("plus", { currentPeriodStartedAt: at("2026-01-20T08:00:00Z"), currentPeriodEndsAt: at("2027-01-20T08:00:00Z") });
    const view = await summary(annual);
    assert.equal(view.monthly.credits, 60, "60 credits, not 720");
    assert.equal(view.period.startsAt, "2026-04-01T00:00:00.000Z", "the calendar month, not the billing term");
    assert.equal(view.period.endsAt, "2026-05-01T00:00:00.000Z");
    assert.equal(view.schedule.reduce((sum, week) => sum + week.credits, 0), 60);
    assert.ok(new Date(view.resetsAt) - NOW < 31 * DAY, "the next reset is within a month, inside a billing term of a year");
    // The same account a month later is on the next month with its own 60.
    const may = await summary(annual, at("2026-05-12T09:00:00Z"));
    assert.equal(may.monthly.credits, 60);
    assert.equal(may.period.startsAt, "2026-05-01T00:00:00.000Z");
    assert.equal(may.monthly.consumedMicros, 0, "no balance is carried into a new month");
  });
});

test("UTC calendar months are contiguous, half-open and 28 to 31 whole days, through a leap February", () => {
  let expectedStart = Date.UTC(2027, 11, 1);
  for (let month = 0; month < 15; month += 1) {
    const period = creditsPeriodFor(new Date(expectedStart + 13 * DAY));
    assert.equal(period.start.getTime(), expectedStart, `month ${month} starts where the last ended`);
    const days = (period.end - period.start) / DAY;
    assert.ok(Number.isInteger(days) && days >= 28 && days <= 31, `month ${month} is ${days} whole days`);
    assert.doesNotThrow(() => allocationSchedule({ periodStart: period.start, periodEnd: period.end, monthlyCredits: 60 }));
    assert.equal(creditsPeriodFor(new Date(period.end.getTime() - 1)).start.getTime(), period.start.getTime(), "1 ms before the end is still this month");
    assert.equal(creditsPeriodFor(period.end).start.getTime(), period.end.getTime(), "the end instant is the next month");
    if (period.start.toISOString().startsWith("2028-02")) assert.equal(days, 29, "February 2028 is a leap month");
    if (period.start.toISOString().startsWith("2029-02")) assert.equal(days, 28);
    expectedStart = period.end.getTime();
  }
});

test("activation starts a fresh credit period: spend before the instant is not counted, spend from it on is", async () => {
  const A = at("2026-04-10T12:00:00.000Z");
  await withCredits({ mode: "carry", activatedAt: A }, async () => {
    const userId = await user("plus");
    const day = at("2026-04-10T13:00:00.000Z");
    await settled(userId, { model: "nova", target: 10 * CREDIT_MICROS, createdAt: at("2026-04-02T09:00:00.000Z") }); // earlier this month
    await settled(userId, { model: "nova", target: 10 * CREDIT_MICROS, createdAt: at("2026-04-10T11:59:59.999Z") }); // 1 ms before activation
    assert.equal((await summary(userId, day)).monthly.consumedMicros, 0, "nothing before activation counts");
    const atInstant = await settled(userId, { model: "nova", target: 2 * CREDIT_MICROS, createdAt: A }); // exactly at activation
    const after = await settled(userId, { model: "nova", target: CREDIT_MICROS, createdAt: at("2026-04-10T12:00:00.001Z") });
    const view = await summary(userId, day);
    assert.equal(view.monthly.consumedMicros, atInstant + after, "the activation instant itself and later spend count, exactly once");
  });
});

test("mid-month activation: the first week is partial, the month's total is exact, and carry and expiry agree on day one", async () => {
  const A = at("2026-04-10T12:00:00.000Z");
  const day = at("2026-04-10T13:00:00.000Z");
  const Plus = await user("plus");
  for (const mode of ["expiry", "carry"]) {
    await withCredits({ mode, activatedAt: A }, async () => {
      const view = await summary(Plus, day);
      assert.equal(view.period.startsAt, "2026-04-10T12:00:00.000Z", "the credit period begins at activation");
      assert.equal(view.period.monthStartsAt, "2026-04-01T00:00:00.000Z");
      assert.deepEqual(view.period.activation, { at: "2026-04-10T12:00:00.000Z", foldedCredits: 14, firstWeekPartial: true });
      assert.deepEqual(view.schedule.map((week) => week.credits), [28, 14, 14, 4]);
      assert.equal(view.schedule.reduce((sum, week) => sum + week.credits, 0), 60, "exactly 60");
      assert.equal(view.week.startsAt, "2026-04-10T12:00:00.000Z");
      assert.equal(view.week.endsAt, "2026-04-15T00:00:00.000Z", "the week still ends on its fixed boundary");
      assert.equal(view.week.allocationCredits, 28);
      assert.equal(view.available.micros, 28 * CREDIT_MICROS, `${mode}: the folded first window is spendable at once`);
    });
  }
  // Free, and the three Plus-sized plans, keep exact totals too.
  await withCredits({ mode: "expiry", activatedAt: A }, async () => {
    for (const [tier, total] of [["free", 5], ["pro", 180], ["max", 800]]) {
      const view = await summary(await user(tier), day);
      assert.equal(view.schedule.reduce((sum, week) => sum + week.credits, 0), total, tier);
      assert.equal(view.monthly.credits, total);
    }
  });
});

test("activation exactly on a week boundary folds the elapsed week without a partial week; on the 1st it folds nothing", async () => {
  const userId = await user("plus");
  await withCredits({ mode: "expiry", activatedAt: at("2026-04-08T00:00:00.000Z") }, async () => {
    const view = await summary(userId, at("2026-04-08T09:00:00.000Z"));
    assert.deepEqual(view.period.activation, { at: "2026-04-08T00:00:00.000Z", foldedCredits: 14, firstWeekPartial: false });
    assert.deepEqual(view.schedule.map((week) => week.credits), [28, 14, 14, 4]);
  });
  await withCredits({ mode: "expiry", activatedAt: at("2026-04-01T00:00:00.000Z") }, async () => {
    const view = await summary(userId, at("2026-04-01T09:00:00.000Z"));
    assert.equal(view.period.activation, null, "the start of the month is not a mid-month activation");
    assert.deepEqual(view.schedule.map((week) => week.credits), [14, 14, 14, 14, 4]);
    assert.equal(view.period.startsAt, "2026-04-01T00:00:00.000Z");
  });
});

test("until the activation instant the existing gates apply; from it on a fresh period begins, even for a spent account", async () => {
  const A = at("2026-04-10T12:00:00.000Z");
  const spent = await user("plus");
  await settled(spent, { model: "nova", target: 3_000_000, createdAt: at("2026-04-02T09:00:00Z") }); // the whole monthly budget, before activation
  await withCredits({ mode: "expiry", activatedAt: A }, async () => {
    await assert.rejects(reserve(spent, "nova", 0, at("2026-04-10T11:59:59.999Z")), (error) => error.code === "allowance_exceeded", "1 ms before activation: the monthly budget still governs");
    const fresh = await reserve(spent, "nova", 0, A);
    assert.ok(fresh.id, "at the instant: a fresh period, so the earlier spend does not count");
    const view = await summary(spent, A);
    assert.equal(view.week.allocationCredits, 28);
    assert.ok(view.available.micros > 27 * CREDIT_MICROS, "the whole folded first week is available to a previously spent account");
  });
  const free = await user("free");
  await db.insert(schema.usageEvents).values(Array.from({ length: 15 }, (_, i) => ({ userId: free, model: "lumen", costMicros: 100, createdAt: new Date(A.getTime() - 60_000 * (i + 1)) })));
  await withCredits({ mode: "expiry", activatedAt: A }, async () => {
    await assert.rejects(reserve(free, "lumen", 0, new Date(A.getTime() - 1)), (error) => error.code === "free_daily_prompts_exceeded");
    assert.ok((await reserve(free, "lumen", 0, A)).id, "the daily count no longer applies from the instant");
  });
});

test("activation reads history but never rewrites it: no row is changed, moved, added or deleted by reading or switching", async () => {
  const userId = await user("plus");
  await settled(userId, { model: "nova", target: 800_000, createdAt: at("2026-03-20T10:00:00Z") });
  await settled(userId, { model: "nova", target: 900_000, createdAt: at("2026-04-02T10:00:00Z") });
  await settled(userId, { model: "nova", target: 700_000, createdAt: at("2026-04-11T10:00:00Z") });
  await client.query("INSERT INTO credit_ledger (user_id, credits, kind, external_reference) VALUES ($1, 40, 'stripe_purchase', $2)", [userId, `keep:${userId}`]);
  const snapshot = async () => JSON.stringify([
    (await client.query("SELECT id, user_id, model, cost_micros, input_tokens, output_tokens, created_at FROM usage_events WHERE user_id = $1 ORDER BY id", [userId])).rows,
    (await client.query("SELECT id, credits, kind FROM credit_ledger WHERE user_id = $1 ORDER BY id", [userId])).rows,
    (await client.query("SELECT tier, status FROM subscriptions WHERE user_id = $1", [userId])).rows,
  ]);
  const before = await snapshot();
  await withCredits({ mode: "carry", activatedAt: at("2026-04-10T12:00:00Z") }, async () => {
    const view = await summary(userId, at("2026-04-12T08:00:00Z"));
    assert.equal(view.monthly.consumedMicros, rawFor(700_000).debit, "only the spend after activation counts, once");
  });
  await withCredits({ mode: "expiry", activatedAt: at("2026-04-01T00:00:00Z") }, async () => { await summary(userId, at("2026-04-12T08:00:00Z")); });
  await off(async () => { await summary(userId, at("2026-04-12T08:00:00Z")); });
  assert.equal(await snapshot(), before, "usage rows, purchased credits and the subscription are byte-for-byte unchanged");
});


// ---- The other allowance systems and protections -------------------------------------------------

test("the dollar-based allowance gateway and its summary API step aside while credits are active", async () => {
  const gatewayOn = { featureChatAllowanceEnforcement: true, chatAllowanceActivatedAt: new Date("2026-01-01"), chatAllowanceEnforcedTiers: ["nova"] };
  const withCreditsOn = { ...gatewayOn, creditsPolicyEnabled: true, creditsCarryMode: "expiry", creditsActivatedAt: new Date("2026-01-01") };
  assert.deepEqual(chatAllowanceEnforcement({ modelKey: "nova", plan: "plus", now: NOW, settings: gatewayOn }), { enforced: true, reason: "enforced" }, "unchanged while credits are off");
  assert.deepEqual(chatAllowanceEnforcement({ modelKey: "nova", plan: "plus", now: NOW, settings: withCreditsOn }), { enforced: false, reason: "superseded_by_credits" });

  const respond = () => { const res = { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; return res; };
  const before = { flag: config.featureAllowanceSummaryApi };
  config.featureAllowanceSummaryApi = true;
  try {
    let nextCalled = false;
    requireAllowanceSummaryApiEnabled({}, respond(), () => { nextCalled = true; });
    assert.equal(nextCalled, true, "available while credits are off");
    await withCredits({ mode: "carry" }, async () => {
      const res = respond();
      requireAllowanceSummaryApiEnabled({}, res, () => { throw new Error("must not pass"); });
      assert.equal(res.code, 404);
      assert.equal(res.body.code, "superseded_by_credits");
    });
  } finally { config.featureAllowanceSummaryApi = before.flag; }
});

test("security rate limits are independent of credits and still in the server", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.equal((server.match(/rateLimit\(\{/g) ?? []).length >= 3, true, "the auth, OTP and password-reset limiters are defined");
  for (const name of ["authLimiter", "otpDeliveryLimiter", "passwordResetDeliveryLimiter"]) assert.match(server, new RegExp(`const ${name} = rateLimit`));
  const credits = await readFile(new URL("../src/usage/credits.js", import.meta.url), "utf8");
  assert.doesNotMatch(credits, /rate-?limit|authLimiter/i, "credits do not touch the limiters");
  const usageService = await readFile(new URL("../src/usage/service.js", import.meta.url), "utf8");
  const body = usageService.slice(usageService.indexOf("export async function reserveUsage"), usageService.indexOf("export async function finalizeUsage"));
  const lock = body.indexOf("pg_advisory_xact_lock(hashtext(${userId}))");
  const check = body.indexOf("evaluateCreditAdmission(");
  const insert = body.indexOf("tx.insert(usageEvents)");
  assert.ok(lock >= 0 && check > lock && insert > check, "the per-user lock, then the credits check, then the hold insert, in one transaction");
});

test("a refusal never leaks a provider name or raw upstream detail", async () => {
  await withCredits({ mode: "expiry" }, async () => {
    const userId = await user("free");
    await settled(userId, { target: CREDIT_MICROS, createdAt: at("2026-04-09T10:00:00Z") });
    await assert.rejects(reserve(userId), (error) => {
      const text = JSON.stringify({ message: error.message, access: { reason: error.reason, feature: error.feature, detail: error.detail } });
      assert.doesNotMatch(text, /openrouter|openai|anthropic|google|gemini|claude|gpt|groq|composio|stripe/i);
      return true;
    });
    const view = JSON.stringify(await summary(userId));
    assert.doesNotMatch(view, /openrouter|openai|anthropic|gemini|claude|groq|composio/i);
  });
});
