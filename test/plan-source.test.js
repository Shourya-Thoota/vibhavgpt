// Part A (phantom store card): the plans page and the sidebar read one plan resolver, a store row is shown or honoured only while it
// verifies, a direct grant is never presented as a store purchase, and a complimentary account is Max everywhere, never masked by a
// leftover row. Fixture addresses only.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db, pool: { query: (text, params) => client.query(text, params) } } });
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: { requireSession: (_req, _res, next) => next(), loadOptionalSession: (_req, _res, next) => next() },
});

const { config, parseCompPlanAccounts } = await import("../src/config.js");
const { getActiveSubscription, tierForSubscription, getCurrentUsage } = await import("../src/usage/service.js");
const { planSourceFor, storeSubscriptionVerified, rowMayGrant } = await import("../src/billing/plan-source.js");
const { billingRouter } = await import("../src/billing/router.js");

const DAY = 86_400_000;
const future = new Date(Date.now() + 20 * DAY).toISOString();
const past = new Date(Date.now() - 20 * DAY).toISOString();

async function account(id, email, row = null) {
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2)`, [id, email]);
  if (!row) return;
  await client.query(
    `INSERT INTO subscriptions (user_id, tier, status, billing_source, provider_purchase_token_hash, current_period_ends_at, customer_id, subscription_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, row.tier, row.status, row.source, row.token ?? null, row.end ?? null, row.customer ?? null, row.subscriptionId ?? null],
  );
}
async function withComp(list, fn) {
  const before = config.compPlanAccounts;
  config.compPlanAccounts = parseCompPlanAccounts(list);
  try { return await fn(); } finally { config.compPlanAccounts = before; }
}
async function billing(userId) {
  const layer = billingRouter.stack.find((l) => l.route?.path === "/subscription" && l.route.methods.get);
  let body = null;
  await layer.route.stack.at(-1).handle({ authSession: { user: { id: userId } }, headers: {} }, { json: (value) => { body = value; return value; }, status() { return this; } }, (error) => { throw error; });
  return body;
}
const sidebarTier = async (userId) => (await getCurrentUsage(userId, db)).tier;

await account("nosub", "nosub@example.test");
await account("store-no-token", "a@example.test", { tier: "pro", status: "active", source: "google_play", end: future });
await account("store-ended", "b@example.test", { tier: "pro", status: "active", source: "google_play", token: "hash", end: past });
await account("store-no-end", "c@example.test", { tier: "pro", status: "active", source: "google_play", token: "hash" });
await account("store-verified", "d@example.test", { tier: "plus", status: "active", source: "google_play", token: "hash", end: future });
await account("store-unknown", "e@example.test", { tier: "pro", status: "active", source: "app_store", token: "hash", end: future });
await account("granted", "f@example.test", { tier: "pro", status: "active", source: "internal" });
await account("comp-granted", "owner@example.test", { tier: "pro", status: "active", source: "internal" });
await account("comp-stale-store", "owner2@example.test", { tier: "pro", status: "active", source: "google_play", end: future });
await account("comp-web", "owner3@example.test", { tier: "plus", status: "active", source: "stripe", end: future, customer: "cus_x", subscriptionId: "sub_x" });

test("(1) an account with no subscription is Free on both surfaces: the sidebar's resolver and the plans page", async () => {
  assert.equal(await sidebarTier("nosub"), "free");
  const body = await billing("nosub");
  assert.deepEqual(body.plan, { tier: "free", source: "none" });
  assert.equal(body.subscription, null, "no current-plan card");
  assert.equal(body.complimentary, false);
});

test("(2) a store row that does not verify never shows the store card and never grants its tier", async () => {
  for (const id of ["store-no-token", "store-ended", "store-no-end", "store-unknown"]) {
    assert.equal(await sidebarTier(id), "free", `${id}: grants nothing`);
    const body = await billing(id);
    assert.deepEqual(body.plan, { tier: "free", source: "none" }, id);
    assert.equal(body.subscription, null, `${id}: no "Bought in the Android app" card`);
  }
});

