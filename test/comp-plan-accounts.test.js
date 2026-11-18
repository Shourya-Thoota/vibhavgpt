// Complimentary-plan accounts (COMP_PLAN_ACCOUNTS): always Max, unlimited AI usage, never lowered by billing, inert when unset. The
// addresses here are fixtures; no real address appears in the repository.
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
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (text, params) => client.query(text, params) } },
});

// The billing router's session check is not under test here (and would start the auth library).
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: { requireSession: (_req, _res, next) => next(), loadOptionalSession: (_req, _res, next) => next() },
});

const { config, parseCompPlanAccounts } = await import("../src/config.js");
const { isCompPlanAccount, isCompPlanEmail, compPlanAccountCount, COMPLIMENTARY_SUBSCRIPTION } = await import("../src/billing/comp-accounts.js");
const { getActiveSubscription, tierForSubscription, reserveUsage, finalizeUsage, getCreditsSummary, assertModelPlanAccess, getCurrentUsage } = await import("../src/usage/service.js");
const { applySubscriptionEvent, saveSubscription } = await import("../src/billing/service.js");
const { billingRouter } = await import("../src/billing/router.js");

const COMP = "owner@example.test";
await client.exec(`INSERT INTO "user" (id, email) VALUES ('comp', 'Owner@Example.test'), ('member', 'member@example.test'), ('member2', 'member2@example.test')`);

async function withComp(list, fn) {
  const before = config.compPlanAccounts;
  config.compPlanAccounts = parseCompPlanAccounts(list);
  try { return await fn(); } finally { config.compPlanAccounts = before; }
}
async function withCredits(fn) {
  const before = { enabled: config.creditsPolicyEnabled, mode: config.creditsCarryMode, at: config.creditsActivatedAt };
  config.creditsPolicyEnabled = true; config.creditsCarryMode = "carry"; config.creditsActivatedAt = new Date("2026-01-01T00:00:00.000Z");
  try { return await fn(); } finally { config.creditsPolicyEnabled = before.enabled; config.creditsCarryMode = before.mode; config.creditsActivatedAt = before.at; }
}

// ---- Configuration ----------------------------------------------------------------------------------------------------------

test("COMP_PLAN_ACCOUNTS: trimmed, case-insensitive emails; empty or malformed is a no-op", () => {
  assert.deepEqual(parseCompPlanAccounts(undefined), []);
  assert.deepEqual(parseCompPlanAccounts(""), []);
  assert.deepEqual(parseCompPlanAccounts(" , ,,"), []);
  assert.deepEqual(parseCompPlanAccounts("not-an-email, @nope.test, a@b, a b@c.test"), []);
  assert.deepEqual(parseCompPlanAccounts(" Owner@Example.test , owner@example.test,second@example.test"), ["owner@example.test", "second@example.test"]);
  // Ordinary addresses of every shape survive (letters such as s, dots, plus tags, sub-domains); a dot is required after the @.
  assert.deepEqual(parseCompPlanAccounts("sasha.s+tag@mail.example.test,first.last@example.co.uk"), ["sasha.s+tag@mail.example.test", "first.last@example.co.uk"]);
  assert.deepEqual(parseCompPlanAccounts("owner@examplexcom"), [], "a missing dot is not an address");
  assert.equal(isCompPlanEmail("OWNER@example.TEST ", ["owner@example.test"]), true);
  assert.equal(isCompPlanEmail("owner@example.test", []), false);
  assert.equal(compPlanAccountCount(["a@b.test"]), 1);
});

test("with the list empty nothing runs: no lookup, and every account resolves exactly as before", async () => {
  let queried = 0;
  const spy = { execute: async () => { queried += 1; return { rows: [{ email: COMP }] }; } };
  await withComp("", async () => {
    assert.equal(await isCompPlanAccount("comp", spy), false);
    assert.equal(queried, 0, "no query at all");
    assert.equal(await getActiveSubscription("comp", db), null);
    assert.equal(tierForSubscription(await getActiveSubscription("comp", db)), "free");
  });
  assert.equal(config.compPlanAccounts.length, 0, "the test environment ships with no comp accounts");
});

