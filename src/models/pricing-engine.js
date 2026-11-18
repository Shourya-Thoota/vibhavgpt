/**
 * Programmatic Pricing & Metrics Engine (Section 3 of VibhavGPT Specification).
 *
 * Implements:
 * 1. The Profit-Adjusted Baseline Standard (alpha = 1.10)
 * 2. Consumption Multiplier (mu) calculation & Tier Dot mappings
 * 3. Operational Limit-Mapping Framework: Credit Allocation Value (CAV) & Unified Ledger
 * 4. Monthly Token Allowance Budget (MTAB) limit calibration
 * 5. Compute Points gamification abstraction (strictly hiding raw mu from user UI)
 */

export const PROFIT_MARGIN_MODIFIER = 1.10; // Strictly 10% programmatic upcharge markup (alpha)

export const TOKEN_BASELINE_CORE_COSTS = Object.freeze({
  INPUT_USD_PER_1M: 1.00,
  OUTPUT_USD_PER_1M: 4.00,
});

export const USAGE_MULTIPLIER_TIERS = Object.freeze({
  LOW: Object.freeze({
    maxMu: 1.0,
    systemDesignation: "Low",
    uiRepresentation: "Green Dot",
    dotColor: "#10b981",
    accessibleLabel: "Low compute consumption",
    allowedPlans: Object.freeze(["free", "plus", "pro", "max"]),
  }),
  MEDIUM: Object.freeze({
    minMu: 1.0,
    maxMu: 2.0,
    systemDesignation: "Medium",
    uiRepresentation: "Yellow Dot",
    dotColor: "#f59e0b",
    accessibleLabel: "Standard compute consumption",
    allowedPlans: Object.freeze(["plus", "pro", "max"]),
  }),
  HIGH: Object.freeze({
    minMu: 2.0,
    maxMu: 7.0,
    systemDesignation: "High",
    uiRepresentation: "Orange Dot",
    dotColor: "#f97316",
    accessibleLabel: "High compute consumption",
    allowedPlans: Object.freeze(["plus", "pro", "max"]),
  }),
  EXTRA_HIGH: Object.freeze({
    minMu: 7.0,
    systemDesignation: "Extra High",
    uiRepresentation: "Red Dot",
    dotColor: "#ef4444",
    accessibleLabel: "Flagship high compute",
    allowedPlans: Object.freeze(["pro", "max"]), // Strictly forbidden for Plus and Free
  }),
});

/**
 * Monthly Token Allowance Budget (MTAB) across subscription tiers.
 * Section 3.4.3 & Section 9.
 */
export const SUBSCRIPTION_PLAN_LIMITS = Object.freeze({
  free: Object.freeze({
    tier: "free",
    mtabDollars: 0.25, // $0.25 MTAB
    mtabMicros: 250_000,
    dailyVolatileAllowancePrompts: 15, // 15 prompts / 24 hours soft throttle
    allowedTierDots: Object.freeze(["Green Dot"]),
    maxAllowedMu: 1.00,
    maxImagesPerMonth: 0, // Free tier blockade: 0 quota
  }),
  plus: Object.freeze({
    tier: "plus",
    priceMonthlyDollars: 4.99,
    mtabDollars: 3.00, // $3.00 MTAB
    mtabMicros: 3_000_000,
    maxImagesPerMonth: 100, // 100 images/month, no rollover
    rollingHighComputeThrottlePrompts: 40, // 40 high-compute (Orange/Yellow) prompts / 5 hours
    maxAllowedMu: 7.00, // Strictly forbidden from Extra High (mu > 7.00)
    allowedTierDots: Object.freeze(["Green Dot", "Yellow Dot", "Orange Dot"]),
  }),
  pro: Object.freeze({
    tier: "pro",
    priceMonthlyDollars: 12.99,
    mtabDollars: 9.00, // $9.00 MTAB
    mtabMicros: 9_000_000,
    maxImagesPerMonth: 400, // 400 images/month
    rollingHighComputeThrottlePrompts: 120, // 120 high-compute (Orange/Yellow) prompts / 5 hours
    maxAllowedMu: Infinity,
    allowedTierDots: Object.freeze(["Green Dot", "Yellow Dot", "Orange Dot", "Red Dot"]),
  }),
  max: Object.freeze({
    tier: "max",
    priceMonthlyDollars: 50.00,
    mtabDollars: 40.00, // $40.00 MTAB
    mtabMicros: 40_000_000,
    maxImagesPerMonth: 1500, // 1,500 images/month
    rollingExtraHighThrottlePrompts: 400, // 400 Extra-High (Red Dot) prompts / 5 hours
    maxAllowedMu: Infinity,
    allowedTierDots: Object.freeze(["Green Dot", "Yellow Dot", "Orange Dot", "Red Dot"]),
  }),
});

