process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { config } = await import("../src/config.js");
const { createCheckoutSession, isMaxCheckoutConfigured, VALID_PRICE_LOOKUP_KEYS, tierForPriceLookupKey, billedTier } = await import("../src/billing/service.js");
const { buildProductKnowledgeAddendum, buildProductKnowledgeSystemPrompt, PRODUCT_KNOWLEDGE } = await import("../frontend/src/product-knowledge.js");

function withMaxPrice(t, value) {
  const original = config.stripeMaxPriceId;
  config.stripeMaxPriceId = value;
  t.after(() => { config.stripeMaxPriceId = original; });
}

test("Max checkout is authorized for release with annual and monthly billing", () => {
  assert.equal(isMaxCheckoutConfigured(), true);
  assert.equal(VALID_PRICE_LOOKUP_KEYS.has("vibhavgpt_max_monthly"), true);
  assert.equal(VALID_PRICE_LOOKUP_KEYS.has("vibhavgpt_max_yearly"), true);
  assert.equal(tierForPriceLookupKey("vibhavgpt_max_monthly"), "max");
  assert.equal(tierForPriceLookupKey("vibhavgpt_max_yearly"), "max");
});

test("Max checkout uses the explicitly configured price when STRIPE_PRICE_ID_MAX is set", async (t) => {
  withMaxPrice(t, "price_configured_max");
  assert.equal(isMaxCheckoutConfigured(), true);
  const retrieved = [];
  const stripe = {
    // A price as Stripe returns it. A configured id is used only when it is the active USD monthly price for this plan (test/checkout-price-guard.test.js).
    prices: { retrieve: async (id) => { retrieved.push(id); return { id, active: true, type: "recurring", currency: "usd", lookup_key: "vibhavgpt_max_monthly", recurring: { interval: "month", interval_count: 1 } }; }, list: async () => ({ data: [] }) },
    checkout: { sessions: { create: async (params) => ({ url: "https://checkout.test/session", params }) } },
    subscriptions: { list: async () => ({ data: [] }) },
  };
  const executor = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
  const url = await createCheckoutSession(
    { userId: "u_max", email: "max@example.com", priceLookupKey: "vibhavgpt_max_monthly", origin: "https://vibhavgpt.com" },
    { stripe, executor, getCustomer: async () => "cus_mock" },
  ).catch((error) => error);
  assert.deepEqual(retrieved, ["price_configured_max"]);
  assert.ok(!(url instanceof Error) || !/unavailable/.test(url.message), "configured Max must not be refused as unavailable");
});

test("Max annual checkout creates subscription session with annual lookup key", async () => {
  const createdSessions = [];
  const stripe = {
    prices: {
      retrieve: async () => null,
      list: async ({ lookup_keys }) => ({ data: [{ id: `price_for_${lookup_keys[0]}`, lookup_key: lookup_keys[0], active: true, type: "recurring", currency: "usd", recurring: { interval: lookup_keys[0].endsWith("yearly") ? "year" : "month", interval_count: 1 } }] }),
    },
    checkout: { sessions: { create: async (params) => { createdSessions.push(params); return { url: "https://checkout.test/annual-max" }; } } },
    subscriptions: { list: async () => ({ data: [] }) },
  };
  const executor = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
  const result = await createCheckoutSession(
    { userId: "u_max_annual", email: "max_annual@example.com", priceLookupKey: "vibhavgpt_max_yearly", origin: "https://vibhavgpt.com" },
    { stripe, executor, getCustomer: async () => "cus_mock" },
  ).catch((e) => e);
  assert.equal(result, "https://checkout.test/annual-max");
  assert.equal(createdSessions.length, 1);
  assert.equal(createdSessions[0].line_items[0].price, "price_for_vibhavgpt_max_yearly");
  assert.equal(createdSessions[0].mode, "subscription");
});

test("webhook and subscription mapping assigns Max tier for annual and monthly subscriptions", () => {
  const monthlySub = { items: { data: [{ price: { lookup_key: "vibhavgpt_max_monthly" } }] } };
  const yearlySub = { items: { data: [{ price: { lookup_key: "vibhavgpt_max_yearly" } }] } };
  assert.equal(billedTier(monthlySub), "max");
  assert.equal(billedTier(yearlySub), "max");
});

test("assistant product knowledge reflects Max annual pricing without internal cost language", () => {
  const maxPlan = PRODUCT_KNOWLEDGE.plans.find((p) => p.id === "max");
  assert.equal(maxPlan.monthly, "$49.99");
  assert.equal(maxPlan.yearly, "$499.90");
  assert.doesNotMatch(maxPlan.description, /\$30/);
  assert.doesNotMatch(maxPlan.description, /actual AI cost/i);

  const prompt = buildProductKnowledgeSystemPrompt({ maxAvailable: true });
  assert.doesNotMatch(prompt, /null/);
  assert.match(prompt, /Max: web \$49\.99\/month or \$499\.90\/year/);
  assert.doesNotMatch(prompt, /Max is not available to purchase yet\./);
  assert.match(prompt, /Plus: web \$4\.99\/month or \$49\.99\/year/);

  const addendum = buildProductKnowledgeAddendum("What does VibhavGPT Max cost compared with Pro?", { maxAvailable: true });
  assert.match(addendum, /Max: \$49\.99\/month or \$499\.90\/year on the web/);
  assert.doesNotMatch(addendum, /Max is not available to purchase yet\./);
});

test("billing UI and router integrate Max availability and annual checkout key", async () => {
  const app = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /const \[maxAvailable, setMaxAvailable\] = useState\((?:false|publicPreview \? true : false)\);/);
  assert.match(app, /setMaxAvailable\(maxReady === true\)/);
  assert.match(app, /priceLookupKey = `vibhavgpt_\$\{planId\}_\$\{annual \? "yearly" : "monthly"\}`/);
  const router = await readFile(new URL("../src/billing/router.js", import.meta.url), "utf8");
  assert.match(router, /maxAvailable: isMaxCheckoutConfigured\(\)/);
  const chat = await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8");
  // maxAvailable still comes from the checkout configuration; the call also carries the active credits mode.
  assert.match(chat, /buildProductKnowledgeSystemPrompt\(\{ maxAvailable: isMaxCheckoutConfigured\(\)(?:, creditsMode: creditsKnowledgeMode\(\))? \}\)/);
});