test("the address is never in the repository: only configuration names it", () => {
  for (const file of ["src/billing/comp-accounts.js", "src/usage/service.js", "src/billing/router.js", "src/config.js", ".env.example", "src/server.js"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /shouryathoota/i, file);
  }
  assert.match(readFileSync(".env.example", "utf8"), /^COMP_PLAN_ACCOUNTS=$/m, "documented, with no value");
});

// ---- Max everywhere --------------------------------------------------------------------------------------------------------

test("a comp account resolves to Max at every plan gate, Zenith included; others are untouched", async () => {
  await withComp(COMP, async () => {
    assert.equal(await isCompPlanAccount("comp", db), true, "matched case-insensitively from the account's own email");
    const sub = await getActiveSubscription("comp", db);
    assert.equal(sub.compPlan, true);
    assert.equal(tierForSubscription(sub), "max");
    assert.equal((await getCurrentUsage("comp", db)).tier, "max", "the usage and plan API");
    for (const model of ["lumen", "nova", "nebula", "vesper", "zenith"]) assert.doesNotThrow(() => assertModelPlanAccess("max", model), model);
    // A different account: still Free with no subscription.
    assert.equal(await isCompPlanAccount("member", db), false);
    assert.equal(tierForSubscription(await getActiveSubscription("member", db)), "free");
    const memberTier = (await getCurrentUsage("member", db)).tier;
    assert.throws(() => assertModelPlanAccess(memberTier, "zenith"), "and Zenith stays Max only for everyone else");
  });
});

test("billing can never lower it: a webhook that cancels or lapses the subscription leaves a comp account on Max", async () => {
  const DAY = 86_400; const now = Math.floor(Date.now() / 1000);
  const providerSub = (userId, status, end) => ({
    id: `sub_${userId}`, status, customer: `cus_${userId}`, cancel_at_period_end: false, schedule: null, metadata: { userId },
    items: { data: [{ id: "si_1", price: { id: "price_plus", lookup_key: "vibhavgpt_plus_monthly" }, current_period_start: end - 30 * DAY, current_period_end: end }] },
  });
  await withComp(COMP, async () => {
    for (const userId of ["comp", "member2"]) {
      const cancelled = providerSub(userId, "canceled", now - DAY);
      await applySubscriptionEvent({ type: "customer.subscription.deleted", data: { object: { id: cancelled.id, metadata: { userId } } } }, { persist: (record) => saveSubscription(record, db), retrieveSubscription: async () => cancelled });
    }
    const { rows } = await client.query("SELECT user_id, status FROM subscriptions WHERE user_id IN ('comp', 'member2') ORDER BY user_id");
    assert.deepEqual(rows.map((r) => [r.user_id, r.status]), [["comp", "canceled"], ["member2", "canceled"]], "the webhook wrote what the provider said");
    assert.equal(tierForSubscription(await getActiveSubscription("comp", db)), "max", "the comp account is still Max");
    assert.equal(tierForSubscription(await getActiveSubscription("member2", db)), "free", "an ordinary account follows its subscription");
  });
});

// ---- Unlimited usage ----------------------------------------------------------------------------------------------------------

