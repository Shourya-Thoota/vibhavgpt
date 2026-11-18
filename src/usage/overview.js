// The plain-language usage overview for GET /api/usage: what an account can use of images and documents, when that renews, and what its
// purchased balance can and cannot pay for. Pure: it reads what getCurrentUsage already measured and the plan table, and decides nothing
// new. Every number here is the one the server enforces (src/usage/service.js, src/generation/image-engine.js).
//
// A limit that is "Infinity" in code is sent as unlimited: true, never as a number or a null a screen could show as zero.

import { CREDIT_PURCHASE, CREDIT_SPEND, FLEX_FORMER_NAME, FLEX_NAME, purchaseEligibility } from "../../frontend/src/flex-credits.js";

const TIER_NAMES = Object.freeze({ free: "Free", plus: "Plus", pro: "Pro", max: "Max", paid: "Pro" });
const iso = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const whole = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : null);

/**
 * @param usage  the object from getCurrentUsage
 * @param limits { images, documents } for the plan, from GENERATION_LIMITS (documents may be Infinity)
 * @param flexBalance whole credits in the purchased balance
 */
export function buildUsageOverview({ usage, limits, flexBalance = 0 }) {
  const tier = usage?.tier === "paid" ? "pro" : usage?.tier ?? "free";
  const renewsAt = iso(usage?.imagePeriodEndsAt ?? usage?.periodEndsAt);

  const imageLimit = whole(limits?.images) ?? 0;
  const imagesUsed = whole(usage?.imageGenerationsThisPeriod) ?? 0;
  const images = {
    included: imageLimit > 0,
    limit: imageLimit,
    used: imagesUsed,
    remaining: Math.max(0, imageLimit - imagesUsed),
    // Free's is a fixed weekly count; every paid plan's is a month, from the plan's own period.
    period: usage?.imagePeriod === "week" ? "week" : "month",
    renewsAt,
    // Credits never add images: at the limit the request stops until the allowance renews.
    extras: { available: false },
  };

  const unlimitedDocuments = limits?.documents === Infinity;
  const documentLimit = unlimitedDocuments ? null : whole(limits?.documents) ?? 0;
  const documentsUsed = whole(usage?.documentGenerationsThisPeriod) ?? 0;
  const documents = {
    included: unlimitedDocuments || documentLimit > 0,
    unlimited: unlimitedDocuments,
    limit: documentLimit,
    used: documentsUsed,
    remaining: unlimitedDocuments ? null : Math.max(0, documentLimit - documentsUsed),
    period: "month",
    renewsAt,
    // Only a plan with a numbered allowance (Plus) can go past it, one credit per document.
    extras: { available: !unlimitedDocuments && documentLimit > 0, costCredits: CREDIT_SPEND.extraDocument },
  };

  const eligibility = purchaseEligibility(tier);
  const balance = whole(flexBalance) ?? 0;
  const flex = {
    name: FLEX_NAME,
    formerName: FLEX_FORMER_NAME,
    balance,
    // Whether buying more would be spendable on this plan; a balance already held stays visible and usable whatever the plan.
    canBuy: eligibility.eligible,
    uses: eligibility.uses,
    reason: eligibility.reason,
    action: eligibility.action,
    terms: {
      creditsPerDollar: CREDIT_PURCHASE.creditsPerDollar,
      minimumCents: CREDIT_PURCHASE.minimumCents,
      maximumCents: CREDIT_PURCHASE.maximumCents,
      stepCents: CREDIT_PURCHASE.stepCents,
      presets: [...CREDIT_PURCHASE.presets],
      expires: false,
    },
    fundsChatAndStudy: false,
  };

  return { plan: { tier, name: TIER_NAMES[tier] ?? "Free" }, images, documents, flex };
}
