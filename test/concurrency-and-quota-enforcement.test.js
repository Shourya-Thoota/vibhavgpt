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

const schema = await import("../src/db/schema.js");
const {
  reserveUsage,
  reserveGeneration,
  reserveImageGeneration,
  finalizeUsage,
  cancelUsageReservation,
  countTierPromptsInWindow,
  getModelMu,
  estimateTurnReservationHoldMicros,
  FIVE_HOUR_WINDOW_MS,
  TWENTY_FOUR_HOUR_WINDOW_MS,
} = await import("../src/usage/service.js");
const { SUBSCRIPTION_PLAN_LIMITS } = await import("../src/models/pricing-engine.js");

const PERIOD_START = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);

async function createTestUser(userId, tier = "free") {
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, `${userId}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  if (tier !== "free") {
    await db.insert(schema.subscriptions).values({
      userId,
      tier,
      status: "active",
      currentPeriodStartedAt: PERIOD_START,
      currentPeriodEndsAt: PERIOD_END,
      updatedAt: new Date(),
    });
  }
}

test("Concurrency: Two simultaneous image requests with 1 remaining quota cannot both consume it", async () => {
  const userId = "user_concurrent_img";
  await createTestUser(userId, "plus");

  // Pre-populate Plus user with 99 images (quota is 100)
  for (let i = 0; i < 99; i++) {
    await db.insert(schema.usageEvents).values({
      userId,
      model: "__image__",
      createdAt: new Date(Date.now() - 1000 * 60 * (i + 1)),
    });
  }

  // Fire two simultaneous image generation reservations
  const results = await Promise.allSettled([
    reserveImageGeneration(userId),
    reserveImageGeneration(userId),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly ONE request must succeed");
  assert.equal(rejected.length, 1, "The second concurrent request must be rejected");
  assert.equal(rejected[0].reason?.code, "image_quota_exhausted");
  assert.equal(rejected[0].reason?.status, 429);

  // Total images in DB must be exactly 100
  const rows = await db.select({ count: sql`count(*)::int` })
    .from(schema.usageEvents)
    .where(sql`user_id = ${userId} AND model = '__image__'`);
  assert.equal(Number(rows[0].count), 100, "Images count must never exceed 100");
});

test("Concurrency: Free tier 15 prompts/24h cannot be bypassed with simultaneous requests", async () => {
  const userId = "user_concurrent_free";
  await createTestUser(userId, "free");

  // Pre-populate Free user with 14 prompts in the last 2 hours
  for (let i = 0; i < 14; i++) {
    await db.insert(schema.usageEvents).values({
      userId,
      model: "lumen",
      createdAt: new Date(Date.now() - 1000 * 60 * 5 * (i + 1)),
    });
  }

  // Fire two simultaneous chat reservations
  const results = await Promise.allSettled([
    reserveUsage(userId, "lumen", "low", 0, db),
    reserveUsage(userId, "lumen", "low", 0, db),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly ONE request must succeed for the 15th prompt");
  assert.equal(rejected.length, 1, "The second concurrent request must be rejected with 429");
  assert.equal(rejected[0].reason?.code, "free_daily_prompts_exceeded");
  assert.equal(rejected[0].reason?.status, 429);

  const rows = await db.select({ count: sql`count(*)::int` })
    .from(schema.usageEvents)
    .where(sql`user_id = ${userId} AND model = 'lumen'`);
  assert.equal(Number(rows[0].count), 15, "Total prompts must never exceed 15");
});

test("Concurrency: Plus tier 40 Yellow/Orange prompts/5h rolling throttle", async () => {
  const userId = "user_concurrent_plus_throttle";
  await createTestUser(userId, "plus");

  // Pre-populate 39 Yellow/Orange prompts in rolling 5h window (nova mu = 1.25)
  for (let i = 0; i < 39; i++) {
    await db.insert(schema.usageEvents).values({
      userId,
      model: "nova",
      createdAt: new Date(Date.now() - 1000 * 60 * 3 * (i + 1)),
    });
  }

  const results = await Promise.allSettled([
    reserveUsage(userId, "nova", "low", 0, db),
    reserveUsage(userId, "nova", "low", 0, db),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one succeeds to reach 40");
  assert.equal(rejected.length, 1, "Second request throttled with 429");
  assert.equal(rejected[0].reason?.code, "plus_high_compute_throttled");
  assert.equal(rejected[0].reason?.status, 429);
});

test("Concurrency: Pro tier 120 Yellow/Orange prompts/5h rolling throttle", async () => {
  const userId = "user_concurrent_pro_throttle";
  await createTestUser(userId, "pro");

  // Pre-populate 119 High compute prompts (nova mu = 1.25)
  for (let i = 0; i < 119; i++) {
    await db.insert(schema.usageEvents).values({
      userId,
      model: "nova",
      createdAt: new Date(Date.now() - 1000 * 60 * (i + 1)),
    });
  }

  const results = await Promise.allSettled([
    reserveUsage(userId, "nova", "low", 0, db),
    reserveUsage(userId, "nova", "low", 0, db),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "pro_high_compute_throttled");
  assert.equal(rejected[0].reason?.status, 429);
});

test("Concurrency: Max tier 400 Extra High Red prompts/5h rolling throttle", async () => {
  const userId = "user_concurrent_max_throttle";
  await createTestUser(userId, "max");

  // Extra High is mu > 7. Use seeded Vulcan (mu 12.375). Speculative vendor keys
  // like chatgpt-gpt-6-astra resolve to mu 0.5 and skip this throttle path.
  const extraHighModel = "vesper";
  assert.ok(getModelMu(extraHighModel) > 7.0, "fixture must be Extra High (mu > 7)");

  for (let i = 0; i < 399; i++) {
    await db.insert(schema.usageEvents).values({
      userId,
      model: extraHighModel,
      createdAt: new Date(Date.now() - 1000 * 10 * (i + 1)),
    });
  }

  const results = await Promise.allSettled([
    reserveUsage(userId, extraHighModel, "low", 0, db),
    reserveUsage(userId, extraHighModel, "low", 0, db),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "max_extra_high_throttled");
  assert.equal(rejected[0].reason?.status, 429);
});

test("Monthly MTAB budget exhaustion enforces hard limit", async () => {
  const userId = "user_mtab_exhausted";
  await createTestUser(userId, "plus");

  // Plus MTAB is $3.00 (3,000,000 micros)
  await db.insert(schema.usageEvents).values({
    userId,
    model: "nova",
    costMicros: 3_000_000,
    inputTokens: 10_000,
    outputTokens: 20_000,
    createdAt: new Date(Date.now() - 1000 * 60 * 60),
  });

  await assert.rejects(
    () => reserveUsage(userId, "nova", "low", 0, db),
    (err) => {
      assert.equal(err.code, "allowance_exceeded");
      assert.equal(err.status, 429);
      return true;
    }
  );
});

test("Failed requests release only capacity known to be unused", async () => {
  const userId = "user_failed_release";
  await createTestUser(userId, "free");

  // Reserve a usage event
  const reservation = await reserveUsage(userId, "lumen", "low", 0, db);
  assert.ok(reservation.id);

  // Count prompts - should be 1
  let countRow = await db.select({ count: sql`count(*)::int` })
    .from(schema.usageEvents)
    .where(sql`user_id = ${userId}`);
  assert.equal(Number(countRow[0].count), 1);

  // Failed before any tokens used -> cancel with confirmedZeroUsage releases reservation completely
  await cancelUsageReservation(reservation.id, null, db, { confirmedZeroUsage: true });

  countRow = await db.select({ count: sql`count(*)::int` })
    .from(schema.usageEvents)
    .where(sql`user_id = ${userId}`);
  assert.equal(Number(countRow[0].count), 0, "Capacity must be fully released on confirmed unused failure");

  // Dispatched or unverified usage: cancel without confirmedZeroUsage retains the hold
  const resDispatched = await reserveUsage(userId, "lumen", "low", 0, db);
  await cancelUsageReservation(resDispatched.id, null, db, { confirmedZeroUsage: false });
  const rowRetained = await db.select({ count: sql`count(*)::int` })
    .from(schema.usageEvents)
    .where(sql`id = ${resDispatched.id}`);
  assert.equal(Number(rowRetained[0].count), 1, "Dispatched request with unverified upstream usage retains hold");

  // Now simulate an event that settled tokens
  const res2 = await reserveUsage(userId, "lumen", "low", 0, db);
  await finalizeUsage(res2.id, { prompt_tokens: 50, completion_tokens: 100 }, db, "lumen");

  // Calling cancelUsageReservation on settled usage does NOT delete it even if confirmedZeroUsage is passed
  await cancelUsageReservation(res2.id, null, db, { confirmedZeroUsage: true });

  const res2Row = await db.select({ count: sql`count(*)::int` })
    .from(schema.usageEvents)
    .where(sql`id = ${res2.id}`);
  assert.equal(Number(res2Row[0].count), 1, "Settled inference cannot be refunded");

  countRow = await db.select({ count: sql`count(*)::int` })
    .from(schema.usageEvents)
    .where(sql`user_id = ${userId}`);
  assert.equal(Number(countRow[0].count), 2, "Both retained unconfirmed hold and settled event remain persisted");
});

test("Rolling window boundaries: requests outside rolling/daily window roll off cleanly", async () => {
  const userId = "user_rolling_boundaries";
  await createTestUser(userId, "free");

  // Insert 15 prompts 25 hours ago (outside 24h window)
  for (let i = 0; i < 15; i++) {
    await db.insert(schema.usageEvents).values({
      userId,
      model: "lumen",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000 - (i * 1000)),
    });
  }

  // Active count in 24h window must be 0
  const twentyFourHoursAgo = new Date(Date.now() - TWENTY_FOUR_HOUR_WINDOW_MS);
  const { totalPrompts } = await countTierPromptsInWindow(userId, twentyFourHoursAgo, db);
  assert.equal(totalPrompts, 0, "Prompts outside 24h window must not count");

  // New reservation should succeed cleanly
  const res = await reserveUsage(userId, "lumen", "low", 0, db);
  assert.ok(res.id);
});

test("Budget Accounting: Marked-up debit reduces correct MTAB balance and prevents wholesale discounting", async () => {
  const userId = "user_mtab_markup_eval";
  await createTestUser(userId, "plus");

  // Plus MTAB is $3.00 (3,000,000 micros).
  // Insert settled wholesale usage of $2.71 (2,710,000 micros).
  // Under 1.10 customer markup: 2,710,000 * 1.10 = 2,981,000 micros debit.
  // Remaining MTAB is 19,000 micros ($0.019).
  // (If raw wholesale cost were checked without markup, remaining would falsely appear as 290,000 micros).
  await db.insert(schema.usageEvents).values({
    userId,
    model: "nova",
    costMicros: 2_710_000,
    inputTokens: 50_000,
    outputTokens: 50_000,
    createdAt: new Date(Date.now() - 1000 * 60 * 10),
  });

  // Seeded Nebula default hold is 12,100 micros (same envelope the old speculative
  // anthropic-claude-sonnet-5.5 fixture assumed, without depending on a non-seed alias).
  const holdModel = "nebula";
  assert.equal(estimateTurnReservationHoldMicros(holdModel, 0), 12100);
  // 2,981,000 + 12,100 = 2,993,100 <= 3,000,000 -> Should SUCCEED
  const res1 = await reserveUsage(userId, holdModel, "low", 0, db);
  assert.ok(res1.id, "Reservation fitting within remaining 19,000 MTAB must succeed");

  // In-flight hold (12,100) + committed (2,981,000) + incoming hold (12,100) = 3,005,200 > 3,000,000 -> Must FAIL
  await assert.rejects(
    () => reserveUsage(userId, holdModel, "low", 0, db),
    (err) => {
      assert.equal(err.code, "allowance_exceeded");
      assert.equal(err.status, 429);
      return true;
    }
  );
});

test("Concurrency: Two simultaneous requests cannot reserve the same remaining MTAB budget", async () => {
  const userId = "user_mtab_concurrent_race";
  await createTestUser(userId, "plus");

  // Pre-populate with 2,990,000 micros marked-up debit (costMicros = 2,718,182).
  // Remaining MTAB = 10,000 micros.
  // Seeded Nova with 2000 output-token budget holds 9,350 micros — only ONE fits.
  await db.insert(schema.usageEvents).values({
    userId,
    model: "nova",
    costMicros: 2_718_182, // ceil(2,718,182 * 1.10) = 2,990,001
    inputTokens: 20_000,
    outputTokens: 40_000,
    createdAt: new Date(Date.now() - 1000 * 60 * 5),
  });

  const raceModel = "nova";
  const raceBudget = 2000;
  assert.equal(estimateTurnReservationHoldMicros(raceModel, raceBudget), 9350);
  const results = await Promise.allSettled([
    reserveUsage(userId, raceModel, "low", raceBudget, db),
    reserveUsage(userId, raceModel, "low", raceBudget, db),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly ONE request may reserve the remaining MTAB slot");
  assert.equal(rejected.length, 1, "The concurrent second request must be rejected with 429 allowance_exceeded");
  assert.equal(rejected[0].reason?.code, "allowance_exceeded");
  assert.equal(rejected[0].reason?.status, 429);
});

test("Budget Reconciliation: Final settlement reconciles the hold without double charging", async () => {
  const userId = "user_reconcile_no_double_charge";
  await createTestUser(userId, "plus");

  // Seeded Nebula: MODEL_TOKEN_PRICES input $0.75/M, output $3.75/M (or seed raw rates).
  const settleModel = "nebula";
  const res = await reserveUsage(userId, settleModel, "low", 0, db);
  assert.ok(res.id);

  await finalizeUsage(res.id, { prompt_tokens: 200, completion_tokens: 100 }, db, settleModel);

  const [row] = await db.select().from(schema.usageEvents).where(eq(schema.usageEvents.id, res.id));
  assert.equal(row.reservedTokens, 0, "reservedTokens must be reset to 0 upon settlement");
  assert.equal(row.reservationExpiresAt, null, "reservationExpiresAt must be cleared upon settlement");
  assert.ok(row.costMicros > 0, "costMicros must record raw wholesale cost");

  // Second prompt must reserve cleanly without double-counting the settled hold.
  const res2 = await reserveUsage(userId, "nova", "low", 0, db);
  assert.ok(res2.id, "Second prompt reserves cleanly without double count of settled hold");
});


