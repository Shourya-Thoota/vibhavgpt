// What the Usage screen says, as plain data, in the order a new person asks: what plan am I on, how much can I use right now, when do I
// get more, and what happens when I run out. Pure: no React, no DOM. Every number comes from GET /api/usage (the credits object for Chat and
// Study, the overview object for images, documents and the purchased balance); nothing here recomputes what the server enforces.
//
// A figure that is not known is "unavailable", never zero. A balance is never shown as bigger than it can spend: credits round down.

import { CARRY_MODES, CREDIT_MICROS, creditsPhrase, wholeCreditsPhrase } from "./credits-policy.js";
import { FLEX_FORMER_NAME, FLEX_NAME, creditUnits } from "./flex-credits.js";
import { creditsView } from "./credits-view.js";
import { countText } from "./plan-entitlements.js";

const planName = (tier) => ({ free: "Free", plus: "Plus", pro: "Pro", max: "Max", paid: "Pro" }[tier] ?? "Free");

function stampers({ locale, timeZone } = {}) {
  // A time with its zone, so "12:00 AM" is never ambiguous between the server's clock and the reader's.
  const full = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone });
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone });
  return { full: (iso) => (iso ? full.format(new Date(iso)) : null), day: (iso) => (iso ? day.format(new Date(iso)) : null) };
}

/** Chat and Study: the AI credits. `credits` is null while the policy is off (the older token screen then applies). */
function chatSection(usage, when, now) {
  const credits = usage.credits;
  if (!credits?.active) return { kind: "tokens", title: "Chat & Study", plan: planName(usage.tier) };
  const carry = credits.carryMode === CARRY_MODES.CARRY;
  const detail = creditsView(credits, { now });
  const finalWeek = credits.nextAllocationAt === null;
  const nextWindow = credits.schedule.find((window) => new Date(window.startsAt).getTime() > now) ?? null;
  const exhausted = credits.exhausted;

  // How much can be used right now: only what has been released. Later weeks' credits are never counted here.
  const available = exhausted ? "None" : creditsPhrase(credits.available.micros, "down");
  const lessThanOne = !exhausted && credits.available.micros < CREDIT_MICROS;

  let next;
  if (!finalWeek && nextWindow) next = { label: "Next allocation", value: `${wholeCreditsPhrase(nextWindow.credits)} on ${when.full(credits.nextAllocationAt)}` };
  else if (!finalWeek) next = { label: "Next allocation", value: when.full(credits.nextAllocationAt) };
  else next = { label: "Monthly allowance resets", value: when.full(credits.resetsAt) };

  const whenMore = finalWeek ? when.full(credits.resetsAt) : when.full(credits.nextAllocationAt);
  let runOut;
  if (exhausted === "month") runOut = `You've used this month's AI credits. Chat and Study start again when your monthly allowance resets on ${when.full(credits.resetsAt)}.`;
  else if (exhausted === "week") runOut = carry
    ? `You've used all the AI credits released so far this month. More arrive on ${whenMore}.`
    : `You've used this week's AI credits. They reset on ${whenMore}.`;
  else runOut = finalWeek
    ? `When these are used, Chat and Study wait for your monthly reset on ${whenMore}.`
    : `When these are used, Chat and Study wait for your next allocation on ${whenMore}.`;

  return {
    kind: "credits",
    title: "Chat & Study",
    state: exhausted ? `${exhausted}-exhausted` : "ok",
    mode: carry ? "carry" : "expiry",
    headline: { label: "AI credits you can use right now", value: available, note: lessThanOne ? "Less than one credit is left, and it can still be used." : null },
    rows: [
      { id: "used", label: "Used this month", value: creditsPhrase(credits.monthly.consumedMicros, "up") },
      { id: "monthly", label: "Monthly allowance", value: `${wholeCreditsPhrase(credits.monthly.credits)}, released weekly` },
      { id: "next", label: next.label, value: next.value },
    ],
    rule: carry
      ? "Credits arrive each week, and unused credits carry forward within the month. A later week's credits are never available early."
      : "Credits arrive each week. Unused credits expire when the week resets.",
    runOut,
    // These two stay out of the main view: accounting detail for people who want it.
    details: { rows: detail.rows, schedule: detail.schedule, meter: detail.meter, policyNote: detail.policyNote },
  };
}

