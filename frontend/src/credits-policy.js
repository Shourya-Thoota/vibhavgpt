// AI credits: the one authoritative calculation, shared by the server (admission,
// API) and the browser (usage display, copy). Pure and dependency-free so both
// sides import this file and neither keeps a formula of its own.
//
// 1 AI credit = 50,000 micro-dollars ($0.05) of the existing accounted allowance.
// "Accounted" means the debit the ledger already computes: the provider cost
// with the approved 1.10 markup applied once. Nothing here applies a markup.
//
// Every amount is an integer. Balances are integer micro-dollars; allocations
// are whole credits. A call is charged its exact fractional credit cost, so a
// balance below one credit is real and spendable.

export const CREDITS_POLICY_VERSION = "credits-2026-11-a";
export const CREDIT_MICROS = 50_000;

// Monthly included credits. Max is configured here and is not on sale.
export const MONTHLY_CREDITS = Object.freeze({ free: 5, plus: 60, pro: 180, max: 800 });

export const CARRY_MODES = Object.freeze({ EXPIRY: "expiry", CARRY: "carry" });

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** "expiry" | "carry", or null. Anything else is not a selection. */
export function normalizeCarryMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === CARRY_MODES.EXPIRY || mode === CARRY_MODES.CARRY ? mode : null;
}

export function monthlyCreditsFor(plan) {
  const key = String(plan ?? "free").toLowerCase();
  return MONTHLY_CREDITS[key === "paid" ? "pro" : key] ?? MONTHLY_CREDITS.free;
}

export const creditsToMicros = (credits) => credits * CREDIT_MICROS;
export const monthlyAllowanceMicros = (plan) => creditsToMicros(monthlyCreditsFor(plan));

const toMs = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

// Round half up for non-negative integers, in integer arithmetic only.
const roundDiv = (numerator, denominator) => Math.floor((2 * numerator + denominator) / (2 * denominator));

/**
 * The fixed weekly windows of one monthly allowance period.
 *
 * Windows start at the period start and run seven days each: days 1-7, 8-14,
 * 15-21, 22-28, then whatever days remain form a final partial window. A full
 * window gets round(monthly x 7 / days in period) credits; the final window
 * gets exactly what is left, so the windows always add up to the month and a
 * month can never grant a fifth full week. Windows are half-open [start, end).
 *
 * In a 28-day period the fourth full week is the final window and takes the
 * remainder.
 *
 * Activation inside a month. When `activatedAt` falls after the period starts, the
 * credit period begins at that instant. The weeks keep their fixed boundaries, so the
 * window holding the activation instant becomes a shorter first window, and the credits
 * of every week that began before it are folded into that first window. The month's
 * total therefore stays exactly the plan's monthly credits, and nothing before the
 * activation instant belongs to the period (windowIndexAt returns -1 for it). Activating
 * at the period start folds nothing.
 */
export function allocationSchedule({ periodStart, periodEnd, monthlyCredits, activatedAt = null }) {
  const startMs = toMs(periodStart);
  const endMs = toMs(periodEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new RangeError("An allowance period must end after it starts.");
  }
  if (!Number.isInteger(monthlyCredits) || monthlyCredits < 0) {
    throw new RangeError("Monthly credits must be a whole number.");
  }
  const activatedMs = activatedAt == null ? null : toMs(activatedAt);
  if (activatedMs !== null && !Number.isFinite(activatedMs)) throw new RangeError("An activation time must be a valid time.");
  if (activatedMs !== null && activatedMs >= endMs) throw new RangeError("An activation time must fall before the period ends.");
  const durationMs = endMs - startMs;
  const fullWeekCredits = roundDiv(monthlyCredits * WEEK_MS, durationMs);
  const count = Math.ceil(durationMs / WEEK_MS);
  const windows = [];
  let remaining = monthlyCredits;
  let cumulativeCredits = 0;
  for (let index = 0; index < count; index += 1) {
    const windowStart = startMs + index * WEEK_MS;
    const windowEnd = Math.min(windowStart + WEEK_MS, endMs);
    const isFinal = index === count - 1;
    const credits = isFinal ? remaining : Math.min(fullWeekCredits, remaining);
    remaining -= credits;
    cumulativeCredits += credits;
    windows.push({
      index,
      startMs: windowStart,
      endMs: windowEnd,
      isFinal,
      credits,
      micros: creditsToMicros(credits),
      cumulativeCredits,
      cumulativeMicros: creditsToMicros(cumulativeCredits),
    });
  }
  // Mid-period activation: fold the weeks that began before it into the first window.
  let effectiveStartMs = startMs;
  let foldedCredits = 0;
  let firstWindowPartial = false;
  if (activatedMs !== null && activatedMs > startMs) {
    const at = windows.findIndex((window) => activatedMs >= window.startMs && activatedMs < window.endMs);
    const holding = windows[at];
    effectiveStartMs = activatedMs;
    foldedCredits = holding.cumulativeCredits - holding.credits;
    firstWindowPartial = activatedMs > holding.startMs;
    windows.splice(0, at + 1, {
      ...holding,
      startMs: activatedMs,
      credits: holding.cumulativeCredits,
      micros: holding.cumulativeMicros,
    });
    windows.forEach((window, index) => { window.index = index; });
  }
  return {
    startMs: effectiveStartMs,
    periodStartMs: startMs,
    endMs,
    days: durationMs / DAY_MS,
    monthlyCredits,
    monthlyMicros: creditsToMicros(monthlyCredits),
    fullWeekCredits,
    activatedAtMs: activatedMs !== null && activatedMs > startMs ? activatedMs : null,
    foldedCredits,
    firstWindowPartial,
    windows,
  };
}

