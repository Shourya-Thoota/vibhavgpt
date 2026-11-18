import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeImageGeneration,
  resolveImageRoutingEngine,
  calculateImageExecutionOverhead,
  IMAGE_MODE_PLAN_QUOTAS,
  IMAGE_GENERATION_MODELS,
} from "../src/generation/image-engine.js";

test("Image Engine: Free Tier gets 2 images a week, then a plain refusal", () => {
  const first = authorizeImageGeneration("free", 0);
  assert.equal(first.authorized, true);
  assert.equal(first.quota, 2);
  assert.equal(first.remaining, 2);
  assert.equal(first.window, "week");
  const spent = authorizeImageGeneration("free", 2);
  assert.equal(spent.authorized, false);
  assert.equal(spent.quota, 2);
  assert.equal(spent.error?.status, 429);
  assert.equal(spent.error?.code, "image_quota_exhausted");
  assert.match(spent.error?.message, /^You've used your 2 free images this week. More arrive Monday at 12:00 AM UTC.$/);
});

test("Image Engine: Paid tier authorization and monthly quotas", () => {
  // Plus: 100 images/month
  const plusAuth = authorizeImageGeneration("plus", 45);
  assert.equal(plusAuth.authorized, true);
  assert.equal(plusAuth.quota, 100);
  assert.equal(plusAuth.remaining, 55);

  const plusExhausted = authorizeImageGeneration("plus", 100);
  assert.equal(plusExhausted.authorized, false);
  assert.equal(plusExhausted.remaining, 0);
  assert.equal(plusExhausted.error?.status, 429);

  // Pro: 400 images/month
  const proAuth = authorizeImageGeneration("pro", 150);
  assert.equal(proAuth.authorized, true);
  assert.equal(proAuth.quota, 400);
  assert.equal(proAuth.remaining, 250);

  // Max: 1,500 images/month
  const maxAuth = authorizeImageGeneration("max", 1200);
  assert.equal(maxAuth.authorized, true);
  assert.equal(maxAuth.quota, 1500);
  assert.equal(maxAuth.remaining, 300);

  const maxExhausted = authorizeImageGeneration("max", 1500);
  assert.equal(maxExhausted.authorized, false);
});

test("Image Engine: Routing engine brokerage resolution", () => {
  // Default paid resolution
  const defaultEngine = resolveImageRoutingEngine({ plan: "plus" });
  assert.equal(defaultEngine.engineType, "openrouter_brokered");
  assert.equal(defaultEngine.modelId, IMAGE_GENERATION_MODELS.FLUX_SCHNELL);

  // Pro/Max requesting FLUX Dev
  const proEngine = resolveImageRoutingEngine({ requestedModel: "flux-dev", plan: "pro" });
  assert.equal(proEngine.modelId, IMAGE_GENERATION_MODELS.FLUX_DEV);

  // Free cannot resolve engine
  assert.throws(() => resolveImageRoutingEngine({ plan: "free" }), /Free tier users cannot resolve/);
});

test("Image Engine: Programmatic cost synchronization (alpha = 1.10)", () => {
  // Raw cost $0.04 (40,000 micros)
  // 10% markup: 40,000 * 1.10 = 44,000 micros ($0.044 USD)
  const overhead = calculateImageExecutionOverhead(0.04);
  assert.equal(overhead.rawCostMicros, 40_000);
  assert.equal(overhead.markedUpCostMicros, 44_000);
  assert.equal(overhead.markedUpUsd, 0.044);
  assert.equal(overhead.marginFactor, 1.10);
});
