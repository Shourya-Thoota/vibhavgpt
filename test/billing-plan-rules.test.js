import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// The real billing service against an in-memory database and a fake payment
// provider. Nothing here reaches the live provider.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { config } = await import("../src/config.js");
config.databaseUrl ||= process.env.DATABASE_URL;
const {
  applySubscriptionEvent, changeSubscriptionPlan, createCheckoutSession, saveSubscription, subscriptionRecordFor, DOWNGRADE_PAUSED, CHECKOUT_TEXT,
} = await import("../src/billing/service.js");

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

function providerSubscription({ id = "sub_1", status = "active", key = "vibhavgpt_plus_monthly", userId = "member", cancel = false, end = now() + 20 * DAY, metadata } = {}) {
  return {
    id, status, customer: "cus_member", cancel_at_period_end: cancel, schedule: null,
    metadata: metadata ?? { userId },
    items: { data: [{ id: "si_1", price: key === null ? { id: "price_unknown", lookup_key: null } : { id: `price_${key}`, lookup_key: key }, current_period_start: end - 30 * DAY, current_period_end: end }] },
  };
}

// The provider as these tests see it: one subscription that changes only
// when the test says the provider applied a change.
function fakeProvider(subscription, { history = [] } = {}) {
  const calls = [];
  let current = subscription;
  return {
    calls,
    apply(next) { current = next; },
    retrieve: async (id) => { calls.push(["retrieve", id]); return structuredClone({ ...current, id }); },
    client: {
      subscriptions: {
        retrieve: async (id) => { calls.push(["retrieve", id]); return structuredClone(current); },
        update: async (id, params) => { calls.push(["update", id, params]); return structuredClone(current); },
        list: async (query) => { calls.push(["list", query]); return { data: history }; },
        search: async (query) => { calls.push(["search", query]); return { data: [] }; },
      },
      prices: { list: async ({ lookup_keys: [key] }) => ({ data: [{ id: `price_${key}`, lookup_key: key }] }) },
      checkout: { sessions: { create: async (params) => { calls.push(["checkout", params]); return { url: "https://checkout.example.test" }; } } },
    },
  };
}

async function database(t) {
  const client = new PGlite();
  t.after(() => client.close());
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return { client, db: drizzle(client) };
}

async function seedRow(db, subscription) {
  await saveSubscription(subscriptionRecordFor(subscription, subscription.metadata.userId), db);
}

async function row(client, userId = "member") {
  const { rows: [r] } = await client.query("SELECT tier, status, subscription_id, current_period_ends_at FROM subscriptions WHERE user_id = $1", [userId]);
  return r;
}

const updatedEvent = (id = "sub_1", payload = {}) => ({ type: "customer.subscription.updated", data: { object: { id, metadata: { userId: "member" }, ...payload } } });