test("a store row that still verifies (Play's token, active, paid period open) keeps its plan and its card", async () => {
  assert.equal(await sidebarTier("store-verified"), "plus");
  const body = await billing("store-verified");
  assert.deepEqual(body.plan, { tier: "plus", source: "google_play" });
  assert.equal(body.subscription.billingSource, "google_play");
});

test("a direct grant keeps its access but is never presented as a store purchase", async () => {
  assert.equal(await sidebarTier("granted"), "pro", "the nine granted accounts keep their plan");
  const body = await billing("granted");
  assert.deepEqual(body.plan, { tier: "pro", source: "internal" });
  assert.notEqual(body.plan.source, "google_play");
});

test("(3) a complimentary account is Max on both surfaces, never masked by a grant or a stale store row", async () => {
  await withComp("owner@example.test, owner2@example.test, owner3@example.test", async () => {
    for (const id of ["comp-granted", "comp-stale-store"]) {
      assert.equal(await sidebarTier(id), "max", `${id}: sidebar`);
      const body = await billing(id);
      assert.deepEqual(body.plan, { tier: "max", source: "complimentary" }, `${id}: plans page`);
      assert.equal(body.complimentary, true);
      assert.equal(body.subscription.billingSource, "complimentary", "no store card, no manage or cancel");
    }
    // A real, current web subscription is what billing shows; the plan stays Max.
    const web = await billing("comp-web");
    assert.deepEqual(web.plan, { tier: "max", source: "stripe" });
    assert.equal(web.complimentary, false);
    assert.equal(await sidebarTier("comp-web"), "max");
  });
});

test("the resolver rules, row by row", () => {
  const now = new Date();
  assert.equal(storeSubscriptionVerified({ billingSource: "google_play", providerPurchaseTokenHash: "h", tier: "pro", status: "active", currentPeriodEndsAt: future }, now), true);
  assert.equal(storeSubscriptionVerified({ billingSource: "google_play", tier: "pro", status: "active", currentPeriodEndsAt: future }, now), false, "no token");
  assert.equal(storeSubscriptionVerified({ billingSource: "google_play", providerPurchaseTokenHash: "h", tier: "pro", status: "expired", currentPeriodEndsAt: future }, now), false);
  assert.equal(rowMayGrant({ billingSource: "stripe" }), true);
  assert.equal(rowMayGrant({ billingSource: "internal" }), true);
  assert.equal(rowMayGrant({ billingSource: "anything-else", providerPurchaseTokenHash: "h", tier: "pro", status: "active", currentPeriodEndsAt: future }), false);
  assert.equal(tierForSubscription({ billingSource: "google_play", tier: "pro", status: "active", currentPeriodEndsAt: future }), "free");
  assert.equal(planSourceFor(null, { complimentary: true }), "complimentary");
  assert.equal(planSourceFor({ billingSource: "stripe", tier: "pro", status: "canceled", currentPeriodEndsAt: past }), "none");
});

test("the sidebar and the plans page read the same source of truth, and Max is never shown as Free", () => {
  const app = readFileSync("frontend/src/App.jsx", "utf8");
  assert.match(app, /setTier\(usage\.tier === "paid" \? "pro" : \["plus", "pro", "max"\]\.includes\(usage\.tier\) \? usage\.tier : "free"\);/);
  assert.match(app, /const appSubscription = planSource === "google_play";/, "the store card follows the server's verified source only");
  assert.match(app, /<strong>\{TIER_LABEL\[currentPlanTier\] \?\? "Free"\} plan<\/strong>/, "the plans page label is the server's resolved plan");
  assert.match(app, /\{!appSubscription && !complimentaryPlan && !grantedPlan && \(/, "no manage or cancel for complimentary or granted plans");
});
