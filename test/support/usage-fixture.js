// A GET /api/usage payload for a test, built with the server's own calculations (the allocation schedule, the balance, the credits summary
// and the overview), so a screen test runs against real numbers and not hand-typed ones. No database, no provider, no account.
import { creditsSummary, evaluateCreditAdmission } from "../../src/usage/credits.js";
import { buildUsageOverview } from "../../src/usage/overview.js";
import { CREDIT_MICROS } from "../../frontend/src/credits-policy.js";

// What each plan includes, written here on purpose: a test of the screen must not move when a limit is edited elsewhere without a decision.
export const PLAN_LIMITS = Object.freeze({
  free: { images: 2, documents: 0 },
  plus: { images: 100, documents: 20 },
  pro: { images: 400, documents: Infinity },
  max: { images: 1500, documents: Infinity },
});

const NOW = new Date("2026-11-11T15:00:00.000Z"); // a Wednesday, in the second weekly window of November

export function usagePayload({
  tier = "plus",
  now = NOW,
  carryMode = "carry",
  creditsActive = true,
  spentCredits = 0, // AI credits spent this month
  spentAt, // when it was spent (a Date); the first minute of the month unless given
  flex = 0, // purchased balance, whole credits
  imagesUsed = 0,
  documentsUsed = 0,
  limits = PLAN_LIMITS[tier],
  imagePeriod, // "week" for Free, otherwise "month"
  period = { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1), basis: "calendar-month" },
  includeOverview = true,
} = {}) {
  const at = new Date(now);
  const base = {
    tier,
    creditBalance: flex,
    imageGenerationsThisPeriod: imagesUsed,
    documentGenerationsThisPeriod: documentsUsed,
    imageLimit: limits.images,
    documentLimit: limits.documents,
    imagePeriod: imagePeriod ?? (tier === "free" ? "week" : "month"),
    imagePeriodEndsAt: tier === "free" ? new Date(Date.UTC(2026, 10, 16)).toISOString() : new Date(period.end).toISOString(),
    periodEndsAt: new Date(period.end).toISOString(),
    tokenBreakdown: {}, rollingTokenBreakdown: {}, nextRollingTokenReleaseAt: {},
  };
  let credits = null;
  if (creditsActive) {
    const events = spentCredits > 0 ? [{ model: "nova", costMicros: spentCredits * CREDIT_MICROS, reservedTokens: 0, createdAt: spentAt ? new Date(spentAt) : new Date(period.start + 60_000) }] : [];
    const decision = evaluateCreditAdmission({
      plan: tier, period, now: at, carryMode, activatedAt: null, events, incomingHoldMicros: 0,
      debitMicros: (micros) => micros, holdMicros: () => 0,
    });
    credits = creditsSummary({ policy: { version: 1, carryMode }, plan: tier, period, schedule: decision.schedule, balance: decision.balance, flexCreditBalance: flex });
  }
  const overview = includeOverview ? buildUsageOverview({ usage: base, limits, flexBalance: flex }) : undefined;
  // What the browser receives: JSON.
  return JSON.parse(JSON.stringify({ ...base, limits: {}, creditCosts: {}, policy: { active: creditsActive, carryMode: creditsActive ? carryMode : null }, credits, overview }));
}

export const NEXT_NOW = NOW;
