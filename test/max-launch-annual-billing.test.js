process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { config } = await import("../src/config.js");
const {
  createCheckoutSession,
  isMaxCheckoutConfigured,
  VALID_PRICE_LOOKUP_KEYS,
  tierForPriceLookupKey,
  billedTier,
  subscriptionRecordFor,
  applySubscriptionEvent,
  changeSubscriptionPlan,
  cancelSubscriptionForUser,
  DOWNGRADE_PAUSED,
} = await import("../src/billing/service.js");

const {
  MONTHLY_CREDITS,
  typicalWeeklyAllocation,
  allocationSchedule,
  computeCreditBalance,
  CARRY_MODES,
} = await import("../frontend/src/credits-policy.js");

const {
  monthlyEntitlementPeriodStart,
  monthlyEntitlementPeriodEnd,
  assertModelPlanAccess,
  tierForSubscription,
  GENERATION_LIMITS,
  VOICE_LIMITS,
} = await import("../src/usage/service.js");

const { PRODUCT_KNOWLEDGE, productKnowledgeFor } = await import("../frontend/src/product-knowledge.js");
const { COMPARISON_GROUPS, comparisonGroupsFor, monthlyEquivalent, yearlySaving } = await import("../frontend/src/plan-comparison.js");
const { evaluateModelPlanLock } = await import("../frontend/src/components/catalog/catalog-adapter.js");

test("Max approved prices and lookup keys are valid and mapped to max tier", () => {
  assert.equal(isMaxCheckoutConfigured(), true);
  assert.equal(VALID_PRICE_LOOKUP_KEYS.has("vibhavgpt_max_monthly"), true);
  assert.equal(VALID_PRICE_LOOKUP_KEYS.has("vibhavgpt_max_yearly"), true);
  assert.equal(tierForPriceLookupKey("vibhavgpt_max_monthly"), "max");
  assert.equal(tierForPriceLookupKey("vibhavgpt_max_yearly"), "max");
  assert.equal(tierForPriceLookupKey("vibhavgpt_invalid_plan"), null);
});

test("Max monthly and annual checkout select the intended price without trial", async () => {
  const sessions = [];
  const stripe = {
    prices: {
      retrieve: async (id) => ({ id, unit_amount: id.includes("yearly") ? 50000 : 5000 }),
      list: async ({ lookup_keys }) => ({
        data: [{
          id: `price_for_${lookup_keys[0]}`, lookup_key: lookup_keys[0], unit_amount: lookup_keys[0].endsWith("yearly") ? 50000 : 5000,
          active: true, type: "recurring", currency: "usd", recurring: { interval: lookup_keys[0].endsWith("yearly") ? "year" : "month", interval_count: 1 },
        }],
      }),
    },
    checkout: {
      sessions: {
        create: async (params) => {
          sessions.push(params);
          return { url: `https://checkout.test/${params.line_items[0].price}` };
        },
      },
    },
    subscriptions: { list: async () => ({ data: [] }) },
  };
  const executor = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };

  // 1. Monthly checkout
  const monthlyUrl = await createCheckoutSession(
    { userId: "user_monthly", email: "m@example.com", priceLookupKey: "vibhavgpt_max_monthly", origin: "https://vibhavgpt.com" },
    { stripe, executor, getCustomer: async () => "cus_m" },
  );
  assert.equal(monthlyUrl, "https://checkout.test/price_for_vibhavgpt_max_monthly");
  assert.equal(sessions[0].mode, "subscription");
  assert.equal(sessions[0].subscription_data.trial_period_days, undefined, "Max checkout must not grant 7-day trial");

  // 2. Annual checkout
  const annualUrl = await createCheckoutSession(
    { userId: "user_annual", email: "a@example.com", priceLookupKey: "vibhavgpt_max_yearly", origin: "https://vibhavgpt.com" },
    { stripe, executor, getCustomer: async () => "cus_a" },
  );
  assert.equal(annualUrl, "https://checkout.test/price_for_vibhavgpt_max_yearly");
  assert.equal(sessions[1].line_items[0].price, "price_for_vibhavgpt_max_yearly");
  assert.equal(sessions[1].subscription_data.trial_period_days, undefined, "Max annual checkout must not grant 7-day trial");
});

