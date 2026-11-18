import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { usagePayload, PLAN_LIMITS, NEXT_NOW } from "./support/usage-fixture.js";

// The Usage screen and the purchase screen, from the first-time user's side: what plan, what can I use now, when do I get more, what happens
// when it runs out. Numbers come from the server's own calculations (the fixture), and the purchase terms from the one shared module. No real
// purchase, no real subscription, no production balance: PGlite and fakes only.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db, pool: { query: (text, params) => client.query(text, params) } } });

const { CREDIT_PURCHASE, CREDIT_SPEND, FLEX_NAME, FLEX_FORMER_NAME, creditsForCents, creditUnits, formatDollars, parsePurchaseAmount, purchaseButtonLabel, purchaseEligibility } = await import("../frontend/src/flex-credits.js");
const { buildUsageOverview } = await import("../src/usage/overview.js");
const { usageOverviewView } = await import("../frontend/src/usage-overview-view.js");
const billing = await import("../src/billing/service.js");
const schema = await import("../src/db/schema.js");
const usageService = await import("../src/usage/service.js");
const { eq } = await import("drizzle-orm");
test.after(async () => { await client.close(); });

const view = (options, when = {}) => usageOverviewView(usagePayload(options), { locale: "en-US", timeZone: "UTC", now: NEXT_NOW, ...when });
let counter = 0;
const addUser = async (tier = "free") => {
  const id = `rework-${tier}-${++counter}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
  if (tier !== "free") await db.insert(schema.subscriptions).values({ userId: id, tier, status: "active", currentPeriodStartedAt: new Date(Date.now() - 10 * 86_400_000), currentPeriodEndsAt: new Date(Date.now() + 20 * 86_400_000) });
  return id;
};

// ---- The purchase terms: one set, exact conversion --------------------------------------------------------------------------

test("$1 buys 100 credits, exactly, and the screens and the server read the same terms", () => {
  assert.equal(CREDIT_PURCHASE.creditsPerDollar, 100);
  for (const [dollars, credits] of [[1, 100], [5, 500], [10, 1000], [20, 2000], [50, 5000], [12.5, 1250], [0.1 + 0.9, 100], [500, 50000]]) {
    const parsed = parsePurchaseAmount(dollars);
    assert.equal(parsed.ok, true, `$${dollars}`);
    assert.equal(parsed.credits, credits, `$${dollars} buys ${credits}`);
    assert.equal(parsed.cents, Math.round(dollars * 100));
    assert.equal(creditsForCents(parsed.cents), credits);
  }
  assert.deepEqual(billing.normalizeCreditPurchaseAmount("12.50"), { dollars: 12.5, cents: 1250, credits: 1250 }, "the server's answer is the same");
  assert.equal(billing.CREDIT_PURCHASE, CREDIT_PURCHASE, "the server re-exports the shared terms");
  assert.deepEqual([...CREDIT_PURCHASE.presets], [5, 10, 20, 50]);
  // The old screen said "$5 = 50". The charge was always 500: the screen was wrong by ten times.
  assert.notEqual(parsePurchaseAmount(5).credits, 50);
});

test("amounts the server refuses are refused on screen with the same words", () => {
  const refused = ["", "  ", null, undefined, "abc", 0, 0.5, 0.99, 1.05, 12.345, 500.1, 501, -5, "5,00", Infinity, NaN];
  for (const value of refused) {
    const screen = parsePurchaseAmount(value);
    assert.equal(screen.ok, false, JSON.stringify(value));
    assert.throws(() => billing.normalizeCreditPurchaseAmount(value), { message: screen.error });
    assert.equal(screen.error, "Enter an amount from $1 to $500 in $0.10 increments.");
  }
  for (const value of [1, 1.1, "1.10", 499.9, 500, "500"]) assert.equal(parsePurchaseAmount(value).ok, true, String(value));
});

test("the checkout carries exactly what the screen showed: the charge in cents and the credits granted", () => {
  const params = billing.creditCheckoutSessionParams({ userId: "u1", customerId: "cus_1", cents: 1250, credits: 1250, redirects: { successUrl: "https://x/ok", cancelUrl: "https://x/no" } });
  assert.equal(params.mode, "payment", "one payment, never a subscription");
  assert.equal(params.line_items[0].price_data.unit_amount, 1250);
  assert.equal(params.line_items[0].quantity, 1);
  assert.equal(params.metadata.credits, "1250");
  assert.equal(params.metadata.amountCents, "1250");
  assert.equal(params.metadata.kind, "credit_purchase");
  assert.match(params.line_items[0].price_data.product_data.name, /image & document credits \(1250\)/, "named for what it is, not Flex");
  assert.match(params.custom_text.submit.message, /one-time purchase of VibhavGPT image & document credits\. It does not renew\./);
  assert.equal(purchaseButtonLabel(500), "Buy 500 credits for $5.00");
  assert.equal(purchaseButtonLabel(100), "Buy 100 credits for $1.00");
  assert.equal(purchaseButtonLabel(1250), "Buy 1,250 credits for $12.50");
  assert.equal(creditUnits(1), "1 credit");
  assert.equal(formatDollars(1250), "$12.50");
});

// ---- Who can use what they buy -------------------------------------------------------------------------------------------------------

test("only Plus can spend a purchase; the others are told why, and Free is pointed at the plans", () => {
  assert.equal(purchaseEligibility("plus").eligible, true);
  for (const tier of ["pro", "max", "paid"]) {
    const e = purchaseEligibility(tier);
    assert.equal(e.eligible, false, tier);
    assert.match(e.reason, /unlimited documents/);
    assert.equal(e.action, null, "nothing to upgrade to for this");
  }
  const free = purchaseEligibility("free");
  assert.equal(free.eligible, false);
  assert.match(free.reason, /Free does not include documents/);
  assert.equal(free.action.id, "plans");
  assert.throws(() => billing.assertCreditPurchaseAllowed("free"), (e) => e.status === 403 && e.code === "credits_not_usable_on_plan");
  assert.throws(() => billing.assertCreditPurchaseAllowed("pro"), (e) => e.code === "credits_not_usable_on_plan");
  assert.throws(() => billing.assertCreditPurchaseAllowed("max"), (e) => e.code === "credits_not_usable_on_plan");
  assert.doesNotThrow(() => billing.assertCreditPurchaseAllowed("plus"));
  const router = read("src/billing/router.js");
  assert.match(router, /assertCreditPurchaseAllowed\(\(await getCurrentUsage\(req\.authSession\.user\.id\)\)\.tier\);/, "the route checks the plan before it opens a checkout");
  assert.match(router, /error\.code === "credits_not_usable_on_plan"\) return res\.status\(403\)/);
});

// ---- What the server reports -------------------------------------------------------------------------------------------------------------------

test("the overview reports what each plan is enforced to have, and never an Infinity or a made-up zero", () => {
  const forTier = (tier, extra = {}) => usagePayload({ tier, ...extra }).overview;
  const free = forTier("free", { imagesUsed: 1 });
  assert.deepEqual({ included: free.images.included, limit: free.images.limit, remaining: free.images.remaining, period: free.images.period }, { included: true, limit: 2, remaining: 1, period: "week" });
  assert.equal(free.documents.included, false);
  assert.equal(free.flex.canBuy, false);
  const plus = forTier("plus", { imagesUsed: 12, documentsUsed: 20, flex: 40 });
  assert.deepEqual({ limit: plus.images.limit, remaining: plus.images.remaining, period: plus.images.period }, { limit: 100, remaining: 88, period: "month" });
  assert.deepEqual({ limit: plus.documents.limit, remaining: plus.documents.remaining, unlimited: plus.documents.unlimited }, { limit: 20, remaining: 0, unlimited: false });
  assert.deepEqual(plus.documents.extras, { available: true, costCredits: 1 });
  assert.equal(plus.flex.balance, 40);
  assert.equal(plus.flex.canBuy, true);
  const pro = forTier("pro");
  assert.deepEqual({ limit: pro.images.limit, unlimited: pro.documents.unlimited, limit2: pro.documents.limit, remaining: pro.documents.remaining }, { limit: 400, unlimited: true, limit2: null, remaining: null });
  assert.equal(pro.documents.extras.available, false);
  const max = forTier("max");
  assert.equal(max.documents.unlimited, true);
  assert.equal(max.images.limit, PLAN_LIMITS.max.images);
  for (const o of [free, plus, pro, max]) {
    assert.equal(o.images.extras.available, false, "images can never be bought past the limit");
    assert.equal(o.flex.fundsChatAndStudy, false);
    assert.equal(o.flex.terms.expires, false);
    assert.equal(o.flex.name, FLEX_NAME);
    assert.equal(o.flex.formerName, FLEX_FORMER_NAME);
    assert.equal(JSON.stringify(o).includes("Infinity"), false);
  }
  assert.equal(buildUsageOverview({ usage: { tier: "plus", periodEndsAt: "2026-12-01T00:00:00.000Z" }, limits: PLAN_LIMITS.plus, flexBalance: undefined }).flex.balance, 0, "no balance reads as none, not as an error");
});

test("a monthly and an annual subscription show the same allowances, each renewing on its own period's end", () => {
  const monthly = usagePayload({ tier: "plus", period: { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1), basis: "calendar-month" } });
  const annualMidYear = usagePayload({ tier: "plus", period: { start: Date.UTC(2026, 10, 3), end: Date.UTC(2026, 11, 3), basis: "calendar-month" } });
  assert.deepEqual([monthly.overview.images.limit, monthly.overview.documents.limit], [annualMidYear.overview.images.limit, annualMidYear.overview.documents.limit]);
  assert.equal(monthly.overview.images.renewsAt, "2026-12-01T00:00:00.000Z");
  assert.equal(annualMidYear.overview.images.renewsAt, "2026-12-03T00:00:00.000Z", "an annual plan's allowance still renews monthly, from its own billing day");
  const v = (payload) => usageOverviewView(payload, { locale: "en-US", timeZone: "UTC", now: NEXT_NOW });
  assert.match(v(monthly).images.renews, /Dec 1, 12:00 AM UTC/);
  assert.match(v(annualMidYear).images.renews, /Dec 3, 12:00 AM UTC/);
});

// ---- What the screen says ----------------------------------------------------------------------------------------------------------------------------

test("Chat & Study: what can be used right now is only what has been released, and future weeks are not in it", () => {
  const payload = usagePayload({ tier: "plus", spentCredits: 3, flex: 0 });
  const v = usageOverviewView(payload, { locale: "en-US", timeZone: "UTC", now: NEXT_NOW });
  assert.equal(v.chat.title, "Chat & Study");
  assert.equal(v.chat.headline.label, "AI credits you can use right now");
  assert.equal(v.chat.headline.value, "25 credits", "carried in plus this week's, less what was used: not the month's 60");
  assert.equal(payload.credits.futureAllocationMicros > 0, true, "there are future allocations");
  const future = payload.credits.futureAllocationMicros / 50_000;
  assert.ok(!v.chat.headline.value.includes(String(Math.round(future))), "and they are not counted");
  const rows = Object.fromEntries(v.chat.rows.map((r) => [r.id, r.value]));
  assert.equal(rows.used, "3 credits", "used this month is its own line");
  assert.equal(rows.monthly, "60 credits, released weekly", "the month's allowance is context, not a balance");
  assert.equal(rows.next, "14 credits on Sun, Nov 15, 12:00 AM UTC", "the next allocation's amount and date and time");
  assert.match(v.chat.runOut, /wait for your next allocation on Sun, Nov 15, 12:00 AM UTC\./);
});

test("carry and expiry each say only what the policy does", () => {
  const carry = view({ carryMode: "carry" }).chat;
  assert.equal(carry.rule, "Credits arrive each week, and unused credits carry forward within the month. A later week's credits are never available early.");
  const expiry = view({ carryMode: "expiry" }).chat;
  assert.equal(expiry.rule, "Credits arrive each week. Unused credits expire when the week resets.");
  for (const text of [carry.rule, expiry.rule, carry.runOut, expiry.runOut]) assert.doesNotMatch(text, /token|multiplier|rolling/i);
  assert.ok(expiry.rule.split(".").filter(Boolean).length <= 2 && carry.rule.split(".").filter(Boolean).length <= 2, "one short sentence each (two clauses at most)");
});

test("the schedule, the accounting rows and the meter are behind View details, not the main view", () => {
  const chat = view({ tier: "plus", spentCredits: 3 }).chat;
  assert.deepEqual(chat.rows.map((r) => r.id), ["used", "monthly", "next"], "three lines up front");
  assert.ok(chat.details.schedule.length >= 4 && chat.details.rows.some((r) => r.id === "future") && chat.details.meter.percent >= 0);
  const component = read("frontend/src/components/UsageOverview.jsx");
  assert.match(component, /<details className="uo-details">\s*<summary>View details<\/summary>/);
  assert.match(component, /Allocation schedule/);
  assert.doesNotMatch(component.replace(/\/\/.*$/gm, ""), /tokens?\b/i, "no tokens on this screen");
});

test("exhaustion says what ran out and what happens next: this week, this month, and under one credit", () => {
  const week = view({ tier: "plus", spentCredits: 25 + 3 }).chat;
  assert.equal(week.state, "week-exhausted");
  assert.equal(week.headline.value, "None");
  assert.match(week.runOut, /used all the AI credits released so far this month\. More arrive on Sun, Nov 15, 12:00 AM UTC\./);
  const expiryWeek = view({ tier: "plus", carryMode: "expiry", spentCredits: 14, spentAt: new Date("2026-11-09T10:00:00Z") }).chat;
  assert.equal(expiryWeek.state, "week-exhausted");
  assert.match(expiryWeek.runOut, /used this week's AI credits\. They reset on Sun, Nov 15, 12:00 AM UTC\./);
  // The last week of the month: the next thing is the monthly reset, not another allocation.
  const lastWeek = usageOverviewView(usagePayload({ tier: "plus", now: new Date("2026-11-29T10:00:00Z"), spentCredits: 60 }), { locale: "en-US", timeZone: "UTC", now: new Date("2026-11-29T10:00:00Z").getTime() }).chat;
  assert.equal(lastWeek.rows.find((r) => r.id === "next").label, "Monthly allowance resets");
  assert.match(lastWeek.runOut, /Dec 1, 12:00 AM UTC/);
  // Under one credit is shown as it is, never rounded up into something that looks spendable.
  const sliver = usagePayload({ tier: "plus", spentCredits: 27.5 });
  const sliverView = usageOverviewView(sliver, { locale: "en-US", timeZone: "UTC", now: NEXT_NOW }).chat;
  assert.match(sliverView.headline.value, /^0\.[0-9]+ credits?$|^0 credits?$/, `rounded down: ${sliverView.headline.value}`);
  assert.equal(sliverView.headline.note, "Less than one credit is left, and it can still be used.");
});

test("Images: what is left, when it renews, and that extra images cannot be bought", () => {
  const free = view({ tier: "free", imagesUsed: 1 }).images;
  assert.equal(free.headline.value, "1 of 2");
  assert.equal(free.headline.label, "Images left this week");
  assert.match(free.renews, /Free accounts get 2 images each week\. The next 2 arrive Sun, Nov 15|Mon, Nov 16/);
  assert.match(free.runOut, /image requests stop until .*\. Extra images can't be bought\./);
  const plus = view({ tier: "plus", imagesUsed: 12 }).images;
  assert.equal(plus.headline.value, "88 of 100");
  assert.match(plus.renews, /Your allowance renews on Tue, Dec 1, 12:00 AM UTC\./);
  assert.equal(plus.meter.remaining, 88);
  const pro = view({ tier: "pro", imagesUsed: 400 }).images;
  assert.equal(pro.headline.value, "0 of 400");
  assert.match(pro.runOut, /Extra images can't be bought\./, "paid extras: none for images");
  const readable = (n) => n.toLocaleString("en-US");
  assert.equal(view({ tier: "max" }).images.headline.value, `${readable(PLAN_LIMITS.max.images)} of ${readable(PLAN_LIMITS.max.images)}`);
  assert.equal(view({ tier: "max" }).images.headline.value, "1,500 of 1,500", "Max's allowance, as approved");
  // A plan with no images says so, and points at the plans, and is not a zero.
  const none = usageOverviewView(usagePayload({ tier: "free", limits: { images: 0, documents: 0 } }), { locale: "en-US", timeZone: "UTC", now: NEXT_NOW }).images;
  assert.equal(none.included, false);
  assert.equal(none.message, "Image creation is not included on Free.");
});

test("Documents: unlimited only where it is enforced, and what an extra costs only where it applies", () => {
  assert.equal(view({ tier: "pro" }).documents.headline.value, "Unlimited");
  assert.equal(view({ tier: "max" }).documents.headline.value, "Unlimited");
  assert.match(view({ tier: "pro" }).documents.runOut, /Pro has no monthly limit on documents\./);
  const free = view({ tier: "free" }).documents;
  assert.equal(free.included, false);
  assert.equal(free.message, "Document creation is not included on Free.");
  const plus = view({ tier: "plus", documentsUsed: 6 }).documents;
  assert.equal(plus.headline.value, "14 of 20");
  assert.match(plus.runOut, /After 20 in a month, each extra document uses 1 credit of image & document credits\. With none, documents wait until Tue, Dec 1, 12:00 AM UTC\./);
  const withBalance = view({ tier: "plus", documentsUsed: 20, flex: 120 }).documents;
  assert.equal(withBalance.headline.value, "0 of 20");
  assert.match(withBalance.runOut, /\(120 credits available\)/);
});

test("the purchased balance is its own thing, named for what it is, and says it does not fund Chat & Study", () => {
  const extra = view({ tier: "plus", flex: 1250 }).extra;
  assert.equal(extra.title, "Image & document credits");
  assert.equal(extra.formerName, "Previously called Flex Credits.");
  assert.equal(extra.balanceText, "1,250 credits");
  assert.match(extra.note, /don't add Chat & Study credits, and they don't expire/);
  const payload = usagePayload({ tier: "plus", flex: 77 });
  assert.equal(payload.credits.purchased.coversText, false, "the server says it too");
  assert.equal(payload.credits.purchased.balance, 77);
  // The AI credits figure is unaffected by the balance.
  assert.equal(view({ tier: "plus", flex: 0 }).chat.headline.value, view({ tier: "plus", flex: 99999 }).chat.headline.value);
});

test("when the numbers are not known the screen says so and shows no zeros", () => {
  assert.equal(usageOverviewView(null), null);
  const noOverview = usageOverviewView(usagePayload({ tier: "plus", includeOverview: false }), { locale: "en-US", timeZone: "UTC", now: NEXT_NOW });
  for (const section of [noOverview.images, noOverview.documents, noOverview.extra]) {
    assert.equal(section.available, false);
    assert.match(section.message, /unavailable right now\./);
    assert.doesNotMatch(JSON.stringify(section), /"value":"0|of 0|\b0 credits/);
  }
  // Credits not active: the earlier token screen stands in, under the same heading.
  const legacy = usageOverviewView(usagePayload({ tier: "pro", creditsActive: false }), { locale: "en-US", timeZone: "UTC", now: NEXT_NOW });
  assert.deepEqual({ kind: legacy.chat.kind, title: legacy.chat.title }, { kind: "tokens", title: "Chat & Study" });
  const app = read("frontend/src/App.jsx");
  assert.match(app, /Your usage could not be loaded, so no numbers are shown\./);
});

test("times carry their zone and follow the reader's locale", () => {
  const eastern = usageOverviewView(usagePayload({ tier: "plus" }), { locale: "en-US", timeZone: "America/New_York", now: NEXT_NOW });
  assert.match(eastern.chat.rows.find((r) => r.id === "next").value, /Sat, Nov 14, 7:00 PM EST$/);
  const utc = usageOverviewView(usagePayload({ tier: "plus" }), { locale: "en-US", timeZone: "UTC", now: NEXT_NOW });
  assert.match(utc.chat.rows.find((r) => r.id === "next").value, /Sun, Nov 15, 12:00 AM UTC$/);
});

// ---- Payments: pending, failed, duplicate, and history that keeps its meaning ---------------------------------------------------------

test("a purchase is credited once, only when paid; pending, failed and repeated events change nothing", async () => {
  const granted = [];
  const grantCredits = async (grant) => { granted.push(grant); return true; };
  const session = (extra = {}) => ({ id: "cs_1", payment_status: "paid", client_reference_id: "u1", metadata: { kind: "credit_purchase", userId: "u1", credits: "500", amountCents: "500" }, ...extra });
  assert.equal(await billing.applySubscriptionEvent({ type: "checkout.session.completed", data: { object: session({ payment_status: "unpaid" }) } }, { grantCredits }), false, "pending: nothing is granted");
  assert.equal(await billing.applySubscriptionEvent({ type: "checkout.session.async_payment_failed", data: { object: session({ payment_status: "unpaid" }) } }, { grantCredits }), false, "a failed payment grants nothing");
  assert.equal(await billing.applySubscriptionEvent({ type: "checkout.session.expired", data: { object: session() } }, { grantCredits }), false, "an expired checkout grants nothing");
  assert.deepEqual(granted, []);
  assert.equal(await billing.applySubscriptionEvent({ type: "checkout.session.async_payment_succeeded", data: { object: session() } }, { grantCredits }), true);
  assert.deepEqual(granted, [{ userId: "u1", credits: "500", checkoutSessionId: "cs_1" }]);
  // The database refuses the same checkout twice.
  const userId = await addUser("plus");
  assert.equal(await billing.grantCreditPurchase({ userId, credits: 500, checkoutSessionId: "cs_dup" }, db), true);
  assert.equal(await billing.grantCreditPurchase({ userId, credits: 500, checkoutSessionId: "cs_dup" }, db), false, "a duplicate is ignored");
  assert.equal(await billing.grantCreditPurchase({ userId, credits: 0, checkoutSessionId: "cs_zero" }, db), false);
  assert.equal(await billing.grantCreditPurchase({ userId, credits: -5, checkoutSessionId: "cs_neg" }, db), false);
  assert.equal(await usageService.getCreditBalance(userId, db), 500, "the balance moved once");
});

test("a purchase made under the old name keeps its meaning in the history, and the history says date, amount, units and status", async () => {
  const userId = await addUser("plus");
  await billing.grantCreditPurchase({ userId, credits: 500, checkoutSessionId: "cs_old_1" }, db);
  await billing.grantCreditPurchase({ userId, credits: 1250, checkoutSessionId: "cs_old_2" }, db);
  const stripe = { checkout: { sessions: { retrieve: async (id) => ({ id, created: 1_700_000_000, amount_total: id === "cs_old_1" ? 500 : 1250, currency: "usd", payment_status: "paid", payment_intent: { latest_charge: { receipt_url: `https://pay.example/${id}` } } }) } } };
  const history = await billing.getCreditPurchaseHistory(userId, { stripe, executor: db });
  assert.equal(history.length, 2);
  const byId = Object.fromEntries(history.map((h) => [h.id, h]));
  assert.deepEqual({ amount: byId.cs_old_1.amountCents, credits: byId.cs_old_1.creditsGranted, status: byId.cs_old_1.status }, { amount: 500, credits: 500, status: "paid" });
  assert.deepEqual({ amount: byId.cs_old_2.amountCents, credits: byId.cs_old_2.creditsGranted }, { amount: 1250, credits: 1250 });
  assert.ok(byId.cs_old_1.purchasedAt, "with its date");
  assert.match(byId.cs_old_1.receiptUrl, /^https:\/\/pay\.example\//);
  // If the provider cannot be reached, the ledger still tells the truth about units, and the amount reads as unavailable, not zero.
  const offline = await billing.getCreditPurchaseHistory(userId, { stripe: { checkout: { sessions: { retrieve: async () => { throw new Error("offline"); } } } }, executor: db });
  assert.deepEqual(offline.map((h) => h.creditsGranted).sort(), [1250, 500]);
  assert.ok(offline.every((h) => h.amountCents === null && h.status === "recorded"));
  const component = read("frontend/src/components/CreditPurchase.jsx");
  assert.match(component, /Amount unavailable/);
  assert.match(component, /\{creditUnits\(purchase\.creditsGranted\)\} added/);
  assert.match(component, /STATUS = \{ paid: "Paid", recorded: "Recorded" \}/);
});