/**
 * Programmatically calculates the profit-adjusted usage multiplier mu.
 *
 * Formula (Section 3.1):
 * mu = ((Cost_In * 1.10) / $1.00 * 0.5) + ((Cost_Out * 1.10) / $4.00 * 0.5)
 *    = 1.10 * (0.5 * Cost_In + 0.125 * Cost_Out)
 *
 * @param {number} costInUsdPer1M - Raw input cost in USD per 1M tokens
 * @param {number} costOutUsdPer1M - Raw output cost in USD per 1M tokens
 * @returns {number} Profit-adjusted usage multiplier mu (rounded to 3 or 4 decimal places)
 */
export function calculateUsageMultiplier(costInUsdPer1M, costOutUsdPer1M) {
  const inCost = Number(costInUsdPer1M);
  const outCost = Number(costOutUsdPer1M);

  if (!Number.isFinite(inCost) || !Number.isFinite(outCost) || inCost < 0 || outCost < 0) {
    return 0;
  }

  // Exact formula from Section 3.1:
  // mu = ((Cost_In * 1.10) / 1.00 * 0.5) + ((Cost_Out * 1.10) / 4.00 * 0.5)
  const rawMu = ((inCost * PROFIT_MARGIN_MODIFIER) / TOKEN_BASELINE_CORE_COSTS.INPUT_USD_PER_1M * 0.5) +
                ((outCost * PROFIT_MARGIN_MODIFIER) / TOKEN_BASELINE_CORE_COSTS.OUTPUT_USD_PER_1M * 0.5);

  return Math.round(rawMu * 1000) / 1000;
}

/**
 * Maps a usage multiplier mu to its UI status tier and dot representation.
 * Section 3.2:
 * mu <= 1: Low (Green Dot)
 * 1 < mu <= 2: Medium (Yellow Dot)
 * 2 < mu <= 7: High (Orange Dot)
 * mu > 7: Extra High (Red Dot)
 */
export function mapMultiplierToTier(mu) {
  const val = Number(mu);
  if (!Number.isFinite(val) || val <= 0) {
    return {
      tierKey: "low",
      systemDesignation: "Low",
      uiRepresentation: "Green Dot",
      dotColor: "#10b981",
      accessibleLabel: "Low compute consumption",
    };
  }

  if (val <= USAGE_MULTIPLIER_TIERS.LOW.maxMu) {
    return {
      tierKey: "low",
      systemDesignation: USAGE_MULTIPLIER_TIERS.LOW.systemDesignation,
      uiRepresentation: USAGE_MULTIPLIER_TIERS.LOW.uiRepresentation,
      dotColor: USAGE_MULTIPLIER_TIERS.LOW.dotColor,
      accessibleLabel: USAGE_MULTIPLIER_TIERS.LOW.accessibleLabel,
    };
  }

  if (val <= USAGE_MULTIPLIER_TIERS.MEDIUM.maxMu) {
    return {
      tierKey: "medium",
      systemDesignation: USAGE_MULTIPLIER_TIERS.MEDIUM.systemDesignation,
      uiRepresentation: USAGE_MULTIPLIER_TIERS.MEDIUM.uiRepresentation,
      dotColor: USAGE_MULTIPLIER_TIERS.MEDIUM.dotColor,
      accessibleLabel: USAGE_MULTIPLIER_TIERS.MEDIUM.accessibleLabel,
    };
  }

  if (val <= USAGE_MULTIPLIER_TIERS.HIGH.maxMu) {
    return {
      tierKey: "high",
      systemDesignation: USAGE_MULTIPLIER_TIERS.HIGH.systemDesignation,
      uiRepresentation: USAGE_MULTIPLIER_TIERS.HIGH.uiRepresentation,
      dotColor: USAGE_MULTIPLIER_TIERS.HIGH.dotColor,
      accessibleLabel: USAGE_MULTIPLIER_TIERS.HIGH.accessibleLabel,
    };
  }

  return {
    tierKey: "extra_high",
    systemDesignation: USAGE_MULTIPLIER_TIERS.EXTRA_HIGH.systemDesignation,
    uiRepresentation: USAGE_MULTIPLIER_TIERS.EXTRA_HIGH.uiRepresentation,
    dotColor: USAGE_MULTIPLIER_TIERS.EXTRA_HIGH.dotColor,
    accessibleLabel: USAGE_MULTIPLIER_TIERS.EXTRA_HIGH.accessibleLabel,
  };
}

/**
 * Calculates user allocation limit in blended tokens based on MTAB and multiplier mu.
 * Section 3.4.3: User Allocation Limit (Blended Tokens) = MTAB / mu
 *
 * In CAV standard measure, $1.10 of MTAB provides 1,000,000 blended tokens at mu = 1.000.
 */