test("checkout rejects invalid or mismatched price lookup keys", async () => {
  const stripe = {
    prices: { list: async () => ({ data: [] }) },
    subscriptions: { list: async () => ({ data: [] }) },
  };
  const executor = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };

  await assert.rejects(
    () => createCheckoutSession(
      { userId: "u", email: "u@example.com", priceLookupKey: "vibhavgpt_fake_plan", origin: "https://vibhavgpt.com" },
      { stripe, executor, getCustomer: async () => "cus_1" },
    ),
    /Invalid price selection/,
  );

  await assert.rejects(
    () => createCheckoutSession(
      { userId: "u", email: "u@example.com", priceLookupKey: "vibhavgpt_plus_monthly", origin: "https://vibhavgpt.com" },
      { stripe, executor, getCustomer: async () => "cus_1" },
    ),
    /The selected plan is unavailable/,
  );
});

test("webhook and subscription record mapping assigns Max for monthly and annual events", () => {
  const monthlySub = {
    id: "sub_max_m",
    customer: "cus_m",
    status: "active",
    items: { data: [{ price: { id: "p_max_m", lookup_key: "vibhavgpt_max_monthly" }, current_period_start: 1700000000, current_period_end: 1702592000 }] },
  };
  assert.equal(billedTier(monthlySub), "max");
  const recordM = subscriptionRecordFor(monthlySub, "user_m");
  assert.equal(recordM.tier, "max");
  assert.equal(recordM.status, "active");
  assert.equal(recordM.subscriptionId, "sub_max_m");

  const yearlySub = {
    id: "sub_max_y",
    customer: "cus_y",
    status: "active",
    items: { data: [{ price: { id: "p_max_y", lookup_key: "vibhavgpt_max_yearly" }, current_period_start: 1700000000, current_period_end: 1731592000 }] },
  };
  assert.equal(billedTier(yearlySub), "max");
  const recordY = subscriptionRecordFor(yearlySub, "user_y");
  assert.equal(recordY.tier, "max");
  assert.equal(recordY.status, "active");
  assert.equal(recordY.subscriptionId, "sub_max_y");
});

test("webhook idempotency and duplicate event handling", async () => {
  const persisted = [];
  const event = {
    id: "evt_test_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_max_event",
        metadata: { userId: "user_event" },
      },
    },
  };

  const retrieveSubscription = async () => ({
    id: "sub_max_event",
    customer: "cus_ev",
    status: "active",
    metadata: { userId: "user_event" },
    items: { data: [{ price: { lookup_key: "vibhavgpt_max_yearly" } }] },
  });

  const persist = async (rec) => {
    persisted.push(rec);
    return true;
  };

  // First application
  const res1 = await applySubscriptionEvent(event, { persist, retrieveSubscription });
  assert.equal(res1, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].tier, "max");

  // Duplicate / replayed event
  const res2 = await applySubscriptionEvent(event, { persist, retrieveSubscription });
  assert.equal(res2, true);
  assert.equal(persisted.length, 2);
  assert.equal(persisted[1].tier, "max");
});

test("plan changes: upgrading to Max succeeds, downgrading from Max is paused", async () => {
  const updated = [];
  const stripe = {
    subscriptions: {
      retrieve: async () => ({
        id: "sub_curr",
        status: "active",
        items: { data: [{ id: "si_1", price: { lookup_key: "vibhavgpt_pro_monthly" } }] },
      }),
      update: async (id, params) => {
        updated.push({ id, params });
        return { id, ...params };
      },
    },
    prices: {
      list: async ({ lookup_keys }) => ({ data: [{ id: `price_${lookup_keys[0]}`, lookup_key: lookup_keys[0], active: true, type: "recurring", currency: "usd", recurring: { interval: lookup_keys[0].endsWith("yearly") ? "year" : "month", interval_count: 1 } }] }),
    },
  };
  const executor = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ userId: "u_upgrade", subscriptionId: "sub_curr", billingSource: "stripe", tier: "pro", status: "active" }],
        }),
      }),
    }),
  };

  // Upgrade Pro -> Max
  const result = await changeSubscriptionPlan({ userId: "u_upgrade", priceLookupKey: "vibhavgpt_max_monthly" }, { stripe, executor });
  assert.deepEqual(result, { pending: true });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].params.items[0].price, "price_vibhavgpt_max_monthly");
  assert.equal(updated[0].params.proration_behavior, "always_invoice");

  // Downgrade Max -> Pro is paused
  const stripeMax = {
    subscriptions: {
      retrieve: async () => ({
        id: "sub_max",
        status: "active",
        items: { data: [{ id: "si_max", price: { lookup_key: "vibhavgpt_max_monthly" } }] },
      }),
    },
  };
  const executorMax = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ userId: "u_max", subscriptionId: "sub_max", billingSource: "stripe", tier: "max", status: "active" }],
        }),
      }),
    }),
  };

  await assert.rejects(
    () => changeSubscriptionPlan({ userId: "u_max", priceLookupKey: "vibhavgpt_pro_monthly" }, { stripe: stripeMax, executor: executorMax }),
    (err) => err.code === DOWNGRADE_PAUSED,
  );
});

