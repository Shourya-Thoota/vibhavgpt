import test from "node:test";
import assert from "node:assert/strict";
import {
  isModelEligibleForPlan,
  evaluatePlanThrottles,
  getPlanAllocationLimit,
  THROTTLE_REASONS,
} from "../src/usage/plan-throttle-policy.js";

test("Plan Throttle Policy: Free tier model eligibility (restricted to Green Dot)", () => {
  // Green Dot (mu <= 1.00) -> allowed
  const greenEligible = isModelEligibleForPlan("free", { calculatedMu: 0.124 });
  assert.equal(greenEligible.eligible, true);

  const greenBoundary = isModelEligibleForPlan("free", { calculatedMu: 1.000 });
  assert.equal(greenBoundary.eligible, true);

  // Yellow Dot (1.0 < mu <= 2.0) -> rejected
  const yellowRejected = isModelEligibleForPlan("free", { calculatedMu: 1.650 });
  assert.equal(yellowRejected.eligible, false);
  assert.equal(yellowRejected.reason, THROTTLE_REASONS.FREE_RESTRICTED_TO_GREEN_DOT);

  // Orange Dot (2.0 < mu <= 7.0) -> rejected
  const orangeRejected = isModelEligibleForPlan("free", { calculatedMu: 4.400 });
  assert.equal(orangeRejected.eligible, false);

  // Red Dot (mu > 7.0) -> rejected
  const redRejected = isModelEligibleForPlan("free", { calculatedMu: 16.500 });
  assert.equal(redRejected.eligible, false);
});

test("Plan Throttle Policy: Plus tier model eligibility (forbidden from Extra High mu > 7)", () => {
  // Green, Yellow, Orange -> allowed
  assert.equal(isModelEligibleForPlan("plus", { calculatedMu: 0.124 }).eligible, true);
  assert.equal(isModelEligibleForPlan("plus", { calculatedMu: 1.650 }).eligible, true);
  assert.equal(isModelEligibleForPlan("plus", { calculatedMu: 4.400 }).eligible, true);
  assert.equal(isModelEligibleForPlan("plus", { calculatedMu: 7.000 }).eligible, true);

  // Extra High (Red Dot, mu > 7.00) -> strictly forbidden
  const extraHighAttempt = isModelEligibleForPlan("plus", { calculatedMu: 7.001 });
  assert.equal(extraHighAttempt.eligible, false);
  assert.equal(extraHighAttempt.reason, THROTTLE_REASONS.PLUS_FORBIDDEN_EXTRA_HIGH);

  const astraAttempt = isModelEligibleForPlan("plus", { calculatedMu: 16.500 });
  assert.equal(astraAttempt.eligible, false);
  assert.equal(astraAttempt.reason, THROTTLE_REASONS.PLUS_FORBIDDEN_EXTRA_HIGH);
});

test("Plan Throttle Policy: Pro and Max have full access to all tiers", () => {
  assert.equal(isModelEligibleForPlan("pro", { calculatedMu: 16.500 }).eligible, true);
  assert.equal(isModelEligibleForPlan("max", { calculatedMu: 16.500 }).eligible, true);
});

test("Plan Throttle Policy: Free tier 24h soft throttle (15 prompts in legacy mode) and weekly image entitlement (2 images/week)", () => {
  // 14 prompts consumed -> prompt 15 allowed
  const allowedTurn = evaluatePlanThrottles({
    plan: "free",
    calculatedMu: 0.124,
    dailyPromptCount: 14,
    creditsActive: false,
  });
  assert.equal(allowedTurn.allowed, true);

  // 15 prompts consumed -> prompt 16 throttled in legacy mode
  const throttledTurn = evaluatePlanThrottles({
    plan: "free",
    calculatedMu: 0.124,
    dailyPromptCount: 15,
    creditsActive: false,
  });
  assert.equal(throttledTurn.allowed, false);
  assert.equal(throttledTurn.reason, THROTTLE_REASONS.FREE_DAILY_PROMPTS_EXCEEDED);

  // Image mode on Free -> 1 used is allowed (out of 2 per week)
  const imageAllowed = evaluatePlanThrottles({
    plan: "free",
    modality: "image",
    weeklyImageCount: 1,
  });
  assert.equal(imageAllowed.allowed, true);

  // 2 used -> 3rd is throttled with weekly quota exhausted
  const imageThrottled = evaluatePlanThrottles({
    plan: "free",
    modality: "image",
    weeklyImageCount: 2,
  });
  assert.equal(imageThrottled.allowed, false);
  assert.equal(imageThrottled.reason, THROTTLE_REASONS.IMAGE_QUOTA_EXCEEDED);
});

test("Plan Throttle Policy: Plus tier 5h rolling throttle (40 high-compute prompts) and image limit (100)", () => {
  // 39 high-compute prompts consumed -> 40th allowed
  const allowedHighCompute = evaluatePlanThrottles({
    plan: "plus",
    calculatedMu: 4.400, // Orange dot
    rollingHighComputeCount: 39,
  });
  assert.equal(allowedHighCompute.allowed, true);

  // 40 high-compute prompts consumed -> 41st throttled
  const throttledHighCompute = evaluatePlanThrottles({
    plan: "plus",
    calculatedMu: 4.400,
    rollingHighComputeCount: 40,
  });
  assert.equal(throttledHighCompute.allowed, false);
  assert.equal(throttledHighCompute.reason, THROTTLE_REASONS.PLUS_HIGH_COMPUTE_THROTTLED);

  // Green dot prompt is NOT throttled by the high-compute counter
  const greenTurn = evaluatePlanThrottles({
    plan: "plus",
    calculatedMu: 0.124,
    rollingHighComputeCount: 40,
  });
  assert.equal(greenTurn.allowed, true);

  // Image limit: 99 used -> 100th allowed; 100 used -> 101st blocked
  assert.equal(
    evaluatePlanThrottles({ plan: "plus", modality: "image", monthlyImageCount: 99 }).allowed,
    true
  );
  const imageExceeded = evaluatePlanThrottles({
    plan: "plus",
    modality: "image",
    monthlyImageCount: 100,
  });
  assert.equal(imageExceeded.allowed, false);
  assert.equal(imageExceeded.reason, THROTTLE_REASONS.IMAGE_QUOTA_EXCEEDED);
});

