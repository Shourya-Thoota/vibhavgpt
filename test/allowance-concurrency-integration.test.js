import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

const { drizzle } = await import("drizzle-orm/node-postgres");
const { eq } = await import("drizzle-orm");
const { shadowCostLedger, subscriptions, usageEvents } = await import("../src/db/schema.js");
const { reserveUsage, getModelMu } = await import("../src/usage/service.js");
const {
  reserveAllowance,
  settleAllowance,
  releaseAllowance,
  markDispatched,
  heartbeatReservation,
  sweepStaleReservations,
  getAvailableAllowance,
  ALLOWANCE_LIFECYCLE_STATES,
  AllowanceExceededError,
  AllowanceIdempotencyConflictError,
  AllowanceInvalidTransitionError,
} = await import("../src/usage/allowance-service.js");

const { Client, Pool } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function validateIsolatedTestDatabaseUrl(url) {
  const parsed = new URL(url);
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  const hasTestInDbName = parsed.pathname.toLowerCase().includes("test") || parsed.pathname.toLowerCase().includes("isolated");

  if (!isLoopback || !hasTestInDbName) {
    throw new Error(
      `Safety Guard Abort: TEST_DATABASE_URL must target a local/loopback isolated database containing 'test' or 'isolated' in the path. Target was: ${parsed.hostname} (${parsed.pathname})`
    );
  }
}

