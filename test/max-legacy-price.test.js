// Max's price change (owner approval, 2026-11-15): new subscriptions are $49.99 a month and $499.90 a year. Subscriptions on the first
// prices ($50 / $500) keep them, and are still recognised as Max after the lookup keys moved to the new prices.
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";
const { billedTier, priceLookupKeyOf, LEGACY_PRICE_LOOKUP_KEYS } = await import("../src/billing/service.js");

const sub = (price) => ({ items: { data: [{ price }] } });

test("a subscription on Max's first prices is still Max, monthly and yearly, after their lookup keys moved", () => {
  assert.equal(billedTier(sub({ id: "price_1UZK0mEvJtB4KP3epmg81zGY", lookup_key: null, unit_amount: 5000 })), "max");
  assert.equal(billedTier(sub({ id: "price_1UZK0mEvJtB4KP3epTXokRWc", lookup_key: null, unit_amount: 50000 })), "max");
  assert.equal(priceLookupKeyOf({ id: "price_1UZK0mEvJtB4KP3epTXokRWc" }), "vibhavgpt_max_yearly", "so a plan change knows its interval");
  assert.equal(LEGACY_PRICE_LOOKUP_KEYS.size, 2);
});

test("a new price carries its own lookup key; an unknown price is no plan", () => {
  assert.equal(billedTier(sub({ id: "price_new_monthly", lookup_key: "vibhavgpt_max_monthly", unit_amount: 4999 })), "max");
  assert.equal(billedTier(sub({ id: "price_new_yearly", lookup_key: "vibhavgpt_max_yearly", unit_amount: 49990 })), "max");
  assert.equal(billedTier(sub({ id: "price_unknown", lookup_key: null })), null);
  assert.equal(priceLookupKeyOf(null), "");
});