test("past its documents on Plus, no credits means a plain refusal that names what ran out and when it renews", async () => {
  const userId = await addUser("plus");
  for (let i = 0; i < 20; i += 1) await db.insert(schema.usageEvents).values({ userId, model: "__document__", createdAt: new Date() });
  await assert.rejects(usageService.reserveDocumentGeneration(userId), (error) => {
    assert.equal(error.reason, "credits");
    assert.equal(error.feature, "Document generation");
    assert.equal(error.status, 402);
    assert.match(error.message, /^You've used your 20 documents for this period and have no image & document credits left\./);
    assert.ok(Number.isFinite(new Date(error.resetAt).getTime()), "with the renewal time");
    assert.doesNotMatch(error.message, /Chat|Study|AI credits/);
    return true;
  });
  // With a balance the next one is allowed. (Today the balance is checked but not reduced by a document: see the report.)
  await billing.grantCreditPurchase({ userId, credits: 100, checkoutSessionId: "cs_docs" }, db);
  const reservation = await usageService.reserveDocumentGeneration(userId);
  assert.ok(reservation.id);
  // Pro is never refused for documents, whatever the count.
  const pro = await addUser("pro");
  for (let i = 0; i < 25; i += 1) await db.insert(schema.usageEvents).values({ userId: pro, model: "__document__", createdAt: new Date() });
  assert.ok((await usageService.reserveDocumentGeneration(pro)).id);
  // Free has no documents: a plan refusal, not a credits one.
  const free = await addUser("free");
  await assert.rejects(usageService.reserveDocumentGeneration(free), (error) => error.reason === "plan");
});

// ---- Words: one name, and nothing promised that is not built --------------------------------------------------------------------------------

test("the purchased balance has one name everywhere, and no copy promises what is not enforced", () => {
  const files = ["frontend/src/product-knowledge.js", "frontend/src/credits-copy.js", "frontend/src/public-pages.js", "frontend/src/onboarding.js", "frontend/src/access-status.js", "frontend/src/components/notice/WorkspaceNotice.jsx", "frontend/src/credits-view.js", "frontend/src/components/CreditPurchase.jsx", "frontend/src/components/UsageOverview.jsx", "src/billing/service.js"];
  for (const file of files) {
    const text = read(file).replace(/\/\/.*$/gm, "");
    for (const match of text.matchAll(/[^.\n]*Flex[^.\n]*/g)) {
      assert.match(match[0], /(previously|formerly)( called)? Flex|FLEX_FORMER_NAME|Flex Credits\) |const FLEX_|FLEX_NAME|FLEX_/i, `${file}: an unexplained "Flex": ${match[0].trim().slice(0, 100)}`);
    }
    assert.doesNotMatch(text, /3 (Flex )?[Cc]redits each|cost 3 credits|image generations beyond the (included|plan) allowance (use|cost)/, `${file}: images were never payable with credits`);
    assert.doesNotMatch(text, /credits can be spent on (chat|study)/i);
  }
  assert.equal(FLEX_NAME, "Image & document credits");
  assert.equal(CREDIT_SPEND.extraDocument, 1);
  assert.equal(read("frontend/src/App.jsx").includes("CREDIT_PRESETS"), false, "the screen no longer has its own presets");
});

