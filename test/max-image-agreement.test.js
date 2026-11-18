import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

// Every place that states or enforces an image allowance must say the same thing. Max is 1,500 a month (the owner's decision, PR #74);
// Free is 2 a week, Plus 100 and Pro 400 a month. The numbers live in frontend/src/plan-entitlements.js for everything a person reads,
// and in three server files for enforcement. This test compares all of them, for every plan and every wording mode, so a number cannot
// drift apart again without a failing test.

const { IMAGES_PER_MONTH, IMAGES_PER_WEEK, countText } = await import("../frontend/src/plan-entitlements.js");
const { GENERATION_LIMITS } = await import("../src/usage/service.js");
const { IMAGE_MODE_PLAN_QUOTAS, authorizeImageGeneration } = await import("../src/generation/image-engine.js");
const { SUBSCRIPTION_PLAN_LIMITS } = await import("../src/models/pricing-engine.js");
const { comparisonGroupsFor } = await import("../frontend/src/plan-comparison.js");
const { PRODUCT_KNOWLEDGE, productKnowledgeFor } = await import("../frontend/src/product-knowledge.js");
const { PUBLIC_PAGES, pricingFaqFor, pageStructuredData } = await import("../frontend/src/public-pages.js");
const { usageOverviewView } = await import("../frontend/src/usage-overview-view.js");
const { usagePayload } = await import("./support/usage-fixture.js");

const MODES = [null, "carry", "expiry"];
const PAID = ["plus", "pro", "max"];

test("the canonical numbers are the ones the owner approved", () => {
  assert.deepEqual({ ...IMAGES_PER_MONTH }, { plus: 100, pro: 400, max: 1500 });
  assert.deepEqual({ ...IMAGES_PER_WEEK }, { free: 2 });
  assert.equal(countText(1500), "1,500");
});

test("server enforcement: every plan's limit, in all three places, is the canonical one", () => {
  for (const plan of PAID) {
    assert.equal(IMAGE_MODE_PLAN_QUOTAS[plan].quotaPerMonth, IMAGES_PER_MONTH[plan], `${plan}: image engine`);
    assert.equal(SUBSCRIPTION_PLAN_LIMITS[plan].maxImagesPerMonth, IMAGES_PER_MONTH[plan], `${plan}: pricing engine`);
    assert.equal(GENERATION_LIMITS[plan].images, IMAGES_PER_MONTH[plan], `${plan}: what Usage is told`);
  }
  assert.equal(IMAGE_MODE_PLAN_QUOTAS.free.quotaPerWeek, IMAGES_PER_WEEK.free);
  assert.equal(GENERATION_LIMITS.free.images, IMAGES_PER_WEEK.free);
});

test("enforcement really stops a plan at its number, and a Max account can use all 1,500", () => {
  for (const plan of PAID) {
    const limit = IMAGES_PER_MONTH[plan];
    assert.equal(authorizeImageGeneration(plan, limit - 1).authorized, true, `${plan}: the last allowed image`);
    assert.equal(authorizeImageGeneration(plan, limit).authorized, false, `${plan}: the next one is refused`);
  }
  assert.equal(authorizeImageGeneration("max", 200).authorized, true, "Max is not stopped at the old 200");
  assert.match(authorizeImageGeneration("max", 1500).error.message, /used all 1500 images included with your plan/);
});

test("the pricing table states the canonical number for every plan, in every mode", () => {
  for (const mode of MODES) {
    const row = comparisonGroupsFor(mode).find((group) => group.title === "Making things").rows.find((r) => r.label === "Image generations");
    assert.deepEqual(row.values, [
      `${IMAGES_PER_WEEK.free} per week`,
      `${countText(IMAGES_PER_MONTH.plus)} per billing month`,
      `${countText(IMAGES_PER_MONTH.pro)} per month`,
      `${countText(IMAGES_PER_MONTH.max)} per month`,
    ], `mode ${mode}`);
  }
});

test("product knowledge states the canonical number for Max, in every mode, and no stale one anywhere", () => {
  for (const mode of MODES) {
    const knowledge = productKnowledgeFor(mode);
    const max = knowledge.plans.find((plan) => plan.id === "max");
    const lines = [...max.features, ...max.details].join(" | ");
    assert.match(lines, /1,500 image generations per month/, `mode ${mode}: Max`);
    assert.doesNotMatch(lines, /\b200 image/, `mode ${mode}: no 200`);
    // The other plans are not touched by this change.
    const text = (id) => { const plan = knowledge.plans.find((p) => p.id === id); return [plan.description, ...plan.features, ...plan.details].join(" "); };
    assert.match(text("plus"), /100 image/);
    assert.match(text("pro"), /400 image generations per UTC calendar month/);
    assert.match(text("free"), /2 image generations per week/);
  }
});

test("no public page, FAQ or structured data says Max has 200 images", () => {
  for (const mode of MODES) {
    const everything = JSON.stringify({ knowledge: productKnowledgeFor(mode), faq: pricingFaqFor(mode), comparison: comparisonGroupsFor(mode) });
    assert.doesNotMatch(everything, /\b200 (image|per month)/i, `mode ${mode}`);
  }
  assert.doesNotMatch(JSON.stringify(PUBLIC_PAGES), /\b200 (image|per month)/i, "the public page registry");
  for (const route of Object.keys(PUBLIC_PAGES)) assert.doesNotMatch(JSON.stringify(pageStructuredData(route)), /\b200 (image|per month)/i, `structured data for ${route}`);
  assert.doesNotMatch(JSON.stringify(PRODUCT_KNOWLEDGE), /\b200 image/i);
});

test("the Usage screen shows a Max account's real allowance, with the count as a person reads it", () => {
  const view = (options) => usageOverviewView(usagePayload(options), { locale: "en-US", timeZone: "UTC" }).images;
  const fresh = view({ tier: "max", imagesUsed: 0 });
  assert.equal(fresh.headline.value, "1,500 of 1,500");
  assert.equal(fresh.meter.limit, 1500);
  assert.equal(view({ tier: "max", imagesUsed: 300 }).headline.value, "1,200 of 1,500");
  // The other plans are as they were.
  assert.equal(view({ tier: "plus" }).headline.value, "100 of 100");
  assert.equal(view({ tier: "pro" }).headline.value, "400 of 400");
  assert.equal(view({ tier: "free", imagesUsed: 1 }).headline.value, "1 of 2");
});

// The older allowance system (src/usage/allowance-service.js) still carries its own image counts: Max 200, Pro 60, Plus 25. It only runs when
// FEATURE_CHAT_ALLOWANCE_ENFORCEMENT is true, and that variable is not set in production, so it enforces nothing today. Its numbers disagree for
// every paid plan, not just Max, so correcting one would leave it half true. It is tracked here, visibly and without blocking, for the owner
// to retire or reconcile before that flag is ever turned on.
test("the dormant allowance system's image counts match the canonical ones", { todo: "Dormant behind FEATURE_CHAT_ALLOWANCE_ENFORCEMENT (unset in production): Max 200, Pro 60, Plus 25 still need reconciling or retiring" }, async () => {
  const { PLAN_ALLOWANCES } = await import("../src/usage/allowance-service.js");
  for (const plan of PAID) assert.equal(PLAN_ALLOWANCES[plan].maxImagesPerMonth, IMAGES_PER_MONTH[plan], `${plan}: allowance-service`);
});
