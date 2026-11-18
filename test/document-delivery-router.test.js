import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// A document that was generated successfully but could not be delivered (saving the exchange or storing the file failed afterwards).
// This is the real generation router and the real generateDocument over HTTP against an isolated database. Only the model call and the
// file store are replaced, because those are the two things that cannot run here: a provider, and a disk that fails on demand. The
// earlier proof of this case was a helper test and a check that the call sites mention the helper; this one exercises the route.

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
process.env.UPLOAD_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "doc-delivery-"));

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db, pool: { query: (text, params) => client.query(text, params) } } });
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

// The model call: a fixed plan, no provider.
const planHref = new URL("../src/generation/document-plan.js", import.meta.url).href;
const realPlan = await import(planHref);
mock.module(planHref, {
  namedExports: {
    ...realPlan,
    buildDocumentPlan: async () => ({
      plan: { title: "Quarterly roadmap", sections: [{ heading: "Goals", body: "Ship the redesign and measure what changed after it ships." }, { heading: "Risks", body: "Provider limits and review time." }] },
      usage: { prompt_tokens: 20, completion_tokens: 30 },
    }),
  },
});

// The file store: the real one, except that it fails when told to.
const serviceHref = new URL("../src/generation/service.js", import.meta.url).href;
const realService = await import(serviceHref);
const storage = { fail: false, calls: 0 };
mock.module(serviceHref, {
  namedExports: {
    ...realService,
    createStoredAttachment: async (...args) => {
      storage.calls += 1;
      if (storage.fail) throw new Error("disk full");
      return realService.createStoredAttachment(...args);
    },
  },
});

const schema = await import("../src/db/schema.js");
const { default: express } = await import("express");
const { generationRouter } = await import("../src/generation/router.js");
const { getCreditBalance } = await import("../src/usage/service.js");
const { eq, and } = await import("drizzle-orm");
test.after(async () => { await client.close(); });

let counter = 0;
async function addUser(tier = "plus", { credits = 0, documentsUsed = 0 } = {}) {
  const id = `${tier}-delivery-${++counter}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
  await db.insert(schema.subscriptions).values({ userId: id, tier, status: "active", currentPeriodStartedAt: new Date(Date.now() - 10 * 86_400_000), currentPeriodEndsAt: new Date(Date.now() + 20 * 86_400_000) });
  if (credits) await db.insert(schema.creditLedger).values({ userId: id, credits, kind: "stripe_purchase", externalReference: `stripe_checkout:cs_test_${id}` });
  for (let i = 0; i < documentsUsed; i += 1) await db.insert(schema.usageEvents).values({ userId: id, model: "__document__", createdAt: new Date() });
  return id;
}
const ledger = (userId) => db.select().from(schema.creditLedger).where(eq(schema.creditLedger.userId, userId));
const kinds = async (userId) => (await ledger(userId)).map((row) => row.kind).sort();

async function serve(t, userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/generation", generationRouter);
  app.use((error, _req, res, _next) => res.status(error?.status ?? 500).json({ error: String(error?.message ?? error) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (body = { prompt: "Write a quarterly roadmap", format: "md" }) => fetch(`${base}/api/generation/document`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("an extra document that cannot be stored is refunded once, and the same request succeeds and is charged once when storage works", async (t) => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 20 });
  const post = await serve(t, userId);

  storage.fail = true;
  const failed = await post();
  assert.equal(failed.status, 500, "the user is told it failed");
  assert.equal(storage.calls > 0, true, "generation succeeded and delivery was attempted");
  assert.equal(await getCreditBalance(userId), 3, "the credit is back");
  assert.deepEqual(await kinds(userId), ["generation_reservation", "stripe_purchase", "usage_refund"], "one debit, one refund");

  storage.fail = false;
  const delivered = await post();
  assert.equal(delivered.status, 201);
  assert.equal(await getCreditBalance(userId), 2, "the delivered document costs exactly one credit");
  assert.deepEqual(await kinds(userId), ["generation_reservation", "generation_reservation", "stripe_purchase", "usage_refund"], "the first attempt stays refunded; only the second is a charge");
});

test("several failing requests at once are each refunded once and the balance never goes below what was bought", async (t) => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 20 });
  const post = await serve(t, userId);
  storage.fail = true;
  const responses = await Promise.all(Array.from({ length: 6 }, () => post()));
  const statuses = responses.map((response) => response.status).sort();
  assert.ok(statuses.every((status) => status === 500 || status === 402), `each is a failure or a refusal for credits, not a success: ${statuses}`);
  assert.equal(await getCreditBalance(userId), 3, "every taken credit was returned");
  const rows = await ledger(userId);
  const reservations = rows.filter((row) => row.kind === "generation_reservation").length;
  const refunds = rows.filter((row) => row.kind === "usage_refund").length;
  assert.equal(refunds, reservations, "one refund for every debit, never two");
  assert.ok(reservations >= 1 && reservations <= 6);
});

test("a delivered extra document is charged once and never refunded", async (t) => {
  const userId = await addUser("plus", { credits: 2, documentsUsed: 20 });
  const post = await serve(t, userId);
  storage.fail = false;
  const response = await post();
  assert.equal(response.status, 201);
  assert.equal(await getCreditBalance(userId), 1);
  assert.equal((await kinds(userId)).filter((kind) => kind === "usage_refund").length, 0);
});

test("an included document that cannot be stored touches no credit", async (t) => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 5 });
  const post = await serve(t, userId);
  storage.fail = true;
  assert.equal((await post()).status, 500);
  assert.equal(await getCreditBalance(userId), 3);
  assert.deepEqual(await kinds(userId), ["stripe_purchase"], "no debit and no refund");
});

test("an unlimited plan that cannot store a document touches no credit, with or without a balance", async (t) => {
  for (const tier of ["pro", "max"]) {
    const userId = await addUser(tier, { credits: 4, documentsUsed: 60 });
    const post = await serve(t, userId);
    storage.fail = true;
    assert.equal((await post()).status, 500);
    assert.equal(await getCreditBalance(userId), 4, `${tier}: the old balance is untouched`);
    assert.deepEqual(await kinds(userId), ["stripe_purchase"]);
  }
});

test("with no credits left, an extra document is refused before anything is generated or stored", async (t) => {
  const userId = await addUser("plus", { credits: 0, documentsUsed: 20 });
  const post = await serve(t, userId);
  storage.fail = false;
  const before = storage.calls;
  const response = await post();
  assert.equal(response.status, 402);
  assert.equal(storage.calls, before, "nothing was stored");
  assert.equal((await ledger(userId)).length, 0);
  const rows = await db.select().from(schema.usageEvents).where(and(eq(schema.usageEvents.userId, userId), eq(schema.usageEvents.model, "__document__")));
  assert.equal(rows.length, 20, "and no document row was added");
});