test("Plan Throttle Policy: Pro (120 high-compute/5h, 400 images) and Max (400 Extra-High/5h, 1500 images)", () => {
  // Pro high-compute throttle at 120
  assert.equal(
    evaluatePlanThrottles({ plan: "pro", calculatedMu: 2.475, rollingHighComputeCount: 119 }).allowed,
    true
  );
  assert.equal(
    evaluatePlanThrottles({ plan: "pro", calculatedMu: 2.475, rollingHighComputeCount: 120 }).allowed,
    false
  );

  // Pro images limit at 400
  assert.equal(
    evaluatePlanThrottles({ plan: "pro", modality: "image", monthlyImageCount: 399 }).allowed,
    true
  );
  assert.equal(
    evaluatePlanThrottles({ plan: "pro", modality: "image", monthlyImageCount: 400 }).allowed,
    false
  );

  // Max Extra-High throttle at 400
  assert.equal(
    evaluatePlanThrottles({ plan: "max", calculatedMu: 16.500, rollingExtraHighCount: 399 }).allowed,
    true
  );
  assert.equal(
    evaluatePlanThrottles({ plan: "max", calculatedMu: 16.500, rollingExtraHighCount: 400 }).allowed,
    false
  );

  // Max images limit at 1500
  assert.equal(
    evaluatePlanThrottles({ plan: "max", modality: "image", monthlyImageCount: 1499 }).allowed,
    true
  );
  assert.equal(
    evaluatePlanThrottles({ plan: "max", modality: "image", monthlyImageCount: 1500 }).allowed,
    false
  );
});

test("Plan Throttle Policy: Allocation Limit calculation", () => {
  // Pro: $9.00 MTAB / 1.5 mu = 6,000,000 tokens
  assert.equal(getPlanAllocationLimit("pro", 1.5), 6_000_000);
  // Max: $40.00 MTAB / 4.0 mu = 10,000,000 tokens
  assert.equal(getPlanAllocationLimit("max", 4.0), 10_000_000);
});

test("Plan Throttle Policy: when creditsActive is true, legacy daily and rolling prompt throttles are bypassed", () => {
  // Free: dailyPromptCount >= 15 is allowed when creditsActive is true
  const freeOver15 = evaluatePlanThrottles({
    plan: "free",
    calculatedMu: 0.124,
    dailyPromptCount: 15,
    creditsActive: true,
  });
  assert.equal(freeOver15.allowed, true);

  const freeOver100 = evaluatePlanThrottles({
    plan: "free",
    calculatedMu: 0.124,
    dailyPromptCount: 100,
    creditsActive: true,
  });
  assert.equal(freeOver100.allowed, true);

  // Free: weekly image quota still enforced (2 images/week)
  const freeImageAllowed = evaluatePlanThrottles({
    plan: "free",
    modality: "image",
    weeklyImageCount: 0,
    creditsActive: true,
  });
  assert.equal(freeImageAllowed.allowed, true);

  const freeImageExceeded = evaluatePlanThrottles({
    plan: "free",
    modality: "image",
    weeklyImageCount: 2,
    creditsActive: true,
  });
  assert.equal(freeImageExceeded.allowed, false);
  assert.equal(freeImageExceeded.reason, THROTTLE_REASONS.IMAGE_QUOTA_EXCEEDED);

  // Free tier model eligibility still strictly enforced
  const freeIneligible = evaluatePlanThrottles({
    plan: "free",
    calculatedMu: 1.650,
    creditsActive: true,
  });
  assert.equal(freeIneligible.allowed, false);
  assert.equal(freeIneligible.reason, THROTTLE_REASONS.FREE_RESTRICTED_TO_GREEN_DOT);

  // Plus: rollingHighComputeCount >= 40 is allowed when creditsActive is true
  const plusHighAllowed = evaluatePlanThrottles({
    plan: "plus",
    calculatedMu: 4.400,
    rollingHighComputeCount: 40,
    creditsActive: true,
  });
  assert.equal(plusHighAllowed.allowed, true);

  // Plus image limit still enforced
  const plusImageBlocked = evaluatePlanThrottles({
    plan: "plus",
    modality: "image",
    monthlyImageCount: 100,
    creditsActive: true,
  });
  assert.equal(plusImageBlocked.allowed, false);
  assert.equal(plusImageBlocked.reason, THROTTLE_REASONS.IMAGE_QUOTA_EXCEEDED);

  // Pro: rollingHighComputeCount >= 120 is allowed when creditsActive is true
  const proHighAllowed = evaluatePlanThrottles({
    plan: "pro",
    calculatedMu: 2.475,
    rollingHighComputeCount: 120,
    creditsActive: true,
  });
  assert.equal(proHighAllowed.allowed, true);

  // Max: rollingExtraHighCount >= 400 is allowed when creditsActive is true
  const maxExtraHighAllowed = evaluatePlanThrottles({
    plan: "max",
    calculatedMu: 16.500,
    rollingExtraHighCount: 400,
    creditsActive: true,
  });
  assert.equal(maxExtraHighAllowed.allowed, true);
});
