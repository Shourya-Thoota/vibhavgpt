import { config } from "../config.js";
import { resolveCreditsPolicy } from "./credits.js";

/**
 * Whether native chat consumes the subscription allowance for a request. Pure: it reads
 * only the settings it is given, so the summary API, the chat gateway and tests agree.
 * Usage before the cutover timestamp is never charged.
 *
 * When AI credits are the active policy they are the only included text-usage
 * allowance, so this dollar-based allowance steps aside and never governs a
 * request alongside them.
 */

export const ALLOWANCE_SUBSCRIBER_PLANS = Object.freeze(["plus", "pro", "max"]);
// Nova and Nebula were retired on 2026-11-14 and are no longer enforceable tiers.
export const ENFORCEABLE_TIERS = Object.freeze(["study", "vesper"]);
export const ENFORCED_TIER_LABELS = Object.freeze({
  nova: "VibhavGPT Nova",
  study: "VibhavGPT Study",
  nebula: "VibhavGPT Nebula",
  vesper: "VibhavGPT Vulcan",
});

export const ENFORCEMENT_REASONS = Object.freeze({
  ENFORCED: "enforced",
  GATE_OFF: "gate_off",
  BEFORE_CUTOVER: "before_cutover",
  TIER_NOT_ENFORCED: "tier_not_enforced",
  PLAN_NOT_SUBSCRIBED: "plan_not_subscribed",
  SUPERSEDED_BY_CREDITS: "superseded_by_credits",
});

export function chatAllowanceEnforcement({ modelKey, plan, now = new Date(), settings = config } = {}) {
  if (resolveCreditsPolicy(settings, now).active) return { enforced: false, reason: ENFORCEMENT_REASONS.SUPERSEDED_BY_CREDITS };
  if (!settings.featureChatAllowanceEnforcement) return { enforced: false, reason: ENFORCEMENT_REASONS.GATE_OFF };
  const activatedAt = settings.chatAllowanceActivatedAt;
  if (!(activatedAt instanceof Date) || now < activatedAt) return { enforced: false, reason: ENFORCEMENT_REASONS.BEFORE_CUTOVER };
  if (!settings.chatAllowanceEnforcedTiers?.includes(String(modelKey).toLowerCase())) return { enforced: false, reason: ENFORCEMENT_REASONS.TIER_NOT_ENFORCED };
  if (!ALLOWANCE_SUBSCRIBER_PLANS.includes(plan)) return { enforced: false, reason: ENFORCEMENT_REASONS.PLAN_NOT_SUBSCRIBED };
  return { enforced: true, reason: ENFORCEMENT_REASONS.ENFORCED };
}

/** The tiers whose requests consume this plan's allowance right now (before registry readiness). */
export function enforcedTiersFor({ plan, now = new Date(), settings = config } = {}) {
  return ENFORCEABLE_TIERS.filter((tier) => chatAllowanceEnforcement({ modelKey: tier, plan, now, settings }).enforced);
}