test("cancellation marks cancel_at_period_end under existing rules", async () => {
  let cancelCalled = false;
  const stripe = {
    subscriptions: {
      update: async (id, params) => {
        if (params.cancel_at_period_end) cancelCalled = true;
        return { id, status: "active", cancel_at_period_end: true, current_period_end: 1750000000 };
      },
    },
  };
  const txMock = {
    execute: async () => {},
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "rec_1", userId: "u_cancel" }] }) }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  const executor = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ userId: "u_cancel", subscriptionId: "sub_can", billingSource: "stripe", tier: "max", status: "active" }] }) }) }),
    transaction: async (cb) => cb(txMock),
  };

  const res = await cancelSubscriptionForUser("u_cancel", { stripe, executor });
  assert.equal(cancelCalled, true);
  assert.equal(res.cancelAtPeriodEnd, true);
});

test("monthly entitlements throughout an annual subscription step month by month", () => {
  // Annual subscription anchored on Jan 15, 2026
  const subscription = {
    currentPeriodStartedAt: new Date(Date.UTC(2026, 0, 15, 12, 0, 0)),
    tier: "max",
    status: "active",
  };

  // Month 1: Jan 20, 2026
  const jan20 = new Date(Date.UTC(2026, 0, 20, 12, 0, 0));
  const start1 = monthlyEntitlementPeriodStart(subscription, jan20);
  const end1 = monthlyEntitlementPeriodEnd(subscription, jan20);
  assert.equal(start1.toISOString(), "2026-01-15T12:00:00.000Z");
  assert.equal(end1.toISOString(), "2026-02-15T12:00:00.000Z");

  // Month 2: Feb 20, 2026 (stepping without an annual renewal webhook!)
  const feb20 = new Date(Date.UTC(2026, 1, 20, 12, 0, 0));
  const start2 = monthlyEntitlementPeriodStart(subscription, feb20);
  const end2 = monthlyEntitlementPeriodEnd(subscription, feb20);
  assert.equal(start2.toISOString(), "2026-02-15T12:00:00.000Z");
  assert.equal(end2.toISOString(), "2026-03-15T12:00:00.000Z");

  // Month 6: Jul 10, 2026
  const jul10 = new Date(Date.UTC(2026, 6, 10, 12, 0, 0));
  const start6 = monthlyEntitlementPeriodStart(subscription, jul10);
  const end6 = monthlyEntitlementPeriodEnd(subscription, jul10);
  assert.equal(start6.toISOString(), "2026-06-15T12:00:00.000Z");
  assert.equal(end6.toISOString(), "2026-07-15T12:00:00.000Z");
});