export function calculateUserAllocationLimitTokens(tier, mu) {
  const plan = SUBSCRIPTION_PLAN_LIMITS[String(tier).toLowerCase()];
  const multiplier = Number(mu);

  if (!plan || !Number.isFinite(multiplier) || multiplier <= 0) {
    return 0;
  }

  // Tokens = (MTAB in dollars / 1.10) / mu * 1,000,000 tokens
  // or (MTAB in dollars / mu) * 1,000,000 blended base units
  const tokens = Math.floor((plan.mtabDollars / multiplier) * 1_000_000);
  return Math.max(0, tokens);
}

/**
 * Credit Allocation Value (CAV) Unit-Denominator Mapping.
 * Section 3.4.1:
 * A baseline multiplier of 1x (mu = 1.000) corresponds to exactly $1.10 of platform credit
 * per 1,000,000 blended input/output tokens.
 */
export const BASELINE_CAV_CREDIT_PER_1M_TOKENS = 1.10; // $1.10 per 1M blended tokens

/**
 * Evaluates unified ledger deduction rate:
 * Deduction Rate = Cost_In_Base_Units * mu
 * Or exact token component deduction in micro-dollars with 10% profit margin:
 * Deduction (USD) = 1.10 * (Input * Price_in + Output * Price_out + Cached * Price_cache) / 1,000,000
 */
export function calculateUnifiedLedgerDeductionMicros(options = {}) {
  if (typeof options === "number" || typeof options === "bigint") {
    const rawCostMicros = Number(options);
    return Math.ceil(Math.round(rawCostMicros * 110) / 100);
  }
  const {
    inputTokens = 0,
    outputTokens = 0,
    cachedTokens = 0,
    inputPriceMicrosPerM = 0,
    outputPriceMicrosPerM = 0,
    cachedPriceMicrosPerM = 0,
  } = options || {};
  const inTokens = Math.max(0, Number(inputTokens) || 0);
  const outTokens = Math.max(0, Number(outputTokens) || 0);
  const cacheTokens = Math.max(0, Number(cachedTokens) || 0);

  const inCostPico = inTokens * (Number(inputPriceMicrosPerM) || 0);
  const outCostPico = outTokens * (Number(outputPriceMicrosPerM) || 0);
  const cacheCostPico = cacheTokens * (Number(cachedPriceMicrosPerM) || 0);

  const rawCostMicros = (inCostPico + outCostPico + cacheCostPico) / 1_000_000;
  // Prevent floating point drift (e.g. 180000 * 1.10 = 198000.00000000003)
  const markedUpMicros = Math.ceil(Math.round(rawCostMicros * 110) / 100);

  return markedUpMicros;
}

/**
 * PRIVACY LAYER & CLIENT ABSTRACTION:
 * Section 3.1 & Section 9:
 * NEVER EXPOSE THE USAGE MULTIPLIER TO THE USER UI.
 * Usage is visually gamified as generic "Compute Points" to abstract backend dollar metrics.
 * 1 Compute Point = 1,000 micro-dollars ($0.001 USD)
 */
export const COMPUTE_POINTS_PER_USD = 1_000; // $1.00 = 1,000 Compute Points

export function microsToComputePoints(micros) {
  const numMicros = Math.max(0, Number(micros) || 0);
  // 1,000,000 micros = $1.00 = 1,000 Compute Points -> 1 Point = 1,000 micros
  return Math.round(numMicros / 1000);
}

export function computePointsToMicros(points) {
  const numPoints = Math.max(0, Number(points) || 0);
  return numPoints * 1000;
}

/**
 * Sanitizes model presentation metadata for client UI/API.
 * Removes raw wholesale prices and multiplier mu; includes tier color dot, accessible label, and gamified compute tier.
 */
export function sanitizeModelPricingForClient(pricing) {
  if (!pricing) {
    return {
      tierKey: "low",
      systemDesignation: "Low",
      uiRepresentation: "Green Dot",
      dotColor: "#10b981",
      accessibleLabel: "Low compute consumption",
      gamifiedRateLabel: "Standard Compute",
    };
  }

  const mu = pricing.calculatedMu ?? 0;
  const tierMeta = mapMultiplierToTier(mu);

  return {
    tierKey: tierMeta.tierKey,
    systemDesignation: tierMeta.systemDesignation,
    uiRepresentation: tierMeta.uiRepresentation,
    dotColor: tierMeta.dotColor,
    accessibleLabel: tierMeta.accessibleLabel,
    gamifiedRateLabel: `${tierMeta.systemDesignation} Compute`,
  };
}