function imagesSection(usage, when) {
  const overview = usage.overview?.images;
  if (!overview) return { available: false, title: "Images", message: "Image allowance is unavailable right now." };
  const plan = planName(usage.tier);
  if (!overview.included) return { available: true, included: false, title: "Images", message: `Image creation is not included on ${plan}.`, runOut: "See the plans to add images." };
  const weekly = overview.period === "week";
  const renew = when.full(overview.renewsAt);
  return {
    available: true,
    included: true,
    title: "Images",
    headline: { label: weekly ? "Images left this week" : "Images left this month", value: `${countText(overview.remaining)} of ${countText(overview.limit)}` },
    meter: { remaining: overview.remaining, limit: overview.limit, label: weekly ? "images left this week" : "images left this month" },
    renews: renew ? (weekly ? `Free accounts get ${overview.limit} images each week. The next ${overview.limit} arrive ${renew}.` : `Your allowance renews on ${renew}.`) : null,
    runOut: `When they are used, image requests stop until ${renew ?? "your allowance renews"}. Extra images can't be bought.`,
  };
}

function documentsSection(usage, when) {
  const overview = usage.overview?.documents;
  if (!overview) return { available: false, title: "Documents", message: "Document allowance is unavailable right now." };
  const plan = planName(usage.tier);
  if (!overview.included) return { available: true, included: false, title: "Documents", message: `Document creation is not included on ${plan}.`, runOut: "Documents come with Plus and above." };
  if (overview.unlimited) return { available: true, included: true, unlimited: true, title: "Documents", headline: { label: "Documents", value: "Unlimited" }, runOut: `${plan} has no monthly limit on documents.` };
  const renew = when.full(overview.renewsAt);
  const balance = usage.overview?.flex?.balance ?? 0;
  return {
    available: true,
    included: true,
    unlimited: false,
    title: "Documents",
    headline: { label: "Documents left this month", value: `${countText(overview.remaining)} of ${countText(overview.limit)}` },
    meter: { remaining: overview.remaining, limit: overview.limit, label: "documents left this month" },
    renews: renew ? `Your allowance renews on ${renew}.` : null,
    runOut: balance > 0
      ? `After ${overview.limit} in a month, each extra document uses ${creditUnits(overview.extras.costCredits)} of your ${FLEX_NAME.toLowerCase()} (${creditUnits(balance)} available).`
      : `After ${overview.limit} in a month, each extra document uses ${creditUnits(overview.extras.costCredits)} of ${FLEX_NAME.toLowerCase()}. With none, documents wait until ${renew ?? "your allowance renews"}.`,
  };
}

function extraSection(usage) {
  const flex = usage.overview?.flex;
  if (!flex) return { available: false, title: FLEX_NAME, message: "Your extra balance is unavailable right now." };
  return {
    available: true,
    title: FLEX_NAME,
    formerName: `Previously called ${FLEX_FORMER_NAME}.`,
    balance: flex.balance,
    balanceText: creditUnits(flex.balance),
    note: "These pay for extra documents beyond your plan's allowance. They don't add Chat & Study credits, and they don't expire.",
  };
}

/**
 * @param usage  GET /api/usage, or null while it loads
 * @param options { locale, timeZone, now } for tests
 */
export function usageOverviewView(usage, { locale, timeZone, now = Date.now() } = {}) {
  if (!usage) return null;
  const when = stampers({ locale, timeZone });
  const nowMs = typeof now === "number" ? now : new Date(now).getTime();
  return {
    plan: planName(usage.tier),
    chat: chatSection(usage, when, nowMs),
    images: imagesSection(usage, when),
    documents: documentsSection(usage, when),
    extra: extraSection(usage),
  };
}
