import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Extra Plus documents: after the 20 included a month, each successful document costs 1 purchased credit. The reservation is a ledger
// debit written under the per-user lock together with the usage row, a failure releases it, and none of it touches the included
// allowance, unlimited plans, other users, purchase history or any earlier balance. PGlite and a stub model only: no provider, no
// payment, no real account.

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
process.env.UPLOAD_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "doc-credits-"));

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db, pool: { query: (text, params) => client.query(text, params) } } });

const schema = await import("../src/db/schema.js");
const { generateDocument, releaseDocumentCharge } = await import("../src/generation/service.js");
const { reserveDocumentGeneration, cancelUsageReservation, getCreditBalance, getCurrentUsage, GENERATION_LIMITS } = await import("../src/usage/service.js");
const { eq, and } = await import("drizzle-orm");
test.after(async () => { await client.close(); });

let counter = 0;
async function addUser(tier = "plus", { credits = 0, documentsUsed = 0 } = {}) {
  const id = `${tier}-doc-${++counter}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
  if (tier !== "free") {
    await db.insert(schema.subscriptions).values({ userId: id, tier, status: "active", currentPeriodStartedAt: new Date(Date.now() - 10 * 86_400_000), currentPeriodEndsAt: new Date(Date.now() + 20 * 86_400_000) });
  }
  if (credits) await db.insert(schema.creditLedger).values({ userId: id, credits, kind: "stripe_purchase", externalReference: `stripe_checkout:cs_test_${id}` });
  for (let i = 0; i < documentsUsed; i += 1) await db.insert(schema.usageEvents).values({ userId: id, model: "__document__", createdAt: new Date() });
  return id;
}
const ledger = (userId) => db.select().from(schema.creditLedger).where(eq(schema.creditLedger.userId, userId));
const documentRows = async (userId) => (await db.select().from(schema.usageEvents).where(and(eq(schema.usageEvents.userId, userId), eq(schema.usageEvents.model, "__document__")))).length;
const attempt = (userId) => reserveDocumentGeneration(userId).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const plan = { plan: { title: "T", sections: [{ heading: "H", body: "B" }] }, usage: { prompt_tokens: 5, completion_tokens: 5 } };
const stubs = { buildPlan: async () => plan, render: async () => ({ buffer: Buffer.from("x"), extension: ".md", mimeType: "text/markdown" }) };

test("the limits this relies on: Plus 20 a month, Pro and Max unlimited, Free none", () => {
  assert.equal(GENERATION_LIMITS.plus.documents, 20);
  assert.equal(GENERATION_LIMITS.pro.documents, Infinity);
  assert.equal(GENERATION_LIMITS.max.documents, Infinity);
  assert.equal(GENERATION_LIMITS.free.documents, 0);
});

// ---- The bug: an extra document must cost 1 credit ---------------------------------------------------------------------------------

test("REGRESSION: the 21st Plus document in a month takes 1 purchased credit, not nothing", async () => {
  const userId = await addUser("plus", { credits: 5, documentsUsed: 20 });
  const reservation = await reserveDocumentGeneration(userId);
  assert.equal(reservation.creditCost, 1);
  assert.ok(reservation.creditReservationId, "a reservation row is returned, so a failure can release it");
  assert.equal(await getCreditBalance(userId), 4, "5 credits bought, 1 reserved");
  const debit = (await ledger(userId)).find((row) => row.kind === "generation_reservation");
  assert.equal(debit.credits, -1);
  assert.equal(debit.usageEventId, reservation.id, "tied to the document it pays for");
  assert.equal((await getCurrentUsage(userId)).creditBalance, 4, "Usage shows the lower balance");
});

test("a successful extra document keeps its debit, once", async () => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 20 });
  const result = await generateDocument({ userId, format: "md", prompt: "p" }, stubs);
  assert.equal(result.reservation.creditCost, 1);
  assert.equal(await getCreditBalance(userId), 2);
  assert.equal((await ledger(userId)).filter((row) => row.kind === "usage_refund").length, 0, "nothing was refunded");
});

test("the 20th included document uses no credit; the 21st does", async () => {
  const userId = await addUser("plus", { credits: 2, documentsUsed: 19 });
  const twentieth = await reserveDocumentGeneration(userId);
  assert.equal(twentieth.creditCost, 0);
  assert.equal(twentieth.creditReservationId, null);
  assert.equal(await getCreditBalance(userId), 2, "an included document does not touch purchased credits");
  const twentyFirst = await reserveDocumentGeneration(userId);
  assert.equal(twentyFirst.creditCost, 1);
  assert.equal(await getCreditBalance(userId), 1);
  assert.equal(await documentRows(userId), 21);
});

test("included documents never debit, whatever the balance", async () => {
  const none = await addUser("plus", { credits: 0, documentsUsed: 3 });
  assert.equal((await reserveDocumentGeneration(none)).creditCost, 0, "no credits needed while documents remain");
  const some = await addUser("plus", { credits: 7, documentsUsed: 0 });
  await generateDocument({ userId: some, format: "md", prompt: "p" }, stubs);
  assert.equal(await getCreditBalance(some), 7);
  assert.equal((await ledger(some)).filter((row) => row.kind !== "stripe_purchase").length, 0, "no ledger row at all");
});

test("Pro and Max are unlimited and unchanged: no debit, with or without credits", async () => {
  for (const tier of ["pro", "max"]) {
    const empty = await addUser(tier, { credits: 0, documentsUsed: 60 });
    const reservation = await reserveDocumentGeneration(empty);
    assert.equal(reservation.creditCost, 0, `${tier}: past any number, still free`);
    assert.equal(reservation.creditReservationId, null);
    const funded = await addUser(tier, { credits: 9, documentsUsed: 60 });
    await reserveDocumentGeneration(funded);
    assert.equal(await getCreditBalance(funded), 9, `${tier}: an old balance is not spent`);
    assert.equal((await ledger(funded)).filter((row) => row.kind !== "stripe_purchase").length, 0);
  }
});

test("Free still has no documents, and nothing is charged or recorded", async () => {
  const userId = await addUser("free", { credits: 5 });
  const result = await attempt(userId);
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 429);
  assert.equal(await getCreditBalance(userId), 5);
  assert.equal(await documentRows(userId), 0);
});

// ---- No balance: refused, and nothing written -----------------------------------------------------------------------------------

test("past 20 with no credits is refused with the plain message, and writes nothing", async () => {
  const userId = await addUser("plus", { credits: 0, documentsUsed: 20 });
  const result = await attempt(userId);
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 402);
  assert.match(result.error.message, /used your 20 documents for this period and have no image & document credits left/);
  assert.equal(await documentRows(userId), 20, "no document row was added");
  assert.equal((await ledger(userId)).length, 0, "and no ledger row");
});

// ---- Concurrency: the balance can never go below zero ------------------------------------------------------------------------

test("six requests at once for one credit: exactly one is taken, the rest are refused, the balance is 0", async () => {
  const userId = await addUser("plus", { credits: 1, documentsUsed: 20 });
  const results = await Promise.all(Array.from({ length: 6 }, () => attempt(userId)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.error.status === 402));
  assert.equal(await getCreditBalance(userId), 0);
  assert.equal(await documentRows(userId), 21, "one new document row, not six");
});

test("ten at once for three credits: exactly three, balance 0, never negative", async () => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 25 });
  const results = await Promise.all(Array.from({ length: 10 }, () => attempt(userId)));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(await getCreditBalance(userId), 0);
  assert.ok((await ledger(userId)).every((row) => row.credits === 3 || row.credits === -1));
});

test("the last included document and extras at once: one free, then only as many as the credits allow", async () => {
  const userId = await addUser("plus", { credits: 2, documentsUsed: 19 });
  const results = await Promise.all(Array.from({ length: 6 }, () => attempt(userId)));
  assert.equal(results.filter((r) => r.ok).length, 3, "1 included + 2 paid");
  assert.equal(results.filter((r) => r.ok && r.value.creditCost === 0).length, 1);
  assert.equal(await getCreditBalance(userId), 0);
});

test("one account's spending never reaches another's balance", async () => {
  const a = await addUser("plus", { credits: 4, documentsUsed: 20 });
  const b = await addUser("plus", { credits: 4, documentsUsed: 20 });
  await Promise.all([attempt(a), attempt(a), attempt(b)]);
  assert.equal(await getCreditBalance(a), 2);
  assert.equal(await getCreditBalance(b), 3);
});

// ---- Failure releases it; settling and releasing are safe to repeat -------------------------------------------------------

test("a document that fails gives the credit and the slot back", async () => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 20 });
  await assert.rejects(generateDocument({ userId, format: "md", prompt: "p" }, { buildPlan: async () => { throw new Error("model down"); }, render: stubs.render }), /model down/);
  assert.equal(await getCreditBalance(userId), 3, "the credit is back");
  assert.equal(await documentRows(userId), 20, "and so is the document slot");
  const rows = await ledger(userId);
  assert.equal(rows.filter((r) => r.kind === "generation_reservation").length, 1);
  assert.equal(rows.filter((r) => r.kind === "usage_refund").length, 1);
});

test("a failure while rendering gives it back too", async () => {
  const userId = await addUser("plus", { credits: 2, documentsUsed: 20 });
  await assert.rejects(generateDocument({ userId, format: "md", prompt: "p" }, { buildPlan: stubs.buildPlan, render: async () => { throw new Error("bad file"); } }), /bad file/);
  assert.equal(await getCreditBalance(userId), 2);
});

test("a failed included document restores its slot and touches no credit", async () => {
  const userId = await addUser("plus", { credits: 2, documentsUsed: 5 });
  await assert.rejects(generateDocument({ userId, format: "md", prompt: "p" }, { buildPlan: async () => { throw new Error("down"); }, render: stubs.render }), /down/);
  assert.equal(await documentRows(userId), 5);
  assert.equal(await getCreditBalance(userId), 2);
});

test("releasing twice gives the credit back once", async () => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 20 });
  const reservation = await reserveDocumentGeneration(userId);
  await cancelUsageReservation(reservation.id, reservation.creditReservationId);
  await cancelUsageReservation(reservation.id, reservation.creditReservationId);
  await cancelUsageReservation(reservation.id, reservation.creditReservationId);
  assert.equal(await getCreditBalance(userId), 3, "3 bought, 1 reserved, 1 refunded: not 5");
  assert.equal((await ledger(userId)).filter((r) => r.kind === "usage_refund").length, 1);
});

test("a document made but not delivered is released once, however often it is retried", async () => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 20 });
  const generated = await generateDocument({ userId, format: "md", prompt: "p" }, stubs);
  assert.equal(await getCreditBalance(userId), 2);
  await releaseDocumentCharge(generated.reservation); // saving or storing the file failed afterwards
  await releaseDocumentCharge(generated.reservation);
  assert.equal(await getCreditBalance(userId), 3);
  assert.equal((await ledger(userId)).filter((r) => r.kind === "usage_refund").length, 1);
});

test("releasing an included document's reservation is a harmless no-op for credits", async () => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 1 });
  const generated = await generateDocument({ userId, format: "md", prompt: "p" }, stubs);
  await releaseDocumentCharge(generated.reservation);
  assert.equal(await getCreditBalance(userId), 3);
  assert.equal((await ledger(userId)).filter((r) => r.kind === "usage_refund").length, 0);
});

test("one usage event can carry only one debit (the ledger refuses a second)", async () => {
  const userId = await addUser("plus", { credits: 3, documentsUsed: 20 });
  const reservation = await reserveDocumentGeneration(userId);
  const debit = (await ledger(userId)).find((r) => r.kind === "generation_reservation");
  assert.equal(debit.externalReference, `document-credit:${reservation.id}`);
  await assert.rejects(db.insert(schema.creditLedger).values({ userId, credits: -1, kind: "generation_reservation", usageEventId: reservation.id, externalReference: `document-credit:${reservation.id}` }));
  assert.equal(await getCreditBalance(userId), 2);
});

// ---- Nothing else moves ------------------------------------------------------------------------------------------------------------

test("earlier balances and purchase records are untouched, and reading usage charges nothing", async () => {
  const userId = await addUser("plus", { credits: 500, documentsUsed: 30 });
  const before = await ledger(userId);
  await getCurrentUsage(userId);
  await getCurrentUsage(userId);
  assert.deepEqual(await ledger(userId), before, "viewing Usage writes nothing, even with documents already past the limit");
  await reserveDocumentGeneration(userId);
  const after = await ledger(userId);
  const purchase = after.find((r) => r.kind === "stripe_purchase");
  assert.deepEqual(purchase, before.find((r) => r.kind === "stripe_purchase"), "the purchase row is byte-for-byte the same");
  assert.equal(after.length, before.length + 1, "exactly one new row");
  assert.equal(await getCreditBalance(userId), 499);
});

test("the purchase history lists purchases only: spending is not a purchase", async () => {
  const userId = await addUser("plus", { credits: 100, documentsUsed: 20 });
  await reserveDocumentGeneration(userId);
  const { getCreditPurchaseHistory } = await import("../src/billing/service.js");
  const history = await getCreditPurchaseHistory(userId, { stripe: { checkout: { sessions: { retrieve: async () => { throw new Error("no network"); } } } } });
  assert.equal(history.length, 1);
  assert.equal(history[0].credits ?? history[0].creditsGranted, 100);
});

test("both places that deliver a generated document release the charge if delivery fails", () => {
  const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const file of ["src/chat/router.js", "src/generation/router.js"]) {
    assert.match(read(file), /releaseDocumentCharge\(/, `${file} releases the credit when saving or storing the document fails`);
  }
});
