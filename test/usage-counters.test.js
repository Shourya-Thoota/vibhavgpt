import test from "node:test";
import assert from "node:assert/strict";
import { usageCounters } from "../frontend/src/usage-counters.js";

const values = (usage) => Object.fromEntries(usageCounters(usage).rows.map((row) => [row.id, row.value]));
const images = (period, limit, remaining) => ({ included: true, period, limit, remaining });

test("credits read as used of the month's allowance; images and documents as used of their limits", () => {
  assert.deepEqual(values({
    tier: "plus",
    credits: { active: true, monthly: { consumedMicros: 1_250_000, credits: 60 } },
    overview: { images: images("month", 100, 97), documents: { included: true, unlimited: false, limit: 20, remaining: 15 } },
  }), { credits: "25 / 60 credits used this month", images: "3 / 100 images used this month", documents: "5 / 20 documents used this month" });
});

test("a complimentary account reads Unlimited and never shows a credit count", () => {
  const out = usageCounters({ tier: "max", credits: { active: true, complimentary: true, monthly: { consumedMicros: 999_999_999, credits: 800 } }, overview: { images: images("month", 1500, 1500), documents: { included: true, unlimited: true } } });
  assert.equal(out.rows[0].value, "Unlimited");
  assert.equal(out.rows[2].value, "Unlimited");
  assert.equal(out.plan, "Max");
});

test("Free counts images by the week and says documents are not included; credits off reads the token share", () => {
  assert.deepEqual(values({
    tier: "free",
    limits: {},
    monthlyTokenBreakdown: {},
    overview: { images: images("week", 2, 1), documents: { included: false } },
  }), { credits: "Included with Free", images: "1 / 2 images used this week", documents: "Not included on Free" });
});

test("a figure the server did not send reads Unavailable, never zero", () => {
  assert.deepEqual(values({ tier: "pro", credits: { active: true, monthly: {} } }), { credits: "Unavailable", images: "Unavailable", documents: "Unavailable" });
  assert.equal(usageCounters(null), null);
});