test("genuine multi-connection PostgreSQL concurrency races", async (t) => {
  // 1. Check if TEST_DATABASE_URL is provided
  if (!testDatabaseUrl) {
    if (process.env.CI) {
      throw new Error("CI Concurrency Race Failure: TEST_DATABASE_URL must be provided in CI environment to verify real PostgreSQL multi-connection races.");
    }
    t.skip(
      "Verification blocker note: TEST_DATABASE_URL is not set and no local PostgreSQL daemon is listening on port 5432. " +
      "Unit and simulated concurrency tests execute in test/allowance-service.test.js via PGlite WASM. " +
      "To execute live TCP multi-connection concurrency races over independent PostgreSQL sessions: " +
      "start local PostgreSQL (e.g. via Docker: docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16), " +
      "set TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/vibhavgpt_test, and run this test suite."
    );
    return;
  }

  // 2. Safety guard: Verify it is an isolated test database
  validateIsolatedTestDatabaseUrl(testDatabaseUrl);

  // 3. Connect pool to test database; MUST fail if unreachable when explicitly supplied
  const pool = new Pool({
    connectionString: testDatabaseUrl,
    max: 10,
    connectionTimeoutMillis: 3000,
  });

  try {
    const probe = await pool.query("SELECT 1 as alive");
    assert.equal(probe.rows[0].alive, 1);
  } catch (err) {
    await pool.end();
    throw new Error(`TEST_DATABASE_URL was explicitly supplied but database connection failed: ${err.message}`);
  }

  const sharedDb = drizzle(pool);

  // Apply migrations to test database idempotently
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(sharedDb, { migrationsFolder: "./drizzle" });

  await pool.query(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);

  // Create two distinct client connections for overlapping transaction concurrency
  const client1 = new Client({ connectionString: testDatabaseUrl });
  const client2 = new Client({ connectionString: testDatabaseUrl });
  await client1.connect();
  await client2.connect();

  const db1 = drizzle(client1);
  const db2 = drizzle(client2);

  const testUser1 = `u_tcp_race1_${Date.now()}`;
  const testUser2 = `u_tcp_race2_${Date.now()}`;
  const testUser3 = `u_tcp_race3_${Date.now()}`;
  const testUser4 = `u_tcp_race4_${Date.now()}`;
  const testUser5 = `u_tcp_race5_${Date.now()}`;
  const testUser6 = `u_tcp_race6_${Date.now()}`;
  const testUser7 = `u_tcp_race7_${Date.now()}`;
  const testUser8 = `u_tcp_race8_${Date.now()}`;
  const testUser9 = `u_tcp_race9_${Date.now()}`;
  const testUser10 = `u_tcp_race10_${Date.now()}`;
  const testUsers = [
    testUser1,
    testUser2,
    testUser3,
    testUser4,
    testUser5,
    testUser6,
    testUser7,
    testUser8,
    testUser9,
    testUser10,
  ];

  for (const u of testUsers) {
    await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING;`, [u, `${u}@example.com`]);
  }
  await sharedDb.insert(subscriptions).values({ userId: testUser1, tier: "plus", status: "active" });
  await sharedDb.insert(subscriptions).values({ userId: testUser2, tier: "pro", status: "active" });
  await sharedDb.insert(subscriptions).values({ userId: testUser3, tier: "pro", status: "active" });
  await sharedDb.insert(subscriptions).values({ userId: testUser4, tier: "pro", status: "active" });
  await sharedDb.insert(subscriptions).values({ userId: testUser5, tier: "pro", status: "active" });
  await sharedDb.insert(subscriptions).values({ userId: testUser6, tier: "pro", status: "active" });
  await sharedDb.insert(subscriptions).values({ userId: testUser7, tier: "plus", status: "active" });
  await sharedDb.insert(subscriptions).values({ userId: testUser8, tier: "plus", status: "active" });
  await sharedDb.insert(subscriptions).values({ userId: testUser9, tier: "plus", status: "active" });
  await sharedDb.insert(subscriptions).values({ userId: testUser10, tier: "plus", status: "active" });

  t.after(async () => {
    try {
      for (const u of testUsers) {
        await pool.query(`DELETE FROM shadow_cost_ledger WHERE user_id = $1;`, [u]);
        await pool.query(`DELETE FROM usage_events WHERE user_id = $1;`, [u]);
        await pool.query(`DELETE FROM subscriptions WHERE user_id = $1;`, [u]);
        await pool.query(`DELETE FROM "user" WHERE id = $1;`, [u]);
      }
    } finally {
      await client1.end().catch(() => {});
      await client2.end().catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  const now = new Date();

  // RACE 1: Competing reservations at the remaining balance (Independent Connections)
  // The plus plan allows 5,000,000 micros a cycle, so this leaves the 1,000 micros the race below is written for.
  await sharedDb.insert(shadowCostLedger).values({
    userId: testUser1,
    requestId: "req-tcp-preconsume",
    attemptNumber: 1,
    operation: "inference",
    modelKey: "nova",
    pricingVersionId: "pricing_snapshot_2026_10",
    pricingSource: "manual",
    reservedCostMicros: 0,
    settledCostMicros: 4_999_000,
    status: "settled",
    idempotencyKey: `tcp-preconsume-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
  });

  // Two independent connections simultaneously attempt to reserve 717 micros each
  const [race1A, race1B] = await Promise.allSettled([
    reserveAllowance({
      userId: testUser1,
      requestId: "req-race-1a",
      modelKey: "nova",
      estimatedInputTokens: 1000,
      maxOutputTokens: 1000,
      idempotencyKey: `tcp-key-1a-${Date.now()}`,
      now,
    }, db1),
    reserveAllowance({
      userId: testUser1,
      requestId: "req-race-1b",
      modelKey: "nova",
      estimatedInputTokens: 1000,
      maxOutputTokens: 1000,
      idempotencyKey: `tcp-key-1b-${Date.now()}`,
      now,
    }, db2),
  ]);

  // The design caps a reservation to what is still affordable (down to a 256-token minimum), so both can be admitted, each
  // for less: the invariant is that the admitted amounts never add up to more than the 1,000 micros left.
  assert.ok([race1A, race1B].every((r) => r.status === "fulfilled"), "both competing reservations are admitted, the second capped to what remains");
  const reserved1 = [race1A, race1B].map((r) => Number(r.value.reservedCostMicros));
  assert.ok(reserved1.reduce((sum, v) => sum + v, 0) <= 1000, `together they never exceed the 1,000 micros left: ${reserved1.join(" + ")}`);

  // RACE 2: Identical idempotency keys across separate connections
  const sharedKey = `shared-tcp-idem-${Date.now()}`;
  const [race2A, race2B] = await Promise.allSettled([
    reserveAllowance({
      userId: testUser2,
      requestId: "req-race-2a",
      modelKey: "nova",
      idempotencyKey: sharedKey,
      now,
    }, db1),
    reserveAllowance({
      userId: testUser2,
      requestId: "req-race-2a",
      modelKey: "nova",
      idempotencyKey: sharedKey,
      now,
    }, db2),
  ]);

  assert.equal(race2A.status, "fulfilled");
  assert.equal(race2B.status, "fulfilled");
  assert.equal(race2A.value.reservationId, race2B.value.reservationId);

  // RACE 3: Conflicting payloads with same key across separate connections
  const conflictKey = `conflict-tcp-idem-${Date.now()}`;
  const [race3A, race3B] = await Promise.allSettled([
    reserveAllowance({
      userId: testUser3,
      requestId: "req-race-3a",
      operation: "op_alpha",
      modelKey: "nova",
      idempotencyKey: conflictKey,
      now,
    }, db1),
    reserveAllowance({
      userId: testUser3,
      requestId: "req-race-3b",
      operation: "op_beta",
      modelKey: "nova",
      idempotencyKey: conflictKey,
      now,
    }, db2),
  ]);

  const win3 = [race3A, race3B].filter((r) => r.status === "fulfilled");
  const loss3 = [race3A, race3B].filter((r) => r.status === "rejected");
  assert.equal(win3.length, 1);
  assert.equal(loss3.length, 1);
  assert.ok(loss3[0].reason instanceof AllowanceIdempotencyConflictError);

  // RACE 4: Settlement versus Release across separate connections
  const srRes = await reserveAllowance({
    userId: testUser4,
    requestId: "req-sr-res",
    modelKey: "nova",
    idempotencyKey: `sr-key-${Date.now()}`,
    now,
  }, sharedDb);

  const [settleRes, releaseRes] = await Promise.allSettled([
    settleAllowance({
      reservationId: srRes.reservationId,
      usage: { prompt_tokens: 100, completion_tokens: 100 },
      now,
    }, db1),
    releaseAllowance({
      reservationId: srRes.reservationId,
      reason: "race_abort",
      now,
    }, db2),
  ]);

  const win4 = [settleRes, releaseRes].filter((r) => r.status === "fulfilled");
  const loss4 = [settleRes, releaseRes].filter((r) => r.status === "rejected");
  assert.equal(win4.length, 1);
  assert.equal(loss4.length, 1);
  assert.ok(loss4[0].reason instanceof AllowanceInvalidTransitionError);

  // RACE 5: Settlement versus Stale Sweep across separate connections
  const swRes = await reserveAllowance({
    userId: testUser5,
    requestId: "req-sw-res",
    modelKey: "nova",
    idempotencyKey: `sw-key-${Date.now()}`,
    now,
  }, sharedDb);
  await markDispatched({
    reservationId: swRes.reservationId,
    leaseDurationMs: 10,
    now: new Date(now.getTime() - 50000),
  }, sharedDb);

  const [settleSweep, sweepSweep] = await Promise.allSettled([
    settleAllowance({
      reservationId: swRes.reservationId,
      usage: { prompt_tokens: 150, completion_tokens: 150 },
      now,
    }, db1),
    sweepStaleReservations({
      leaseGracePeriodMs: 0,
      now,
    }, db2),
  ]);

  const [persistedRow5] = await sharedDb.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, swRes.reservationId));
  assert.ok(persistedRow5.status === "settled" || persistedRow5.status === "uncertain");

  // RACE 6: Heartbeat versus Stale Sweep across separate connections
  const hbRes = await reserveAllowance({
    userId: testUser6,
    requestId: "req-hb-res",
    modelKey: "nova",
    idempotencyKey: `hb-key-${Date.now()}`,
    now,
  }, sharedDb);
  await markDispatched({
    reservationId: hbRes.reservationId,
    leaseDurationMs: 10,
    now: new Date(now.getTime() - 50000),
  }, sharedDb);

  const [hbSweep, sweepHb] = await Promise.allSettled([
    heartbeatReservation({
      reservationId: hbRes.reservationId,
      leaseDurationMs: 60000,
      now,
    }, db1),
    sweepStaleReservations({
      leaseGracePeriodMs: 0,
      now,
    }, db2),
  ]);

  const [persistedRow6] = await sharedDb.select().from(shadowCostLedger).where(eq(shadowCostLedger.id, hbRes.reservationId));
  assert.ok(persistedRow6.status === "dispatched" || persistedRow6.status === "uncertain");

  // RACE 7: Competing image reservations for the last image slot (Independent Connections)
  // Plus tier allows 25 images per month. Pre-consume 24 settled images.
  for (let i = 0; i < 24; i++) {
    await sharedDb.insert(shadowCostLedger).values({
      userId: testUser7,
      requestId: `req-img-pre-${i}`,
      attemptNumber: 1,
      operation: "image_generation",
      modality: "image",
      modelKey: "flux-schnell",
      pricingVersionId: "pricing_snapshot_2026_10",
      pricingSource: "manual",
      reservedCostMicros: 0,
      settledCostMicros: 44_000,
      status: "settled",
      idempotencyKey: `img-pre-${i}-${Date.now()}`,
      createdAt: now,
      updatedAt: now,
    });
  }

  const [imgRaceA, imgRaceB] = await Promise.allSettled([
    reserveAllowance({
      userId: testUser7,
      requestId: "req-race-img-a",
      modality: "image",
      modelKey: "flux-schnell",
      idempotencyKey: `img-race-a-${Date.now()}`,
      now,
    }, db1),
    reserveAllowance({
      userId: testUser7,
      requestId: "req-race-img-b",
      modality: "image",
      modelKey: "flux-schnell",
      idempotencyKey: `img-race-b-${Date.now()}`,
      now,
    }, db2),
  ]);

  const imgWins = [imgRaceA, imgRaceB].filter((r) => r.status === "fulfilled");
  const imgLosses = [imgRaceA, imgRaceB].filter((r) => r.status === "rejected");
  assert.equal(imgWins.length, 1, "Exactly one concurrent image reservation must succeed on independent connections");
  assert.equal(imgLosses.length, 1, "Competing image reservation must be rejected");
  assert.ok(imgLosses[0].reason instanceof AllowanceExceededError);

  const bal7 = await getAvailableAllowance(testUser7, { now }, sharedDb);
  assert.equal(bal7.images.usedCount, 25, "Image count must equal 25");
  assert.equal(bal7.images.remainingCount, 0, "No remaining images");

  // RACE 8: Competing high-compute prompts for the last rolling-window throttle slot (Independent Connections)
  // Plus tier throttles at 40 high-compute prompts per rolling 5 hours. Pre-insert 39 high-compute events.
  // Use a real seed high-compute customer model (Nebula, mu > 1). Speculative aliases like
  // anthropic-claude-sonnet-5.5 are not in seed, resolve to mu 0.5, skip the throttle path, and
  // then fail checkUsageLimit — producing 0 wins instead of a real 1/1 throttle race.
  const highComputeModel = "nebula";
  assert.ok(getModelMu(highComputeModel) > 1.0, "Race 8 fixture must use a high-compute seed model");
  for (let i = 0; i < 39; i++) {
    await sharedDb.insert(usageEvents).values({
      userId: testUser8,
      model: highComputeModel,
      inputTokens: 100,
      outputTokens: 50,
      thinkingEffort: "none",
      createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000),
    });
  }

  const [rollingA, rollingB] = await Promise.allSettled([
    reserveUsage(testUser8, highComputeModel, "none", 1000, db1, now),
    reserveUsage(testUser8, highComputeModel, "none", 1000, db2, now),
  ]);

  const rollWins = [rollingA, rollingB].filter((r) => r.status === "fulfilled");
  const rollLosses = [rollingA, rollingB].filter((r) => r.status === "rejected");
  assert.equal(rollWins.length, 1, "Exactly one high-compute prompt must succeed before throttle");
  assert.equal(rollLosses.length, 1, "Competing high-compute prompt must be throttled");
  assert.equal(rollLosses[0].reason?.code, "plus_high_compute_throttled");

  // RACE 9: Cancellation/Release racing with a new reservation at budget boundary (Independent Connections)
  // User on Plus ($5.00 = 5,000,000 micros). Pre-consume 4,950,000 micros settled.
  await sharedDb.insert(shadowCostLedger).values({
    userId: testUser9,
    requestId: "req-race9-preconsume",
    attemptNumber: 1,
    operation: "inference",
    modelKey: "nova",
    pricingVersionId: "pricing_snapshot_2026_10",
    pricingSource: "manual",
    reservedCostMicros: 0,
    settledCostMicros: 4_950_000,
    status: "settled",
    idempotencyKey: `race9-preconsume-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
  });

  // Create an active reservation for remaining budget ($0.05 = 50,000 micros)
  const race9Hold = await reserveAllowance({
    userId: testUser9,
    requestId: "req-race9-hold",
    modelKey: "nova",
    estimatedInputTokens: 500,
    maxOutputTokens: 1000,
    idempotencyKey: `race9-hold-${Date.now()}`,
    now,
  }, sharedDb);

  // Connection 1 releases the hold; Connection 2 attempts a new reservation
  const [race9Release, race9Reserve] = await Promise.allSettled([
    releaseAllowance({
      reservationId: race9Hold.reservationId,
      reason: "client_abort",
      confirmedZeroUsage: true,
      now,
    }, db1),
    reserveAllowance({
      userId: testUser9,
      requestId: "req-race9-new",
      modelKey: "nova",
      estimatedInputTokens: 500,
      maxOutputTokens: 1000,
      idempotencyKey: `race9-new-${Date.now()}`,
      now,
    }, db2),
  ]);

  // Release must always succeed
  assert.equal(race9Release.status, "fulfilled");
  // The reserve either succeeds (if release locked first) or fails with AllowanceExceededError (if reserve locked first)
  if (race9Reserve.status === "rejected") {
    assert.ok(race9Reserve.reason instanceof AllowanceExceededError);
  }
  // The balance accounting must remain consistent and non-negative
  const bal9 = await getAvailableAllowance(testUser9, { now }, sharedDb);
  assert.ok(bal9.availableMicros >= 0);
  assert.ok(bal9.monthly.usedMicros <= bal9.monthly.limitMicros);

  // RACE 10: Uncertain-hold lifecycle across independent connections
  const race10Res = await reserveAllowance({
    userId: testUser10,
    requestId: "req-race10-hold",
    modelKey: "nova",
    estimatedInputTokens: 500,
    maxOutputTokens: 1000,
    idempotencyKey: `race10-hold-${Date.now()}`,
    now,
  }, db1);

  await markDispatched({
    reservationId: race10Res.reservationId,
    leaseDurationMs: 10,
    now: new Date(now.getTime() - 50000),
  }, db1);

  // Sweep into UNCERTAIN on db1
  await sweepStaleReservations({ leaseGracePeriodMs: 0, now }, db1);

  // db2 queries available allowance: uncertain hold must still reduce spendable capacity
  const bal10Before = await getAvailableAllowance(testUser10, { now }, db2);
  assert.ok(bal10Before.monthly.pendingMicros > 0, "Uncertain hold must retain pending hold across sessions");
  assert.equal(bal10Before.availableMicros, bal10Before.monthly.limitMicros - bal10Before.monthly.pendingMicros);

  // db1 settles the uncertain reservation
  await settleAllowance({
    reservationId: race10Res.reservationId,
    usage: { prompt_tokens: 200, completion_tokens: 150 },
    now,
  }, db1);

  // db2 re-queries: pending is cleared, exactly settled cost is recorded
  const bal10After = await getAvailableAllowance(testUser10, { now }, db2);
  assert.equal(bal10After.monthly.pendingMicros, 0, "Pending hold must be cleared after settlement");
  assert.ok(bal10After.monthly.confirmedMicros > 0, "Confirmed settled cost must be present");
});
