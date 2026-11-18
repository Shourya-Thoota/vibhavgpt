// What the AI credits panel says, as plain data. All amounts come from the
// server's integer micro-dollars and are worded with the shared helpers, so the
// panel and the server can never disagree about a number. Pure: no React, no DOM.

import { CARRY_MODES, CREDIT_MICROS, creditsPhrase, wholeCreditsPhrase } from "./credits-policy.js";
import { usagePercentage } from "./usage-percentage.js";

const wholeCredits = (micros) => wholeCreditsPhrase(Math.round(micros / CREDIT_MICROS));

function dateFormatters({ locale, timeZone } = {}) {
  const stamp = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone });
  return { stamp: (iso) => stamp.format(new Date(iso)), day: (iso) => day.format(new Date(iso)) };
}

/**
 * @param credits  the `credits` object from GET /api/usage (null while inactive)
 * @param options  { locale, timeZone, now } for tests; the screen passes none
 */
export function creditsView(credits, { locale, timeZone, now = Date.now() } = {}) {
  if (!credits?.active) return null;
  const when = dateFormatters({ locale, timeZone });
  const carry = credits.carryMode === CARRY_MODES.CARRY;
  const finalWeek = credits.nextAllocationAt === null;

  // The one timing line. It names what actually happens next.
  const timing = finalWeek
    ? { label: "Resets on", at: credits.resetsAt, note: "This is the last allocation of the month; the monthly allowance resets then." }
    : carry
      ? { label: "Next allocation", at: credits.nextAllocationAt, note: null }
      : { label: "Resets on", at: credits.nextAllocationAt, note: null }; // the policy note already says unused credits expire

  const availableText = creditsPhrase(credits.available.micros, "down");
  let state = "ok";
  let headlineValue = availableText;
  let headlineNote = null;
  if (credits.exhausted === "week") {
    state = "week-exhausted";
    headlineValue = "None left this week";
    headlineNote = carry ? `Your next allocation arrives ${when.stamp(credits.nextAllocationAt)}.` : `Your credits reset ${when.stamp(credits.nextAllocationAt)}.`;
  } else if (credits.exhausted === "month") {
    state = "month-exhausted";
    headlineValue = "None left this month";
    headlineNote = `Your monthly allowance resets ${when.stamp(credits.resetsAt)}.`;
  } else if (credits.available.micros < CREDIT_MICROS) {
    // Under one credit is a real, spendable balance. It is shown as it is.
    headlineNote = "Less than one credit is left, and it can still be used.";
  }

  const rows = [
    { id: "allocated", label: "Allocated this week", value: wholeCreditsPhrase(credits.week.allocationCredits), text: `${wholeCreditsPhrase(credits.week.allocationCredits)} allocated this week` },
    { id: "monthly", label: "Monthly allowance", value: `${wholeCreditsPhrase(credits.monthly.credits)} per month`, text: `${wholeCreditsPhrase(credits.monthly.credits)} per month` },
    { id: "used", label: "Used this month", value: creditsPhrase(credits.monthly.consumedMicros, "up") },
    { id: "future", label: "Future allocations this month", value: wholeCredits(credits.futureAllocationMicros) },
  ];
  if (carry && credits.available.carriedInMicros > 0) {
    rows.splice(1, 0, { id: "carried", label: "Carried from earlier weeks", value: creditsPhrase(credits.available.carriedInMicros, "down") });
  }

  const nowMs = typeof now === "number" ? now : new Date(now).getTime();
  const schedule = credits.schedule.map((window, index) => {
    const startMs = new Date(window.startsAt).getTime();
    const endMs = new Date(window.endsAt).getTime();
    const status = nowMs >= endMs ? "past" : nowMs >= startMs ? "current" : "upcoming";
    return { id: `week-${index + 1}`, label: `Week ${index + 1}`, from: when.day(window.startsAt), credits: wholeCreditsPhrase(window.credits), status };
  });

  return {
    title: "AI credits",
    state,
    carryMode: credits.carryMode,
    headline: { label: "Available this week", value: headlineValue, note: headlineNote },
    rows,
    timing: { label: timing.label, value: when.stamp(timing.at), text: `${timing.label} ${when.stamp(timing.at)}`, note: timing.note },
    policyNote: carry
      ? "Unused credits carry forward within the month. A later week's credits are never available early."
      : "Credits are allocated each week. Unused credits expire when the week resets.",
    meter: {
      label: "Monthly AI credits used",
      used: credits.monthly.consumedMicros,
      limit: credits.monthly.micros,
      percent: usagePercentage(credits.monthly.consumedMicros, credits.monthly.micros),
    },
    schedule,
    flex: {
      title: "Image & document credits",
      balance: credits.purchased.balance,
      note: "Purchased separately (previously called Flex Credits). They pay for extra documents on Plus and do not add AI credits.",
    },
    resetsMonthly: when.stamp(credits.resetsAt),
    policyVersion: credits.policyVersion,
  };
}
