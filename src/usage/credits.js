// AI credits on the server: which policy is active, how the existing spend
// ledger rows are attributed to the fixed weekly windows, and the admission
// decision with its customer messages.
//
// This module is pure (no database, no import of the usage service) so the
// service can use it inside its own transaction and tests can drive it with
// plain rows. The allocation and balance formulas live in the shared
// frontend/src/credits-policy.js; nothing is recomputed here.

import { config } from "../config.js";
import { accessError } from "../../frontend/src/access-status.js";
import {
  CARRY_MODES,
  CREDIT_MICROS,
  CREDITS_POLICY_VERSION,
  allocationSchedule,
  computeCreditBalance,
  monthlyCreditsFor,
  normalizeCarryMode,
  windowIndexAt,
} from "../../frontend/src/credits-policy.js";

export const CREDITS_POLICY_REASONS = Object.freeze({
  ACTIVE: "active",
  DISABLED: "disabled",
  CARRY_MODE_UNSELECTED: "carry_mode_unselected",
  ACTIVATION_TIME_UNSET: "activation_time_unset",
  BEFORE_ACTIVATION: "before_activation",
});

export const CREDITS_DENIAL_CODES = Object.freeze({
  WEEK_EXHAUSTED: "credits_week_exhausted",
  MONTH_EXHAUSTED: "credits_month_exhausted",
  REQUEST_EXCEEDS_BALANCE: "credits_request_exceeds_balance",
});

/**
 * The server's credits policy for the given settings at `now`. Credits are active only when
 * all of these hold, so there is no silent default and no half-on state:
 *   1. the policy is enabled,
 *   2. a carry mode ("expiry" or "carry") has been chosen,
 *   3. an activation instant is set, and
 *   4. that instant has been reached (a future instant keeps the existing gates in force).
 * `activatedAt` is the start of the fresh credit period for every account.
 */
export function resolveCreditsPolicy(settings = config, now = new Date()) {
  const base = { version: CREDITS_POLICY_VERSION, carryMode: null, activatedAt: null };
  if (settings?.creditsPolicyEnabled !== true) return { ...base, active: false, reason: CREDITS_POLICY_REASONS.DISABLED };
  const carryMode = normalizeCarryMode(settings.creditsCarryMode);
  if (!carryMode) return { ...base, active: false, reason: CREDITS_POLICY_REASONS.CARRY_MODE_UNSELECTED };
  const activatedAt = settings.creditsActivatedAt instanceof Date && !Number.isNaN(settings.creditsActivatedAt.getTime()) ? settings.creditsActivatedAt : null;
  if (!activatedAt) return { ...base, carryMode, active: false, reason: CREDITS_POLICY_REASONS.ACTIVATION_TIME_UNSET };
  if (new Date(now).getTime() < activatedAt.getTime()) return { ...base, carryMode, activatedAt, active: false, reason: CREDITS_POLICY_REASONS.BEFORE_ACTIVATION };
  return { ...base, carryMode, activatedAt, active: true, reason: CREDITS_POLICY_REASONS.ACTIVE };
}

/** The carry mode the assistant's product facts should describe, or null while credits are off. */
export function creditsKnowledgeMode(settings = config, now = new Date()) {
  const policy = resolveCreditsPolicy(settings, now);
  return policy.active ? policy.carryMode : null;
}

/** What the API tells any client about the policy. No secrets, no provider detail. */
export function publicCreditsPolicy(policy = resolveCreditsPolicy()) {
  return {
    version: policy.version,
    active: policy.active,
    carryMode: policy.active ? policy.carryMode : null,
    // When credits are scheduled but not yet reached, the chosen mode and instant are shown so a
    // deployment check can tell "scheduled" from "never configured".
    scheduledFor: policy.reason === CREDITS_POLICY_REASONS.BEFORE_ACTIVATION ? policy.activatedAt.toISOString() : null,
    activatedAt: policy.active ? policy.activatedAt.toISOString() : null,
    reason: policy.reason,
    unit: { creditMicros: CREDIT_MICROS },
  };
}

// Image, document, voice and other generation products write pseudo-model rows
// ("__image__", ...). They have their own count-based entitlements and Flex
// Credits, so they neither draw on AI credits nor add estimate holds to them.
export const isTextUsageRow = (model) => !String(model ?? "").startsWith("__");

/**
 * Accounted spend per weekly window. A settled row counts its debit (provider
 * cost with the markup applied once, supplied by the caller); an unsettled row
 * counts its hold estimate. A row belongs to the window in which the request
 * started, so a call that settles after a boundary still counts where it began.
 */
export function creditSpendByWindow(events, schedule, { debitMicros, holdMicros }) {
  const spent = schedule.windows.map(() => 0);
  const last = schedule.windows.length - 1;
  for (const event of events) {
    if (!isTextUsageRow(event.model)) continue;
    const committed = Number(event.costMicros) > 0 ? debitMicros(Number(event.costMicros), event) : holdMicros(event);
    if (!(committed > 0)) continue;
    const index = windowIndexAt(schedule, event.createdAt);
    if (index < 0) continue; // before this period: not this period's spend
    spent[Math.min(index, last)] += committed;
  }
  return spent;
}

/**
 * Whether a request holding `incomingHoldMicros` can be admitted now.
 * `ok` compares against signed headroom, so an account already over its
 * allowance is refused even for a zero-cost hold, exactly as the monthly
 * budget behaves today.
 */