test("credits never decrement and never block for a comp account across settled paid turns; an ordinary account is limited", async () => {
  await withCredits(() => withComp(COMP, async () => {
    const before = await getCreditsSummary("comp", db);
    // A large settled spend: far beyond Max's monthly credits.
    for (let i = 0; i < 3; i += 1) {
      const event = await reserveUsage("comp", "vesper", "low", 2000, db, new Date());
      await finalizeUsage(event.id, { prompt_tokens: 4_000_000, completion_tokens: 4_000_000 }, db, "vesper");
    }
    const after = await getCreditsSummary("comp", db);
    assert.equal(after.complimentary, true);
    assert.deepEqual(after.balance, before.balance, "the balance did not move");
    assert.doesNotThrow(() => after);
    await assert.doesNotReject(() => reserveUsage("comp", "zenith", "low", 2000, db, new Date()), "still admitted, Zenith included");

    // The same spend on an ordinary Free account is refused once its credits are gone.
    const plain = await reserveUsage("member", "nova", "low", 2000, db, new Date());
    await finalizeUsage(plain.id, { prompt_tokens: 4_000_000, completion_tokens: 4_000_000 }, db, "nova");
    await assert.rejects(() => reserveUsage("member", "nova", "low", 2000, db, new Date()), (error) => /credit|allowance|quota/i.test(`${error.reason} ${error.code} ${error.message}`));
  }));
});

test("abuse protection is not bypassed: the chat burst and concurrency guard knows nothing about plans", () => {
  const guard = readFileSync("src/chat/abuse-guard.js", "utf8");
  assert.doesNotMatch(guard, /comp|complimentary|tier|plan/i);
  const capacity = readFileSync("src/chat/capacity.js", "utf8");
  assert.doesNotMatch(capacity, /compPlan|complimentary/);
});

// ---- The billing page ----------------------------------------------------------------------------------------------------------

async function billingSubscription(userId) {
  const layer = billingRouter.stack.find((l) => l.route?.path === "/subscription" && l.route.methods.get);
  const handler = layer.route.stack.at(-1).handle;
  let body = null;
  await handler({ authSession: { user: { id: userId } }, headers: {} }, { json: (value) => { body = value; return value; }, status() { return this; } }, (error) => { throw error; });
  return body;
}

test("the billing endpoint shows a comp account as Max, complimentary, with nothing to cancel; ordinary accounts are unchanged", async () => {
  await withComp(COMP, async () => {
    const comp = await billingSubscription("comp");
    assert.equal(comp.complimentary, true);
    assert.equal(comp.subscription.tier, "max");
    assert.equal(comp.subscription.billingSource, "complimentary");
    assert.deepEqual(COMPLIMENTARY_SUBSCRIPTION.tier, "max");
    const member = await billingSubscription("member");
    assert.equal(member.complimentary, false);
    assert.equal(member.subscription, null);
  });
  const app = readFileSync("frontend/src/App.jsx", "utf8");
  // The plans page takes the plan's source from the server (Part A: one source of truth for both surfaces).
  assert.match(app, /const complimentaryPlan = planSource === "complimentary";/);
  assert.match(app, /\{complimentaryPlan \? \(\s*<span className="subscription__note">Complimentary<\/span>/);
  assert.match(app, /\{!appSubscription && !complimentaryPlan && !grantedPlan && \(/, "no cancel or manage actions");
});

test("billing's paid-plan test agrees with the plan resolver for every tier, status and end date", async () => {
  const { paidPlanIsCurrent } = await import("../src/billing/comp-accounts.js");
  const at = new Date("2026-06-01T00:00:00.000Z");
  for (const tier of ["free", "plus", "pro", "max", "paid", "other"]) for (const status of ["active", "trialing", "canceled", "past_due", "incomplete"]) for (const end of [null, "2026-05-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"]) {
    const record = { tier, status, currentPeriodEndsAt: end };
    assert.equal(paidPlanIsCurrent(record, at), tierForSubscription(record, at) !== "free", JSON.stringify(record));
  }
  assert.equal(paidPlanIsCurrent(null), false);
});

test("the boot line reports a count, never an address", () => {
  const server = readFileSync("src/server.js", "utf8");
  assert.match(server, /console\.info\(JSON\.stringify\(\{ event: "comp_accounts", configured: compPlanAccountCount\(\) \}\)\);/);
});