test("each allowance that can run out says which one it is, and a purchased balance is never offered for images", async () => {
  const { authorizeImageGeneration } = await import("../src/generation/image-engine.js");
  const { documentCreditsError } = await import("../src/usage/service.js");
  // Free: the weekly count, with the fixed Monday time.
  const free = authorizeImageGeneration("free", 2, { now: new Date("2026-11-11T15:00:00.000Z") });
  assert.equal(free.error.code, "image_quota_exhausted");
  assert.match(free.error.message, /used your 2 free images this week\. More arrive Monday at 12:00 AM UTC/);
  // A paid plan: the image allowance, with the statement that credits cannot add images.
  for (const [plan, limit] of [["plus", 100], ["pro", 400]]) {
    const paid = authorizeImageGeneration(plan, limit);
    assert.equal(paid.error.status, 429);
    assert.match(paid.error.message, new RegExp(`used all ${limit} images included with your plan`));
    assert.match(paid.error.message, /Image & document credits can't buy extra images/);
    assert.doesNotMatch(paid.error.message, /buy credits|add credits|top up/i, "no purchase is suggested for something a purchase cannot fix");
  }
  // Documents: the one place a purchase helps, and the message says so and when the allowance renews.
  const documents = documentCreditsError({ limit: 20, resetAt: "2026-12-01T00:00:00.000Z" });
  assert.equal(documents.status, 402);
  assert.match(documents.message, /used your 20 documents for this period and have no image & document credits left/);
  assert.match(documents.message, /renews on the date shown, or you can buy credits/);
  // None of the three is worded like the Chat & Study message.
  const chat = usageOverviewView(usagePayload({ tier: "plus", spentCredits: 60, spentAt: new Date("2026-11-11T14:00:00.000Z") }), { locale: "en-US", timeZone: "UTC", now: NEXT_NOW });
  for (const message of [free.error.message, documents.message]) assert.doesNotMatch(message, /AI credits/);
  assert.match(JSON.stringify(chat.chat), /AI credits/);
});