export function evaluateCreditAdmission({ plan, period, now, carryMode, activatedAt = null, events, incomingHoldMicros, debitMicros, holdMicros }) {
  const schedule = allocationSchedule({ periodStart: period.start, periodEnd: period.end, monthlyCredits: monthlyCreditsFor(plan), activatedAt });
  const spentByWindowMicros = creditSpendByWindow(events, schedule, { debitMicros, holdMicros });
  const balance = computeCreditBalance({ schedule, now, carryMode, spentByWindowMicros });
  const hold = Math.max(0, Number(incomingHoldMicros) || 0);
  return { schedule, spentByWindowMicros, balance, ok: hold <= balance.headroomMicros, incomingHoldMicros: hold };
}

/**
 * The refusal, worded for exactly what ran out. Three cases, three codes:
 * this week's allocation, the monthly allowance, or one request that needs
 * more than what is left. Each sentence stands alone; `resetAt` carries the
 * accurate time (the week's reset, the next allocation, or the monthly reset)
 * and the screen words it. Security rate limits and image & document credits (once Flex Credits) have their own
 * errors and are never reported as AI credits.
 */
export function creditDenial({ balance, incomingHoldMicros }) {
  const mode = balance.carryMode;
  const requestTooLarge = balance.availableMicros > 0 && incomingHoldMicros > balance.availableMicros;
  const hasNextAllocation = balance.nextAllocationAtMs !== null;
  let code;
  let window;
  let message;
  let resetMs = hasNextAllocation ? balance.nextAllocationAtMs : balance.resetsAtMs;
  if (requestTooLarge) {
    code = CREDITS_DENIAL_CODES.REQUEST_EXCEEDS_BALANCE;
    window = hasNextAllocation ? "week" : "month";
    message = "This request needs more AI credits than you have available right now. Try a shorter message or conversation.";
  } else if (balance.exhausted === "week") {
    code = CREDITS_DENIAL_CODES.WEEK_EXHAUSTED;
    window = "week";
    message = mode === CARRY_MODES.EXPIRY
      ? "You've used this week's AI credits."
      : "You've used all the AI credits allocated so far this month.";
  } else {
    code = CREDITS_DENIAL_CODES.MONTH_EXHAUSTED;
    window = "month";
    resetMs = balance.resetsAtMs;
    message = "You've used this month's AI credits.";
  }
  const error = accessError("quota", {
    feature: "AI credits",
    publicMessage: message,
    resetAt: new Date(resetMs),
    window,
    requestTooLarge,
    used: balance.consumedMicros,
    limit: balance.monthlyMicros,
    detail: { creditsMode: mode, resetKind: window === "month" ? "monthly-reset" : (mode === CARRY_MODES.EXPIRY ? "week-reset" : "next-allocation") },
  });
  return Object.assign(error, { code, status: 429 });
}

/**
 * The customer-safe credits object for GET /api/usage. Integer micro-dollars
 * plus the schedule; the browser formats them with the shared helpers.
 */
export function creditsSummary({ policy, plan, period, schedule, balance, flexCreditBalance = 0 }) {
  const iso = (ms) => new Date(ms).toISOString();
  return {
    active: true,
    policyVersion: policy.version,
    carryMode: policy.carryMode,
    plan,
    unit: { creditMicros: CREDIT_MICROS },
    // startsAt is when this credit period began for the account: the 1st of the month, or the
    // activation instant in the month credits were switched on (monthStartsAt is always the 1st).
    period: {
      basis: period.basis, startsAt: iso(schedule.startMs), monthStartsAt: iso(schedule.periodStartMs), endsAt: iso(schedule.endMs), days: schedule.days,
      activation: schedule.activatedAtMs === null ? null : { at: iso(schedule.activatedAtMs), foldedCredits: schedule.foldedCredits, firstWeekPartial: schedule.firstWindowPartial },
    },
    monthly: {
      credits: schedule.monthlyCredits,
      micros: schedule.monthlyMicros,
      consumedMicros: balance.consumedMicros,
      remainingMicros: balance.monthlyRemainingMicros,
    },
    week: {
      index: balance.window.index,
      count: balance.window.count,
      startsAt: iso(balance.window.startMs),
      endsAt: iso(balance.window.endMs),
      isFinal: balance.window.isFinal,
      allocationCredits: balance.window.allocationCredits,
      allocationMicros: balance.window.allocationMicros,
      consumedMicros: balance.window.consumedMicros,
    },
    available: { micros: balance.availableMicros, carriedInMicros: balance.carriedInMicros },
    allocatedToDateMicros: balance.allocatedToDateMicros,
    futureAllocationMicros: balance.futureAllocationMicros,
    nextAllocationAt: balance.nextAllocationAtMs === null ? null : iso(balance.nextAllocationAtMs),
    resetsAt: iso(balance.resetsAtMs),
    exhausted: balance.exhausted,
    schedule: schedule.windows.map((window) => ({ startsAt: iso(window.startMs), endsAt: iso(window.endMs), credits: window.credits })),
    // Purchased Flex Credits are a separate balance. They pay for images and
    // documents beyond plan allowances and never add AI credits.
    purchased: { kind: "flex", balance: flexCreditBalance, coversText: false },
  };
}
