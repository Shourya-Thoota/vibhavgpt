/**
 * Subscription Plan Limit Calibration & Throttle Policy.
 * Section 3.4.3 and Section 9 (Finalized Operational Constraints).
 *
 * Enforces:
 * - Free Tier: $0.25 MTAB, Daily Volatile Allowance (DVA) soft throttle of 15 prompts/24h in legacy mode,
 *   restricted entirely to Green Dot models (mu <= 1.00), 2 images/week.
 * - Plus Tier ($4.99/mo): $3.00 MTAB, 100 images/month (no rollover),
 *   5-hour rolling throttle of 40 high-compute (Orange/Yellow) prompts,
 *   strictly forbidden from Extra High tier models (mu > 7.00).
 * - Pro Tier ($12.99/mo): $9.00 MTAB, 400 images/month,
 *   5-hour rolling throttle of 120 high-compute (Orange/Yellow) prompts.
 * - Max Tier ($49.99/mo): $40.00 MTAB, 1500 images/month,
 *   5-hour rolling throttle of 400 Extra-High (Red Dot) prompts.
 */

import {
  SUBSCRIPTION_PLAN_LIMITS,
  calculateUserAllocationLimitTokens,
  mapMultiplierToTier,
} from "../models/pricing-engine.js";
import { resolveCreditsPolicy } from "./credits.js";
import { FREE_IMAGES_PER_WEEK } from "../generation/image-engine.js";

export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
export const TWENTY_FOUR_HOUR_WINDOW_MS = 24 * 60 * 60 * 1000;

export const THROTTLE_REASONS = Object.freeze({
  FREE_RESTRICTED_TO_GREEN_DOT: "free_restricted_to_green_dot",
  FREE_DAILY_PROMPTS_EXCEEDED: "free_daily_prompts_exceeded",
  PLUS_FORBIDDEN_EXTRA_HIGH: "plus_forbidden_extra_high",
  PLUS_HIGH_COMPUTE_THROTTLED: "plus_high_compute_throttled",
  PRO_HIGH_COMPUTE_THROTTLED: "pro_high_compute_throttled",
  MAX_EXTRA_HIGH_THROTTLED: "max_extra_high_throttled",
  IMAGE_QUOTA_EXCEEDED: "image_quota_exceeded",
  FREE_IMAGE_BLOCKADE: "free_image_blockade",
});

/**
 * Checks whether a specific model is eligible to be executed under the user's plan.
 *
 * @param {string} plan - "free" | "plus" | "pro" | "max"
 * @param {Object} modelPricing - { calculatedMu, consumptionCategory }
 * @returns {Object} { eligible: boolean, reason?: string, message?: string }
 */
export function isModelEligibleForPlan(plan = "free", modelPricing = {}) {
  const normPlan = String(plan || "free").toLowerCase();
  const mu = Number(modelPricing.calculatedMu ?? 0);
  const tier = mapMultiplierToTier(mu);

  if (normPlan === "free") {
    const key = String(modelPricing.modelKey || "").toLowerCase();
    if (key === "nova" || key === "lumen") {
      return { eligible: true };
    }
    // Free accounts are restricted entirely to Green Dot models (mu <= 1.00)
    if (mu > 1.00 || tier.tierKey !== "low") {
      return {
        eligible: false,
        reason: THROTTLE_REASONS.FREE_RESTRICTED_TO_GREEN_DOT,
        message: "Free tier accounts are restricted entirely to Green Dot (Low consumption) models. Please upgrade to Plus or Pro to unlock standard and high compute models.",
      };
    }
    return { eligible: true };
  }

  if (normPlan === "plus") {
    // Plus tier profiles are strictly forbidden from executing Extra High tier models (mu > 7.00)
    if (mu > 7.00 || tier.tierKey === "extra_high") {
      return {
        eligible: false,
        reason: THROTTLE_REASONS.PLUS_FORBIDDEN_EXTRA_HIGH,
        message: "Plus tier subscriptions do not include Extra High (Red Dot) compute models. Please upgrade to Pro to access flagship reasoning models.",
      };
    }
    return { eligible: true };
  }

  // Pro and Max have access to all tiers including Extra High
  return { eligible: true };
}

/**
 * Validates request against operational plan throttles (5-hour rolling and 24h daily).
 *
 * @param {Object} params
 * @param {string} params.plan - "free" | "plus" | "pro" | "max"
 * @param {number} params.calculatedMu - Multiplier mu of the requested model
 * @param {string} params.modality - "text" | "image"
 * @param {number} params.dailyPromptCount - Prompts consumed in active 24-hour window
 * @param {number} params.rollingHighComputeCount - High/Medium compute prompts in rolling 5-hour window
 * @param {number} params.rollingExtraHighCount - Extra-High prompts in rolling 5-hour window
 * @param {number} params.monthlyImageCount - Images generated in current monthly cycle
 * @returns {Object} { allowed: boolean, reason?: string, message?: string, resetWindowMs?: number }
 */