/** Index of the window containing the instant, -1 before the period, windows.length at or after its end. */
export function windowIndexAt(schedule, at) {
  const ms = toMs(at);
  if (ms < schedule.startMs) return -1;
  if (ms >= schedule.endMs) return schedule.windows.length;
  return schedule.windows.findIndex((window) => ms >= window.startMs && ms < window.endMs);
}

/**
 * What can be spent now, by policy.
 *
 * expiry  Only this week's allocation, less what was spent in this window.
 *         Unused credits expire at the boundary and are never spendable later.
 * carry   Everything allocated so far this month, less everything spent this
 *         month. Future windows are never available early.
 *
 * spentByWindowMicros[i] is the accounted spend (settled debits plus pending
 * holds) attributed to window i by when the request started.
 */
export function computeCreditBalance({ schedule, now, carryMode, spentByWindowMicros }) {
  const mode = normalizeCarryMode(carryMode);
  if (!mode) throw new RangeError("A carry mode of expiry or carry is required.");
  const last = schedule.windows.length - 1;
  const found = windowIndexAt(schedule, now);
  const index = found < 0 ? 0 : Math.min(found, last);
  const window = schedule.windows[index];
  const spent = schedule.windows.map((_, i) => Math.max(0, Number(spentByWindowMicros?.[i]) || 0));
  const consumedMicros = spent.reduce((sum, value) => sum + value, 0);
  const spentBefore = spent.slice(0, index).reduce((sum, value) => sum + value, 0);
  const allocatedBeforeMicros = index > 0 ? schedule.windows[index - 1].cumulativeMicros : 0;

  // Headroom may be negative after an overspend; availability never is. Under expiry
  // the window's own allocation is the limit, but the month is still a hard ceiling:
  // a run-over in an earlier week must not let later weeks spend past the monthly
  // allowance (under carry the cumulative figure already respects it).
  const monthlyHeadroomMicros = schedule.monthlyMicros - consumedMicros;
  const headroomMicros = mode === CARRY_MODES.EXPIRY
    ? Math.min(window.micros - spent[index], monthlyHeadroomMicros)
    : window.cumulativeMicros - consumedMicros;
  const availableMicros = Math.max(0, headroomMicros);
  const monthlyRemainingMicros = Math.max(0, monthlyHeadroomMicros);
  const futureAllocationMicros = schedule.monthlyMicros - window.cumulativeMicros;

  let exhausted = null;
  if (availableMicros <= 0) exhausted = index < last && monthlyRemainingMicros > 0 ? "week" : "month";

  return {
    carryMode: mode,
    monthlyCredits: schedule.monthlyCredits,
    monthlyMicros: schedule.monthlyMicros,
    consumedMicros,
    monthlyRemainingMicros,
    window: {
      index,
      count: schedule.windows.length,
      startMs: window.startMs,
      endMs: window.endMs,
      isFinal: window.isFinal,
      allocationCredits: window.credits,
      allocationMicros: window.micros,
      consumedMicros: spent[index],
    },
    allocatedToDateMicros: window.cumulativeMicros,
    futureAllocationMicros,
    // Unspent credit from earlier weeks that is still spendable (carry only).
    carriedInMicros: mode === CARRY_MODES.CARRY ? Math.max(0, allocatedBeforeMicros - spentBefore) : 0,
    headroomMicros,
    availableMicros,
    nextAllocationAtMs: index < last ? window.endMs : null,
    resetsAtMs: schedule.endMs,
    exhausted,
  };
}

// ---- Display ---------------------------------------------------------------
// A balance rounds down and spending rounds up, so a shown figure never
// overstates what is left. Amounts show to the hundredth of a credit, trimmed.

const HUNDREDTH_MICROS = CREDIT_MICROS / 100;

function hundredthsText(hundredths) {
  const whole = Math.floor(hundredths / 100);
  const fraction = hundredths % 100;
  if (!fraction) return String(whole);
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

/** "13.4", "1", "0.04". A positive balance too small to show reads "less than 0.01". */
export function formatCredits(micros, mode = "down") {
  const value = Math.max(0, Math.round(Number(micros) || 0));
  const hundredths = mode === "up" ? Math.ceil(value / HUNDREDTH_MICROS) : Math.floor(value / HUNDREDTH_MICROS);
  if (value > 0 && hundredths === 0) return "less than 0.01";
  return hundredthsText(hundredths);
}

/** "1 credit", "13.4 credits", "0 credits". */
export function creditsPhrase(micros, mode = "down") {
  const text = formatCredits(micros, mode);
  return `${text} ${text === "1" ? "credit" : "credits"}`;
}

/** Whole-number credits as a phrase, for allocations: "14 credits". */
export function wholeCreditsPhrase(credits) {
  return `${credits} ${credits === 1 ? "credit" : "credits"}`;
}

// A typical 30-day month, for plan copy that cannot know a customer's period.
export function typicalWeeklyAllocation(plan) {
  const start = Date.UTC(2026, 3, 1);
  return allocationSchedule({ periodStart: start, periodEnd: start + 30 * DAY_MS, monthlyCredits: monthlyCreditsFor(plan) })
    .windows.map((window) => window.credits);
}
