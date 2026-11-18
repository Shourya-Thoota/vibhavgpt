/**
 * Image Generation Mode Execution & Routing Framework (Section 3.5).
 *
 * Implements:
 * 1. Dedicated OpenRouter-brokered or Native image processing engine layout
 * 2. Free Tier: 2 images per fixed UTC week (Monday 00:00 UTC), at no more than the one image route all plans use
 * 3. Paid Tier Authorization & Hard Reset Cycle Limits:
 *    - Plus: 100 images/month
 *    - Pro: 400 images/month
 *    - Max: 1,500 images/month
 *    - Strict non-rollover invariant (does not roll over month-to-month)
 * 4. Programmatic Cost Synchronization Equation (alpha = 1.10 markup)
 */

import { PROFIT_MARGIN_MODIFIER, SUBSCRIPTION_PLAN_LIMITS } from "../models/pricing-engine.js";
import { accessError } from "../../frontend/src/access-status.js";

export const IMAGE_GENERATION_MODELS = Object.freeze({
  FLUX_SCHNELL: "black-forest-labs/flux-schnell",
  FLUX_DEV: "black-forest-labs/flux-dev",
  STABLE_DIFFUSION_3: "stabilityai/stable-diffusion-3-medium",
  NATIVE_FALLBACK: "__native_image__",
});

// Free gets a small fixed weekly allowance: 2 images in each UTC week, which starts on Monday at 00:00 UTC. It is a fixed window,
// not a rolling one, so "more arrive Monday" is true. Paid plans keep their monthly allowances below.
export const FREE_IMAGES_PER_WEEK = 2;