export function evaluatePlanThrottles({
  plan = "free",
  calculatedMu = 0,
  modality = "text",
  dailyPromptCount = 0,
  rollingHighComputeCount = 0,
  rollingExtraHighCount = 0,
  monthlyImageCount = 0,
  weeklyImageCount = 0,
  creditsActive = resolveCreditsPolicy().active,
} = {}) {
  const normPlan = String(plan || "free").toLowerCase();
  const planConfig = SUBSCRIPTION_PLAN_LIMITS[normPlan] || SUBSCRIPTION_PLAN_LIMITS.free;
  const mu = Number(calculatedMu || 0);
  const tier = mapMultiplierToTier(mu);

  // 1. Image Modality Controls
  if (modality === "image") {
    if (normPlan === "free") {
      const used = Number(weeklyImageCount ?? monthlyImageCount ?? 0);
      if (used >= FREE_IMAGES_PER_WEEK) {
        return {
          allowed: false,
          reason: THROTTLE_REASONS.IMAGE_QUOTA_EXCEEDED,
          message: `Weekly free image allowance reached (${FREE_IMAGES_PER_WEEK} images/week limit). More arrive Monday at 12:00 AM UTC.`,
        };
      }
      return { allowed: true };
    }

    if (planConfig.maxImagesPerMonth === 0) {
      return {
        allowed: false,
        reason: THROTTLE_REASONS.FREE_IMAGE_BLOCKADE,
        message: "Image Mode is strictly disabled on this account.",
      };
    }

    if (monthlyImageCount >= planConfig.maxImagesPerMonth) {
      return {
        allowed: false,
        reason: THROTTLE_REASONS.IMAGE_QUOTA_EXCEEDED,
        message: `Monthly image generation allowance reached (${planConfig.maxImagesPerMonth} images/month limit). Quotas reset at the start of your next billing cycle without rollover.`,
      };
    }

    return { allowed: true };
  }

  // 2. Free Tier 24-Hour Soft Throttle (15 prompts / 24 hours)
  // Bypassed when creditsActive is true: plan usage is governed by spendable AI credits.
  if (normPlan === "free") {
    const eligibility = isModelEligibleForPlan("free", { calculatedMu: mu });
    if (!eligibility.eligible) {
      return {
        allowed: false,
        reason: eligibility.reason,
        message: eligibility.message,
      };
    }

    if (!creditsActive && dailyPromptCount >= planConfig.dailyVolatileAllowancePrompts) {
      return {
        allowed: false,
        reason: THROTTLE_REASONS.FREE_DAILY_PROMPTS_EXCEEDED,
        message: "You have reached the Daily Volatile Allowance soft throttle of 15 prompts per 24 hours. Usage resets after the 24-hour cycle.",
        resetWindowMs: TWENTY_FOUR_HOUR_WINDOW_MS,
      };
    }

    return { allowed: true };
  }

  // 3. Plus Tier Throttles (40 high-compute prompts / 5h rolling, forbidden Extra High)
  if (normPlan === "plus") {
    const eligibility = isModelEligibleForPlan("plus", { calculatedMu: mu });
    if (!eligibility.eligible) {
      return {
        allowed: false,
        reason: eligibility.reason,
        message: eligibility.message,
      };
    }

    const isHighCompute = tier.tierKey === "high" || tier.tierKey === "medium" || mu > 1.00;
    if (!creditsActive && isHighCompute && rollingHighComputeCount >= planConfig.rollingHighComputeThrottlePrompts) {
      return {
        allowed: false,
        reason: THROTTLE_REASONS.PLUS_HIGH_COMPUTE_THROTTLED,
        message: "You have reached the 5-hour rolling throttle of 40 high-compute (Orange/Yellow) prompts for Plus. Capacity unlocks dynamically as the 5-hour window rolls forward.",
        resetWindowMs: FIVE_HOUR_WINDOW_MS,
      };
    }

    return { allowed: true };
  }

  // 4. Pro Tier Throttles (120 high-compute prompts / 5h rolling)
  if (normPlan === "pro") {
    const isHighCompute = tier.tierKey === "high" || tier.tierKey === "medium" || (mu > 1.00 && mu <= 7.00);
    if (!creditsActive && isHighCompute && rollingHighComputeCount >= planConfig.rollingHighComputeThrottlePrompts) {
      return {
        allowed: false,
        reason: THROTTLE_REASONS.PRO_HIGH_COMPUTE_THROTTLED,
        message: "You have reached the 5-hour rolling throttle of 120 high-compute prompts for Pro. Capacity unlocks dynamically as earlier requests roll outside the 5-hour window.",
        resetWindowMs: FIVE_HOUR_WINDOW_MS,
      };
    }

    return { allowed: true };
  }

  // 5. Max Tier Throttles (400 Extra-High prompts / 5h rolling)
  if (normPlan === "max") {
    const isExtraHigh = tier.tierKey === "extra_high" || mu > 7.00;
    if (!creditsActive && isExtraHigh && rollingExtraHighCount >= planConfig.rollingExtraHighThrottlePrompts) {
      return {
        allowed: false,
        reason: THROTTLE_REASONS.MAX_EXTRA_HIGH_THROTTLED,
        message: "You have reached the 5-hour rolling throttle of 400 Extra-High (Red Dot) prompts for Max. Capacity unlocks dynamically as the 5-hour window rolls forward.",
        resetWindowMs: FIVE_HOUR_WINDOW_MS,
      };
    }

    return { allowed: true };
  }

  return { allowed: true };
}

/**
 * Returns user allocation limit in blended tokens for given tier and mu.
 */
export function getPlanAllocationLimit(tier, mu) {
  return calculateUserAllocationLimitTokens(tier, mu);
}
