import { APPROVED_FREE_MODEL_GROUP, PLAN_ALLOWANCES, getAvailableAllowance } from "./allowance-service.js";
import { getActiveSubscription, tierForSubscription } from "./service.js";
import { evaluateRoutingDecision, loadRegistrySnapshot } from "../models/decision.js";
import { PLAN_ELIGIBILITY } from "../models/registry.js";
import { config } from "../config.js";
import { ENFORCED_TIER_LABELS, enforcedTiersFor } from "./chat-allowance-policy.js";

let defaultDb = null;
async function getDefaultDb() {
  if (!defaultDb) {
    const clientModule = await import("../db/client.js");
    defaultDb = clientModule.db;
  }
  return defaultDb;
}

/**
 * Plans that carry a paid monthly AI allowance (actual upstream cost, no markup).
 */
export const SUBSCRIPTION_ALLOWANCE_PLANS = Object.freeze(["plus", "pro", "max"]);

/**
 * The models whose chat requests consume this account's allowance right now: the
 * enforcement gate, cutover time, tier list and plan all apply, and the registry has
 * an eligible endpoint for the tier. Customer surfaces say exactly this, so they never
 * imply enforcement that is not happening.
 */
export async function resolveEnforcedModels({ plan, registrySnapshot, now = new Date(), settings = config }) {
  const models = [];
  for (const tier of enforcedTiersFor({ plan, now, settings })) {
    // The same transport the gateway enforces on (Vulcan: CHAT_VESPER_TRANSPORT), so the summary never disagrees with enforcement.
    const decision = await evaluateRoutingDecision({ plan, requestedModel: { modelKey: tier }, transportPreference: tier === "vesper" ? config.vesperTransport : null }, { registrySnapshot, evaluatedAt: now.toISOString() });
    if (decision.eligible) models.push({ modelKey: tier, displayName: ENFORCED_TIER_LABELS[tier] });
  }
  return models;
}

export const PAID_USAGE_RESTRICTION_REASONS = Object.freeze({
  ALLOWANCE_EXHAUSTED: "allowance_exhausted",
  PENDING_HOLDS: "pending_usage_holds",
  NO_PAID_ALLOWANCE: "no_paid_allowance",
});

const FREE_CHOICE_UNAVAILABLE_MESSAGE = "This model is temporarily unavailable.";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Remaining balances round down and spending rounds up, so a rounded figure
// never overstates what is left.
function formatUsd(micros, mode) {
  const value = Math.max(0, Number(micros) || 0);
  const cents = mode === "up" ? Math.ceil(value / 10_000) : Math.floor(value / 10_000);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function isZeroCostPricing(pricing) {
  if (!pricing) return false;
  return pricing.inputPriceMicrosPerM === 0 &&
    pricing.outputPriceMicrosPerM === 0 &&
    (pricing.cachedReadPriceMicrosPerM == null || pricing.cachedReadPriceMicrosPerM === 0);
}

/**
 * Resolves which approved free choices can execute right now.
 *
 * A choice is offered only when it is in the explicit approved free group AND the
 * pure routing decision service finds an active, privacy-approved endpoint whose
 * pinned pricing is exactly zero and whose version is classified free. A display
 * label alone never establishes that an endpoint is approved or zero-cost.
 * This performs no provider calls, reservations, or ledger writes.
 */
export async function resolveApprovedFreeChoices({ plan, registrySnapshot, now = new Date() }) {
  const choices = [];
  for (const entry of APPROVED_FREE_MODEL_GROUP) {
    let available = false;
    if (entry.planEligibility === PLAN_ELIGIBILITY.FREE && registrySnapshot?.length) {
      const decision = await evaluateRoutingDecision(
        { plan, requestedModel: { familySlug: entry.familySlug } },
        { registrySnapshot, evaluatedAt: now.toISOString() },
      );
      available = Boolean(
        decision.eligible &&
        decision.selectedCandidate?.planEligibility === PLAN_ELIGIBILITY.FREE &&
        isZeroCostPricing(decision.pinnedPricing),
      );
    }
    choices.push({
      id: entry.familySlug.replace("/", "-"),
      modelKey: entry.modelKey,
      displayName: entry.displayName,
      description: entry.description,
      available,
      unavailableReason: available ? null : FREE_CHOICE_UNAVAILABLE_MESSAGE,
    });
  }
  return choices;
}

/**
 * Builds the customer-safe, read-only allowance summary for a verified account.
 *
 * The account and entitlement come only from server records. Reading the summary
 * never reserves, settles, releases, or dispatches anything.
 *
 * Exposes no ledger rows, request identifiers, provider names, endpoints, rates,
 * pricing versions, or diagnostics.
 */
export async function getAllowanceSummary({ userId, db = null, now = new Date(), registrySnapshot = null, settings = config } = {}) {
  if (!userId) throw new Error("userId is required");
  const executor = db || (await getDefaultDb());

  const subscription = await getActiveSubscription(userId, executor);
  const plan = tierForSubscription(subscription, now);
  const snapshot = registrySnapshot || (await loadRegistrySnapshot(executor));
  const freeChoices = await resolveApprovedFreeChoices({ plan, registrySnapshot: snapshot, now });
  const enforcedModels = await resolveEnforcedModels({ plan, registrySnapshot: snapshot, now, settings });

  if (!SUBSCRIPTION_ALLOWANCE_PLANS.includes(plan)) {
    return {
      plan,
      allowance: null,
      paidUsage: { restricted: true, reason: PAID_USAGE_RESTRICTION_REASONS.NO_PAID_ALLOWANCE },
      freeChoices,
      enforcementConnected: enforcedModels.length > 0,
      enforcedModels,
    };
  }

  const balance = await getAvailableAllowance(userId, { plan, now }, executor);
  const includedMicros = PLAN_ALLOWANCES[plan].monthlyAllowanceMicros;
  const confirmedMicros = balance.monthly.confirmedMicros;
  const pendingMicros = balance.monthly.pendingMicros;
  const availableMicros = Math.max(0, balance.availableMicros);
  const resetAt = new Date(balance.monthly.periodEnd);
  const billingTermEndsAt = subscription?.currentPeriodEndsAt ? new Date(subscription.currentPeriodEndsAt) : null;

  let reason = null;
  if (availableMicros <= 0) {
    reason = confirmedMicros >= includedMicros
      ? PAID_USAGE_RESTRICTION_REASONS.ALLOWANCE_EXHAUSTED
      : PAID_USAGE_RESTRICTION_REASONS.PENDING_HOLDS;
  }

  return {
    plan,
    allowance: {
      currency: "USD",
      includedMicros,
      confirmedMicros,
      pendingMicros,
      availableMicros,
      display: {
        included: formatUsd(includedMicros, "down"),
        confirmed: formatUsd(confirmedMicros, "up"),
        pending: formatUsd(pendingMicros, "up"),
        available: formatUsd(availableMicros, "down"),
      },
      periodStartedAt: new Date(balance.monthly.periodStart).toISOString(),
      resetAt: resetAt.toISOString(),
      resetCadence: "monthly",
      // True for annual Plus/Pro: the allowance refreshes monthly inside a longer billing term.
      // A one-day tolerance keeps small provider/anchor clock differences on monthly plans false.
      billingTermExtendsBeyondReset: Boolean(billingTermEndsAt && billingTermEndsAt.getTime() > resetAt.getTime() + ONE_DAY_MS),
    },
    paidUsage: { restricted: reason !== null, reason },
    freeChoices,
    enforcementConnected: enforcedModels.length > 0,
    enforcedModels,
  };
}