/** The UTC week that contains `now`: from Monday 00:00:00.000 UTC up to (not including) the next Monday. */
export function utcWeekWindow(now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7; // Monday 0 ... Sunday 6
  const start = new Date(day.getTime() - sinceMonday * 86_400_000);
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

export const IMAGE_MODE_PLAN_QUOTAS = Object.freeze({
  free: Object.freeze({
    tier: "free",
    quotaPerWeek: FREE_IMAGES_PER_WEEK,
    quotaPerMonth: 0,
    allowed: true,
  }),
  plus: Object.freeze({
    tier: "plus",
    quotaPerMonth: 100,
    allowed: true,
  }),
  pro: Object.freeze({
    tier: "pro",
    quotaPerMonth: 400,
    allowed: true,
  }),
  max: Object.freeze({
    tier: "max",
    quotaPerMonth: 1500,
    allowed: true,
  }),
});

/**
 * Validates plan authorization for Image Generation Mode.
 *
 * @param {string} plan - "free" | "plus" | "pro" | "max"
 * @param {number} currentMonthUsed - Image count in the current billing cycle
 * @returns {Object} { authorized: boolean, quota: number, remaining: number, error?: Error }
 */
export function authorizeImageGeneration(plan = "free", currentMonthUsed = 0, { now = new Date() } = {}) {
  const normPlan = String(plan || "free").toLowerCase();
  const planQuota = IMAGE_MODE_PLAN_QUOTAS[normPlan] || IMAGE_MODE_PLAN_QUOTAS.free;

  // Free: a weekly allowance, counted from Monday 00:00 UTC. `currentMonthUsed` is the count in that week for Free.
  if (planQuota.quotaPerWeek > 0) {
    const quota = planQuota.quotaPerWeek;
    const used = Math.max(0, Number(currentMonthUsed) || 0);
    const remaining = Math.max(0, quota - used);
    const window = utcWeekWindow(now);
    if (remaining <= 0) {
      const error = accessError("quota", {
        feature: "Free image allowance",
        limit: quota,
        used,
        window: "week",
        resetAt: window.end,
        publicMessage: `You've used your ${quota} free images this week. More arrive Monday at 12:00 AM UTC.`,
        code: "image_quota_exhausted",
      });
      error.status = 429;
      error.code = "image_quota_exhausted";
      return { authorized: false, quota, remaining: 0, window: "week", resetAt: window.end, error };
    }
    return { authorized: true, quota, remaining, window: "week", resetAt: window.end };
  }

  // Zero allowance (an unknown plan): refused.
  if (!planQuota.allowed || planQuota.quotaPerMonth === 0) {
    const error = accessError("plan", {
      feature: "Image generation",
      requiredPlan: "Plus, Pro, or Max",
    });
    error.status = 403;
    error.code = "free_image_blockade";
    return {
      authorized: false,
      quota: 0,
      remaining: 0,
      error,
    };
  }

  const used = Math.max(0, Number(currentMonthUsed) || 0);
  const remaining = Math.max(0, planQuota.quotaPerMonth - used);

  if (remaining <= 0) {
    const error = accessError("quota", {
      feature: "Monthly image generation quota",
      limit: planQuota.quotaPerMonth,
      // Says which allowance ran out, that purchased credits cannot add images, and where the date is (Usage shows it from the plan's own period).
      publicMessage: `You've used all ${planQuota.quotaPerMonth} images included with your plan for this period. Image & document credits can't buy extra images. Your allowance renews on the date shown in Usage.`,
      code: "image_quota_exhausted",
    });
    error.status = 429;
    error.code = "image_quota_exhausted";
    return {
      authorized: false,
      quota: planQuota.quotaPerMonth,
      remaining: 0,
      error,
    };
  }

  return {
    authorized: true,
    quota: planQuota.quotaPerMonth,
    remaining,
  };
}

/**
 * Selects image routing engine endpoint (OpenRouter-brokered or Native).
 *
 * @param {Object} options
 * @param {string} options.requestedModel - Explicit model ID or "auto"
 * @param {string} options.plan - User plan
 * @returns {Object} { engineType, modelId, endpointType }
 */
export function resolveImageRoutingEngine({ requestedModel = "auto", plan = "plus" } = {}) {
  const normPlan = String(plan || "free").toLowerCase();
  if (normPlan === "free") {
    throw new Error("Free tier users cannot resolve image generation routing engines.");
  }

  const modelKey = String(requestedModel || "auto").toLowerCase();

  if (modelKey.includes("flux-dev") && (normPlan === "pro" || normPlan === "max")) {
    return {
      engineType: "openrouter_brokered",
      modelId: IMAGE_GENERATION_MODELS.FLUX_DEV,
      providerTier: "pro_flagship",
    };
  }

  if (modelKey.includes("sd3") || modelKey.includes("stable-diffusion")) {
    return {
      engineType: "openrouter_brokered",
      modelId: IMAGE_GENERATION_MODELS.STABLE_DIFFUSION_3,
      providerTier: "standard",
    };
  }

  // Default paid image engine: FLUX Schnell / Native
  return {
    engineType: "openrouter_brokered",
    modelId: IMAGE_GENERATION_MODELS.FLUX_SCHNELL,
    providerTier: "fast_turnaround",
  };
}

/**
 * Programmatic Cost Synchronization Equation (Section 3.5).
 * Calculates execution overhead dynamically using the exact profit-adjusted pricing architecture (alpha = 1.10).
 *
 * @param {number} rawProviderCostUsd - Raw provider cost in USD (e.g. $0.04)
 * @returns {Object} { rawCostMicros, markedUpCostMicros, markedUpUsd }
 */
export function calculateImageExecutionOverhead(rawProviderCostUsd) {
  const rawUsd = Math.max(0, Number(rawProviderCostUsd) || 0);
  const rawCostMicros = Math.round(rawUsd * 1_000_000);

  // Exact 10% profit margin markup (alpha = 1.10)
  const markedUpCostMicros = Math.ceil(Math.round(rawCostMicros * 110) / 100);
  const markedUpUsd = markedUpCostMicros / 1_000_000;

  return {
    rawCostMicros,
    markedUpCostMicros,
    markedUpUsd,
    marginFactor: PROFIT_MARGIN_MODIFIER,
  };
}