test("Plus to Pro is invoiced first, writes no tier, and Pro arrives only with the paid webhook", async (t) => {
  const { client, db } = await database(t);
  const provider = fakeProvider(providerSubscription());
  await seedRow(db, providerSubscription());
  const result = await changeSubscriptionPlan({ userId: "member", priceLookupKey: "vibhavgpt_pro_monthly" }, { stripe: provider.client, executor: db });
  assert.deepEqual(result, { pending: true });
  const [, , params] = provider.calls.find(([name]) => name === "update");
  assert.deepEqual(params, { items: [{ id: "si_1", price: "price_vibhavgpt_pro_monthly" }], proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete" });
  assert.equal((await row(client)).tier, "plus", "the change-plan call writes no tier");

  // The provider charges the difference and then applies the new price.
  provider.apply(providerSubscription({ key: "vibhavgpt_pro_monthly" }));
  await applySubscriptionEvent(updatedEvent(), { persist: (r) => saveSubscription(r, db), retrieveSubscription: provider.retrieve });
  assert.equal((await row(client)).tier, "pro");
  // A paid invoice event reaches the same state.
  await applySubscriptionEvent({ type: "invoice.paid", data: { object: { parent: { subscription_details: { subscription: "sub_1", metadata: { userId: "member" } } } } } }, { persist: (r) => saveSubscription(r, db), retrieveSubscription: provider.retrieve });
  assert.equal((await row(client)).tier, "pro");
});

test("a declined upgrade charge leaves the tier unchanged", async (t) => {
  const { client, db } = await database(t);
  const provider = fakeProvider(providerSubscription());
  await seedRow(db, providerSubscription());
  await changeSubscriptionPlan({ userId: "member", priceLookupKey: "vibhavgpt_pro_yearly" }, { stripe: provider.client, executor: db });
  // pending_if_incomplete: the charge failed, so the provider keeps the old price.
  provider.apply({ ...providerSubscription(), pending_update: { subscription_items: [{ price: { lookup_key: "vibhavgpt_pro_yearly" } }] } });
  await applySubscriptionEvent(updatedEvent(), { persist: (r) => saveSubscription(r, db), retrieveSubscription: provider.retrieve });
  await applySubscriptionEvent({ type: "invoice.payment_failed", data: { object: { subscription: "sub_1" } } }, { persist: (r) => saveSubscription(r, db), retrieveSubscription: provider.retrieve });
  assert.equal((await row(client)).tier, "plus");
});

test("a forged request or forged metadata cannot grant a tier", async (t) => {
  const { client, db } = await database(t);
  const provider = fakeProvider(providerSubscription());
  await seedRow(db, providerSubscription());
  for (const priceLookupKey of ["forged-pro", "vibhavgpt_team_monthly", "", undefined]) {
    await assert.rejects(changeSubscriptionPlan({ userId: "member", priceLookupKey }, { stripe: provider.client, executor: db }), /Invalid price selection/);
  }
  assert.ok(!provider.calls.some(([name]) => name === "update"), "no provider change for a forged price");
  // Metadata and the event's own copy both claim Pro; the billed price is Plus.
  provider.apply(providerSubscription({ metadata: { userId: "member", tier: "pro" } }));
  await applySubscriptionEvent(updatedEvent("sub_1", { status: "active", metadata: { userId: "member", tier: "pro" }, items: { data: [{ price: { lookup_key: "vibhavgpt_pro_monthly" } }] } }), { persist: (r) => saveSubscription(r, db), retrieveSubscription: provider.retrieve });
  assert.equal((await row(client)).tier, "plus");
});

test("a missing or unknown price grants nothing and never defaults to Pro", async () => {
  for (const key of [null, "vibhavgpt_team_monthly", "other_product"]) {
    const records = [];
    const subscription = providerSubscription({ key });
    for (const event of [updatedEvent(), { type: "checkout.session.completed", data: { object: { subscription: "sub_1", client_reference_id: "member", metadata: { userId: "member", tier: "pro" } } } }]) {
      await applySubscriptionEvent(event, { persist: async (r) => records.push(r), retrieveSubscription: async () => subscription });
    }
    assert.deepEqual(records.map((r) => r.tier), ["free", "free"], String(key));
  }
  assert.equal(subscriptionRecordFor({ ...providerSubscription(), items: { data: [] } }, "member").tier, "free");
});

test("downgrades stay paused, so up-and-down cycling cannot give Pro for the Plus price", async (t) => {
  const { client, db } = await database(t);
  for (const [from, to] of [["vibhavgpt_pro_monthly", "vibhavgpt_plus_monthly"], ["vibhavgpt_pro_yearly", "vibhavgpt_plus_yearly"], ["vibhavgpt_pro_yearly", "vibhavgpt_pro_monthly"], ["vibhavgpt_plus_yearly", "vibhavgpt_plus_monthly"]]) {
    const provider = fakeProvider(providerSubscription({ key: from }));
    await seedRow(db, providerSubscription({ key: from }));
    await assert.rejects(changeSubscriptionPlan({ userId: "member", priceLookupKey: to }, { stripe: provider.client, executor: db }), (error) => error.code === DOWNGRADE_PAUSED, `${from} -> ${to}`);
    assert.ok(!provider.calls.some(([name]) => name === "update"), "the provider subscription is not touched");
  }
  // Every way up from Plus is invoiced on the spot; none is free.
  for (const to of ["vibhavgpt_pro_monthly", "vibhavgpt_pro_yearly", "vibhavgpt_plus_yearly"]) {
    const provider = fakeProvider(providerSubscription());
    await seedRow(db, providerSubscription());
    await changeSubscriptionPlan({ userId: "member", priceLookupKey: to }, { stripe: provider.client, executor: db });
    const [, , params] = provider.calls.find(([name]) => name === "update");
    assert.equal(params.proration_behavior, "always_invoice", to);
    assert.equal(params.payment_behavior, "pending_if_incomplete", to);
  }
  assert.equal((await row(client)).tier, "plus");
});

test("monthly to yearly changes the plan only after the invoice is paid", async (t) => {
  const { client, db } = await database(t);
  const monthly = providerSubscription({ end: now() + 10 * DAY });
  const provider = fakeProvider(monthly);
  await seedRow(db, monthly);
  const before = await row(client);
  await changeSubscriptionPlan({ userId: "member", priceLookupKey: "vibhavgpt_pro_yearly" }, { stripe: provider.client, executor: db });
  assert.deepEqual(await row(client), before, "nothing local changes on the request");
  provider.apply(providerSubscription({ key: "vibhavgpt_pro_yearly", end: now() + 365 * DAY }));
  await applySubscriptionEvent(updatedEvent(), { persist: (r) => saveSubscription(r, db), retrieveSubscription: provider.retrieve });
  const after = await row(client);
  assert.equal(after.tier, "pro");
  assert.ok(new Date(after.current_period_ends_at) > new Date(Date.now() + 300 * DAY * 1000), "the yearly period comes from the provider");
});

test("a trialing upgrade keeps the trial and is billed at the new price when it ends", async (t) => {
  const { client, db } = await database(t);
  const trial = providerSubscription({ status: "trialing", end: now() + 5 * DAY });
  const provider = fakeProvider(trial);
  await seedRow(db, trial);
  assert.deepEqual(await changeSubscriptionPlan({ userId: "member", priceLookupKey: "vibhavgpt_pro_monthly" }, { stripe: provider.client, executor: db }), { pending: true, trialing: true });
  const [, , params] = provider.calls.find(([name]) => name === "update");
  assert.deepEqual(params, { items: [{ id: "si_1", price: "price_vibhavgpt_pro_monthly" }], proration_behavior: "none" });
  assert.equal((await row(client)).tier, "plus", "no local tier from the request");
  provider.apply(providerSubscription({ status: "trialing", key: "vibhavgpt_pro_monthly", end: now() + 5 * DAY }));
  await applySubscriptionEvent(updatedEvent(), { persist: (r) => saveSubscription(r, db), retrieveSubscription: provider.retrieve });
  assert.deepEqual([(await row(client)).tier, (await row(client)).status], ["pro", "trialing"]);
});

test("plans set to end, or already chosen, are not changed", async (t) => {
  const { db } = await database(t);
  const ending = fakeProvider(providerSubscription({ cancel: true }));
  await seedRow(db, providerSubscription({ cancel: true }));
  await assert.rejects(changeSubscriptionPlan({ userId: "member", priceLookupKey: "vibhavgpt_pro_monthly" }, { stripe: ending.client, executor: db }), (e) => e.code === "plan-ending");
  const same = fakeProvider(providerSubscription());
  await assert.rejects(changeSubscriptionPlan({ userId: "member", priceLookupKey: "vibhavgpt_plus_monthly" }, { stripe: same.client, executor: db }), (e) => e.code === "already-on-plan");
  for (const provider of [ending, same]) assert.ok(!provider.calls.some(([name]) => name === "update"));
});

test("Free to Plus and Free to Pro checkout reuse the customer, and a trial is given only once", async (t) => {
  const { client, db } = await database(t);
  const getCustomer = async () => "cus_member";
  for (const priceLookupKey of ["vibhavgpt_plus_monthly", "vibhavgpt_pro_monthly"]) {
    const provider = fakeProvider(providerSubscription());
    await createCheckoutSession({ userId: `new-${priceLookupKey}`, email: "member@example.invalid", priceLookupKey, origin: "https://vibhavgpt.com" }, { stripe: provider.client, executor: db, getCustomer });
    const [, params] = provider.calls.find(([name]) => name === "checkout");
    assert.equal(params.customer, "cus_member");
    assert.equal("customer_email" in params, false);
    assert.equal(params.subscription_data.trial_period_days, 7, "a first subscription gets the trial");
    assert.deepEqual(params.subscription_data.metadata, { userId: `new-${priceLookupKey}` }, "no tier in metadata");
  }
  // A second trial is refused: an earlier subscription row, or provider history.
  await client.query("INSERT INTO subscriptions (user_id, subscription_id, tier, status) VALUES ('returning', 'sub_old', 'free', 'canceled')");
  const returning = fakeProvider(providerSubscription());
  await createCheckoutSession({ userId: "returning", email: "member@example.invalid", priceLookupKey: "vibhavgpt_plus_monthly", origin: "https://vibhavgpt.com" }, { stripe: returning.client, executor: db, getCustomer });
  assert.equal("trial_period_days" in returning.calls.find(([name]) => name === "checkout")[1].subscription_data, false);
  const withHistory = fakeProvider(providerSubscription(), { history: [{ id: "sub_earlier", status: "canceled" }] });
  await createCheckoutSession({ userId: "no-local-row", email: "member@example.invalid", priceLookupKey: "vibhavgpt_pro_monthly", origin: "https://vibhavgpt.com" }, { stripe: withHistory.client, executor: db, getCustomer });
  assert.equal("trial_period_days" in withHistory.calls.find(([name]) => name === "checkout")[1].subscription_data, false);

  // The completed checkout grants the tier from the subscription the provider created.
  for (const [key, status, tier] of [["vibhavgpt_plus_monthly", "trialing", "plus"], ["vibhavgpt_pro_monthly", "active", "pro"], ["vibhavgpt_pro_monthly", "incomplete", "free"]]) {
    const records = [];
    await applySubscriptionEvent({ type: "checkout.session.completed", data: { object: { subscription: "sub_new", client_reference_id: "member", metadata: { userId: "member" } } } },
      { persist: async (r) => records.push(r), retrieveSubscription: async () => providerSubscription({ id: "sub_new", key, status }) });
    assert.equal(records[0].tier, tier, `${key} ${status}`);
  }
});

test("replayed and out-of-order webhook events cannot raise a tier or end the current plan", async (t) => {
  const { client, db } = await database(t);
  const persist = (r) => saveSubscription(r, db);
  // The account moved from an old subscription to a new Pro one.
  await seedRow(db, providerSubscription({ id: "sub_new", key: "vibhavgpt_pro_monthly" }));
  // A late event about the old, canceled subscription arrives afterwards.
  await applySubscriptionEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_old", metadata: { userId: "member" } } } },
    { persist, retrieveSubscription: async () => providerSubscription({ id: "sub_old", status: "canceled" }) });
  assert.deepEqual([(await row(client)).subscription_id, (await row(client)).tier], ["sub_new", "pro"], "the current plan is untouched");

  // An old event whose payload says Pro is replayed after the provider moved the plan back to Plus.
  await seedRow(db, providerSubscription({ id: "sub_new" }));
  const provider = fakeProvider(providerSubscription({ id: "sub_new" }));
  const stale = updatedEvent("sub_new", { status: "active", items: { data: [{ price: { lookup_key: "vibhavgpt_pro_monthly" } }] } });
  for (let replay = 0; replay < 3; replay += 1) await applySubscriptionEvent(stale, { persist, retrieveSubscription: provider.retrieve });
  assert.equal((await row(client)).tier, "plus", "replays re-apply the provider's current state, never the payload");
});

test("subscription Checkout shows trial or non-trial notes and changes nothing else", async (t) => {
  const { client, db } = await database(t);
  const getCustomer = async () => "cus_member";
  const baseUrl = config.clientOrigins.includes("https://vibhavgpt.com") ? "https://vibhavgpt.com" : config.clientOrigins[0];
  // Every field but custom_text, exactly as it was before the notes were added.
  const expected = (userId, trial) => ({
    mode: "subscription",
    line_items: [{ price: "price_vibhavgpt_plus_monthly", quantity: 1 }],
    customer: "cus_member",
    client_reference_id: userId,
    subscription_data: { ...(trial ? { trial_period_days: 7 } : {}), metadata: { userId } },
    metadata: { userId },
    success_url: `${baseUrl}/account?upgraded=true`,
    cancel_url: `${baseUrl}/account`,
  });

  const first = fakeProvider(providerSubscription());
  await createCheckoutSession({ userId: "first", email: "member@example.invalid", priceLookupKey: "vibhavgpt_plus_monthly", origin: "https://vibhavgpt.com" }, { stripe: first.client, executor: db, getCustomer });
  const { custom_text: trialText, ...trialRest } = first.calls.find(([name]) => name === "checkout")[1];
  assert.deepEqual(trialText, CHECKOUT_TEXT.trial);
  assert.deepEqual(trialRest, expected("first", true));

  await client.query("INSERT INTO subscriptions (user_id, subscription_id, tier, status) VALUES ('again', 'sub_old', 'free', 'canceled')");
  const again = fakeProvider(providerSubscription());
  await createCheckoutSession({ userId: "again", email: "member@example.invalid", priceLookupKey: "vibhavgpt_plus_monthly", origin: "https://vibhavgpt.com" }, { stripe: again.client, executor: db, getCustomer });
  const { custom_text: paidText, ...paidRest } = again.calls.find(([name]) => name === "checkout")[1];
  assert.deepEqual(paidText, CHECKOUT_TEXT.paid);
  assert.deepEqual(paidRest, expected("again", false));

  assert.notEqual(trialText.submit.message, paidText.submit.message, "the trial and non-trial notes differ");
  assert.match(trialText.submit.message, /7-day/);
  assert.doesNotMatch(paidText.submit.message, /trial/i);
});

test("Checkout notes are short, plain, and promise nothing the Terms do not", () => {
  for (const [variant, text] of Object.entries(CHECKOUT_TEXT)) {
    assert.deepEqual(Object.keys(text).sort(), ["after_submit", "submit"], variant);
    assert.equal("terms_of_service_acceptance" in text, false, variant);
    for (const [slot, { message }] of Object.entries(text)) {
      const label = `${variant}.${slot}`;
      assert.ok(message.length > 0 && message.length <= 300, `${label} is ${message.length} characters`);
      assert.doesNotMatch(message, /\u2014|\u2013|!/, `${label} has no dashes or exclamation marks`);
      assert.doesNotMatch(message, /refund|uptime|never expire|do not expire|seamless|unlock|elevate|supercharge|leverage|delve|game-changer|journey/i, label);
      assert.match(message, /VibhavGPT|vibhavgpt\.com/, `${label} names the product`);
    }
  }
});
