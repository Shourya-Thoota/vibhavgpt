import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateUsageMultiplier,
  mapMultiplierToTier,
  calculateUserAllocationLimitTokens,
  calculateUnifiedLedgerDeductionMicros,
  microsToComputePoints,
  computePointsToMicros,
  sanitizeModelPricingForClient,
  PROFIT_MARGIN_MODIFIER,
  TOKEN_BASELINE_CORE_COSTS,
  USAGE_MULTIPLIER_TIERS,
  SUBSCRIPTION_PLAN_LIMITS,
  BASELINE_CAV_CREDIT_PER_1M_TOKENS,
} from "../src/models/pricing-engine.js";

test("Pricing Engine: Baseline constants and profit margin modifier", () => {
  assert.equal(PROFIT_MARGIN_MODIFIER, 1.10); // Strictly 10% upcharge markup
  assert.equal(TOKEN_BASELINE_CORE_COSTS.INPUT_USD_PER_1M, 1.00);
  assert.equal(TOKEN_BASELINE_CORE_COSTS.OUTPUT_USD_PER_1M, 4.00);
  assert.equal(BASELINE_CAV_CREDIT_PER_1M_TOKENS, 1.10);
});

test("Pricing Engine: Usage Multiplier (mu) formula matches exact reference values", () => {
  // Test baseline ($1.00 in, $4.00 out) -> mu = 1.10
  const baselineMu = calculateUsageMultiplier(1.00, 4.00);
  assert.equal(baselineMu, 1.10);

  // Test Seed Model Table entries from PDF Section 4:
  // 1. GPT-6 Luna: $0.10 in, $0.50 out -> mu = 0.124
  assert.equal(calculateUsageMultiplier(0.10, 0.50), 0.124);

  // 2. GPT-6.1 Terra: $1.50 in, $6.00 out -> mu = 1.650
  assert.equal(calculateUsageMultiplier(1.50, 6.00), 1.65);

  // 3. GPT-6.1 Sol: $4.00 in, $16.00 out -> mu = 4.400
  assert.equal(calculateUsageMultiplier(4.00, 16.00), 4.4);

  // 4. GPT-6 Astra: $15.00 in, $60.00 out -> mu = 16.500
  assert.equal(calculateUsageMultiplier(15.00, 60.00), 16.5);

  // 5. Claude Haiku 5.5: $0.10 in, $0.50 out -> mu = 0.124
  assert.equal(calculateUsageMultiplier(0.10, 0.50), 0.124);

  // 6. Claude Sonnet 5.5: $2.00 in, $10.00 out -> mu = 2.475
  assert.equal(calculateUsageMultiplier(2.00, 10.00), 2.475);

  // 7. Claude Opus 5.5: $4.00 in, $20.00 out -> mu = 4.950
  assert.equal(calculateUsageMultiplier(4.00, 20.00), 4.95);

  // 8. Claude Sonnet 5.1: $10.00 in, $50.00 out -> mu = 12.375
  assert.equal(calculateUsageMultiplier(10.00, 50.00), 12.375);

  // 9. Gemini 3.8 Flash: $0.75 in, $3.75 out -> mu = 0.928
  assert.equal(calculateUsageMultiplier(0.75, 3.75), 0.928);

  // 10. Gemini 3.5 Flash-Lite: $0.10 in, $0.40 out -> mu = 0.110
  assert.equal(calculateUsageMultiplier(0.10, 0.40), 0.11);

  // 11. Kimi K2.6: $0.96 in, $4.00 out -> mu = 1.078
  assert.equal(calculateUsageMultiplier(0.96, 4.00), 1.078);

  // 12. Grok 4.7: $2.00 in, $6.00 out -> mu = 1.925
  assert.equal(calculateUsageMultiplier(2.00, 6.00), 1.925);

  // 13. DeepSeek V4.1 Flash A: $0.30 in, $1.20 out -> mu = 0.330
  assert.equal(calculateUsageMultiplier(0.30, 1.20), 0.33);

  // 14. Qwen 3.7 Plus: $1.20 in, $1.60 out -> mu = 0.880
  assert.equal(calculateUsageMultiplier(1.20, 1.60), 0.88);

  // 15. Meta Llama 4 Scout: $0.10 in, $0.30 out -> mu = 0.096
  assert.equal(calculateUsageMultiplier(0.10, 0.30), 0.096);

  // 16. Z.ai GLM-5.3 Flash: $0.15 in, $0.50 out -> mu = 0.151
  assert.equal(calculateUsageMultiplier(0.15, 0.50), 0.151);
});

