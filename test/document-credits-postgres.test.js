import test, { mock } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// The extra-document credit under real concurrency: independent PostgreSQL connections, the per-user advisory lock, and the ledger's
// unique keys. The PGlite suite (document-credits.test.js) proves the accounting; this proves it holds when requests truly overlap.
// It runs only against an isolated local test database (the same safety rules as allowance-concurrency-integration.test.js). test/setup-env.js
// deliberately points every test's DATABASE_URL at an unreachable placeholder, so the service is given the isolated pool explicitly below,
// and only after the loopback-and-name guard has passed. Without TEST_DATABASE_URL nothing is connected and the test skips.

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

const { drizzle } = await import("drizzle-orm/node-postgres");
const { migrate } = await import("drizzle-orm/node-postgres/migrator");
const { eq } = await import("drizzle-orm");
const { Pool } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function validateIsolatedTestDatabaseUrl(url) {
  const parsed = new URL(url);
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  const named = parsed.pathname.toLowerCase().includes("test") || parsed.pathname.toLowerCase().includes("isolated");
  if (!isLoopback || !named) throw new Error(`Safety Guard Abort: TEST_DATABASE_URL must be a local isolated database with 'test' or 'isolated' in its name. Target was ${parsed.hostname}${parsed.pathname}`);
}

// Real, independent connections (up to 10 at once) for the code under test, registered before the service is imported.
let pool = null;
if (testDatabaseUrl) {
  validateIsolatedTestDatabaseUrl(testDatabaseUrl);
  pool = new Pool({ connectionString: testDatabaseUrl, max: 10, connectionTimeoutMillis: 3000 });
  mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db: drizzle(pool), pool } });
}
const schema = await import("../src/db/schema.js");
const { reserveDocumentGeneration, cancelUsageReservation, getCreditBalance } = await import("../src/usage/service.js");

test("extra-document credits hold under real multi-connection concurrency", async (t) => {
  if (!testDatabaseUrl) {
    if (process.env.CI) throw new Error("CI Concurrency Race Failure: TEST_DATABASE_URL must be provided in CI to verify document-credit races on real PostgreSQL.");
    t.skip("TEST_DATABASE_URL is not set, so the live PostgreSQL races are skipped here. The same accounting runs on PGlite in test/document-credits.test.js.");
    return;
  }
  try { assert.equal((await pool.query("SELECT 1 AS alive")).rows[0].alive, 1); }
  catch (error) { await pool.end(); throw new Error(`TEST_DATABASE_URL was supplied but the database could not be reached: ${error.message}`); }
  const sharedDb = drizzle(pool);
  await migrate(sharedDb, { migrationsFolder: "./drizzle" });
  await pool.query(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);

  const stamp = Date.now();
  const users = [];
  async function addPlusUser(label, { credits, documentsUsed }) {
    const id = `u_doc_credit_${label}_${stamp}`;
    users.push(id);
    await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING;`, [id, `${id}@example.com`]);
    await sharedDb.insert(schema.subscriptions).values({ userId: id, tier: "plus", status: "active", currentPeriodStartedAt: new Date(Date.now() - 10 * 86_400_000), currentPeriodEndsAt: new Date(Date.now() + 20 * 86_400_000) });
    if (credits) await sharedDb.insert(schema.creditLedger).values({ userId: id, credits, kind: "stripe_purchase", externalReference: `stripe_checkout:cs_test_${id}` });
    for (let i = 0; i < documentsUsed; i += 1) await sharedDb.insert(schema.usageEvents).values({ userId: id, model: "__document__", createdAt: new Date() });
    return id;
  }
  const ledger = (userId) => sharedDb.select().from(schema.creditLedger).where(eq(schema.creditLedger.userId, userId));
  const attempt = (userId) => reserveDocumentGeneration(userId).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

  t.after(async () => {
    try {
      for (const id of users) {
        await pool.query(`DELETE FROM credit_ledger WHERE user_id = $1;`, [id]);
        await pool.query(`DELETE FROM usage_events WHERE user_id = $1;`, [id]);
        await pool.query(`DELETE FROM subscriptions WHERE user_id = $1;`, [id]);
        await pool.query(`DELETE FROM "user" WHERE id = $1;`, [id]);
      }
    } finally {
      await pool.end().catch(() => {});
    }
  });

  await t.test("twelve overlapping requests for three credits: exactly three are taken and the balance is 0", async () => {
    const userId = await addPlusUser("three", { credits: 3, documentsUsed: 20 });
    const results = await Promise.all(Array.from({ length: 12 }, () => attempt(userId)));
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.error.status === 402), "the rest are refused for credits");
    assert.equal(await getCreditBalance(userId), 0, "never below zero");
    assert.equal((await ledger(userId)).filter((row) => row.kind === "generation_reservation").length, 3);
  });

  await t.test("the last included document and extras overlapping: one free, then only as many as the credits allow", async () => {
    const userId = await addPlusUser("last", { credits: 2, documentsUsed: 19 });
    const results = await Promise.all(Array.from({ length: 9 }, () => attempt(userId)));
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.equal(results.filter((r) => r.ok && r.value.creditCost === 0).length, 1);
    assert.equal(await getCreditBalance(userId), 0);
  });

  await t.test("releasing the same reservation from several connections at once refunds it once", async () => {
    const userId = await addPlusUser("release", { credits: 3, documentsUsed: 20 });
    const reservation = await reserveDocumentGeneration(userId);
    assert.equal(await getCreditBalance(userId), 2);
    await Promise.all(Array.from({ length: 6 }, () => cancelUsageReservation(reservation.id, reservation.creditReservationId).catch(() => {})));
    assert.equal(await getCreditBalance(userId), 3, "3 bought, 1 reserved, 1 refunded: not more");
    assert.equal((await ledger(userId)).filter((row) => row.kind === "usage_refund").length, 1);
  });

  await t.test("reserving and releasing at the same time leaves a balance that matches what was kept", async () => {
    const userId = await addPlusUser("mixed", { credits: 2, documentsUsed: 20 });
    const first = await reserveDocumentGeneration(userId);
    const [released, ...others] = await Promise.all([
      cancelUsageReservation(first.id, first.creditReservationId).then(() => "released"),
      ...Array.from({ length: 6 }, () => attempt(userId)),
    ]);
    assert.equal(released, "released");
    const kept = 1 + others.filter((r) => r.ok).length - 1; // the first one was released
    assert.equal(await getCreditBalance(userId), 2 - kept, "the balance is exactly the credits not spent on kept documents");
    assert.ok((await getCreditBalance(userId)) >= 0);
  });

  await t.test("a second debit for the same document is refused by the database", async () => {
    const userId = await addPlusUser("unique", { credits: 3, documentsUsed: 20 });
    const reservation = await reserveDocumentGeneration(userId);
    await assert.rejects(sharedDb.insert(schema.creditLedger).values({ userId, credits: -1, kind: "generation_reservation", usageEventId: reservation.id, externalReference: `document-credit:${reservation.id}` }));
    assert.equal(await getCreditBalance(userId), 2);
  });
});
