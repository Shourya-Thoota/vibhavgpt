import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionSummary } from "../frontend/src/subscription-display.js";

test("account summary distinguishes Free, web, and earlier Android app subscriptions", () => {
  assert.deepEqual(subscriptionSummary(null), { plan: "Free", status: "No subscription", provider: null });
  assert.deepEqual(subscriptionSummary({ tier: "plus", status: "trialing", billingSource: "stripe" }),
    { plan: "Plus", status: "trialing", provider: "Web billing" });
  assert.deepEqual(subscriptionSummary({ tier: "pro", status: "active", billingSource: "app", cancelAtPeriodEnd: true }),
    { plan: "Pro", status: "Cancellation scheduled", provider: "Android app" });
});