test("Pricing Engine: Tier Dot mapping thresholds", () => {
  // mu <= 1: Low (Green Dot)
  const lowTier = mapMultiplierToTier(0.124);
  assert.equal(lowTier.tierKey, "low");
  assert.equal(lowTier.uiRepresentation, "Green Dot");
  assert.equal(lowTier.dotColor, "#10b981");

  const lowBoundary = mapMultiplierToTier(1.000);
  assert.equal(lowBoundary.uiRepresentation, "Green Dot");

  // 1 < mu <= 2: Medium (Yellow Dot)
  const medTier = mapMultiplierToTier(1.078);
  assert.equal(medTier.tierKey, "medium");
  assert.equal(medTier.uiRepresentation, "Yellow Dot");
  assert.equal(medTier.dotColor, "#f59e0b");

  const medBoundary = mapMultiplierToTier(2.000);
  assert.equal(medBoundary.uiRepresentation, "Yellow Dot");

  // 2 < mu <= 7: High (Orange Dot)
  const highTier = mapMultiplierToTier(2.475);
  assert.equal(highTier.tierKey, "high");
  assert.equal(highTier.uiRepresentation, "Orange Dot");
  assert.equal(highTier.dotColor, "#f97316");

  const highBoundary = mapMultiplierToTier(7.000);
  assert.equal(highBoundary.uiRepresentation, "Orange Dot");

  // mu > 7: Extra High (Red Dot)
  const extraHighTier = mapMultiplierToTier(12.375);
  assert.equal(extraHighTier.tierKey, "extra_high");
  assert.equal(extraHighTier.uiRepresentation, "Red Dot");
  assert.equal(extraHighTier.dotColor, "#ef4444");
});

test("Pricing Engine: MTAB subscription plan allocations and limits", () => {
  // Free: $0.25 MTAB, 15 prompts/24h
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.free.mtabDollars, 0.25);
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.free.dailyVolatileAllowancePrompts, 15);
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.free.maxAllowedMu, 1.00); // Restricted entirely to Green Dot

  // Plus: $3.00 MTAB, 100 images, 40 high-compute prompts/5h, forbidden mu > 7
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.plus.mtabDollars, 3.00);
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.plus.maxImagesPerMonth, 100);
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.plus.rollingHighComputeThrottlePrompts, 40);
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.plus.maxAllowedMu, 7.00);

  // Pro: $9.00 MTAB, 400 images, 120 high-compute prompts/5h
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.pro.mtabDollars, 9.00);
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.pro.maxImagesPerMonth, 400);
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.pro.rollingHighComputeThrottlePrompts, 120);

  // Max: $40.00 MTAB, 1500 images, 400 Extra-High prompts/5h
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.max.mtabDollars, 40.00);
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.max.maxImagesPerMonth, 1500);
  assert.equal(SUBSCRIPTION_PLAN_LIMITS.max.rollingExtraHighThrottlePrompts, 400);
});

test("Pricing Engine: User Allocation Limit (Blended Tokens) = MTAB / mu", () => {
  // For Plus ($3.00 MTAB) on a model with mu = 1.0:
  // Tokens = (3.00 / 1.0) * 1,000,000 = 3,000,000 tokens
  assert.equal(calculateUserAllocationLimitTokens("plus", 1.0), 3_000_000);

  // For Plus ($3.00 MTAB) on a model with mu = 1.5:
  // Tokens = (3.00 / 1.5) * 1,000,000 = 2,000,000 tokens
  assert.equal(calculateUserAllocationLimitTokens("plus", 1.5), 2_000_000);

  // For Free ($0.25 MTAB) on mu = 0.124:
  // Tokens = (0.25 / 0.124) * 1,000,000 = 2,016,129 tokens
  assert.equal(calculateUserAllocationLimitTokens("free", 0.124), 2_016_129);
});

test("Pricing Engine: Compute Points gamification and privacy abstraction", () => {
  // $1.00 = 1,000,000 micros = 1,000 Compute Points
  assert.equal(microsToComputePoints(1_000_000), 1000);
  assert.equal(computePointsToMicros(1000), 1_000_000);

  // Client sanitization NEVER exposes mu
  const clientView = sanitizeModelPricingForClient({ calculatedMu: 4.4 });
  assert.equal(clientView.uiRepresentation, "Orange Dot");
  assert.equal(clientView.dotColor, "#f97316");
  assert.equal(clientView.calculatedMu, undefined); // Strictly hidden
  assert.equal(clientView.gamifiedRateLabel, "High Compute");
});

test("Pricing Engine: Unified Ledger deduction with 10% markup", () => {
  // 100,000 in ($1/1M), 20,000 out ($4/1M)
  // Raw cost = 0.100 * $1 + 0.020 * $4 = $0.10 + $0.08 = $0.18 (180,000 micros)
  // Markup 10%: $0.18 * 1.10 = $0.198 (198,000 micros)
  const deduction = calculateUnifiedLedgerDeductionMicros({
    inputTokens: 100_000,
    outputTokens: 20_000,
    inputPriceMicrosPerM: 1_000_000,
    outputPriceMicrosPerM: 4_000_000,
  });
  assert.equal(deduction, 198_000);
});