test("weekly allocation and carry behavior for Max (800 monthly credits)", () => {
  assert.equal(MONTHLY_CREDITS.max, 800);
  const weekly = typicalWeeklyAllocation("max");
  assert.deepEqual(weekly, [187, 187, 187, 187, 52]);
  assert.equal(weekly.reduce((a, b) => a + b, 0), 800);

  // Carry mode verification: unused credits carry forward within the month
  const periodStart = new Date(Date.UTC(2026, 3, 1, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(2026, 4, 1, 0, 0, 0));
  const schedule = allocationSchedule({ periodStart, periodEnd, monthlyCredits: 800 });
  assert.equal(schedule.monthlyCredits, 800);
  assert.equal(schedule.windows.reduce((a, b) => a + b.credits, 0), 800);

  // In week 2 (day 10), spend 50 credits from week 1 (allocation 187)
  const nowWeek2 = new Date(Date.UTC(2026, 3, 10, 0, 0, 0));
  const spentByWindowMicros = [50 * 50_000, 0, 0, 0, 0];
  const balanceCarry = computeCreditBalance({ schedule, now: nowWeek2, carryMode: CARRY_MODES.CARRY, spentByWindowMicros });
  assert.equal(balanceCarry.allocatedToDateMicros, 18_700_000);
  assert.equal(balanceCarry.carriedInMicros, 6_850_000);
  assert.equal(balanceCarry.availableMicros, 16_200_000);
  assert.equal(balanceCarry.headroomMicros, 16_200_000);
});

test("pricing UI, numeric Max allowances, and Upgrade labels", async () => {
  // 1. Comparison table numeric values
  const groups = comparisonGroupsFor(null);
  const fileGroup = groups.find((g) => g.title === "Files");
  const docRow = fileGroup.rows.find((r) => r.label === "Document uploads");
  const imgRow = fileGroup.rows.find((r) => r.label === "Image uploads");
  assert.equal(docRow.values[3], "80 MB");
  assert.equal(imgRow.values[3], "20 MB");

  const makeGroup = groups.find((g) => g.title === "Making things");
  const imgGenRow = makeGroup.rows.find((r) => r.label === "Image generations");
  assert.equal(imgGenRow.values[3], "1,500 per month");

  // 2. Credits allowance values
  const creditGroups = comparisonGroupsFor("carry");
  const allowGroup = creditGroups.find((g) => g.title === "Monthly allowance");
  assert.equal(allowGroup.rows[0].values[3], "800");
  assert.equal(allowGroup.rows[1].values[3], "About 187 credits a week");

  // 3. UI App.jsx checks: Upgrade button label and no "Set at launch"
  const appSrc = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(appSrc, /Set at launch/);
  assert.match(appSrc, /TIER_LABEL = \{ free: "Free", plus: "Plus", pro: "Pro", max: "Max" \}/);
  assert.match(appSrc, /isDowngrade \? \(plan\.id === "pro" \? "Move to Pro" : "Move to Plus"\) : "Upgrade"/);
  // Slice 7: the picker's lock copy comes from the shared lineup.
  const { HOUSE_PLAN_COPY } = await import("../frontend/src/model-marketplace.js");
  assert.equal(HOUSE_PLAN_COPY.vesper, "Available with Pro or Max.");
  assert.match(appSrc, /HOUSE_PLAN_COPY\[entry\.value\]/);

  // 4. Yearly price helpers for Max
  assert.equal(monthlyEquivalent("$500"), "$41.67");
  assert.equal(yearlySaving("$50", "$500"), 17);
});

test("model eligibility and access: Vulcan allowed on Pro and Max, forbidden on Free and Plus", () => {
  // assertModelPlanAccess
  assert.doesNotThrow(() => assertModelPlanAccess("max", "vesper"));
  assert.doesNotThrow(() => assertModelPlanAccess("pro", "vesper"));
  assert.throws(() => assertModelPlanAccess("free", "vesper"), (err) => err.requiredPlan === "Pro or Max");
  assert.throws(() => assertModelPlanAccess("plus", "vesper"), (err) => err.requiredPlan === "Pro or Max");

  // evaluateModelPlanLock (catalog adapter)
  const vesperFixture = { planEligibility: "pro_only", rawPricing: { consumptionCategory: "flagship", calculatedMu: 6.0 }, privacyReview: { privacyApproved: true } };
  assert.equal(evaluateModelPlanLock(vesperFixture, "max").locked, false);
  assert.equal(evaluateModelPlanLock(vesperFixture, "pro").locked, false);
  assert.equal(evaluateModelPlanLock(vesperFixture, "plus").locked, true);
  assert.equal(evaluateModelPlanLock(vesperFixture, "free").locked, true);

  // Free and Plus regression check: Nebula
  assert.doesNotThrow(() => assertModelPlanAccess("max", "nebula"));
  assert.doesNotThrow(() => assertModelPlanAccess("pro", "nebula"));
  assert.doesNotThrow(() => assertModelPlanAccess("plus", "nebula"));
  assert.throws(() => assertModelPlanAccess("free", "nebula"), (err) => err.requiredPlan === "Plus, Pro, or Max");
});
