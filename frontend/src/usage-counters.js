// The Usage page's three counters, as plain data (owner request, 2026-11-14): one line each, nothing else.
//   Credits:   "X / Y credits used this month" (or this week), or "Unlimited" for a complimentary account.
//   Images:    "X / Y images used this month" (Free counts by the week).
//   Documents: "Unlimited", "X / Y documents used this month", or "Not included on <plan>".
// Every number comes from GET /api/usage; nothing here recomputes what the server enforces. A figure the server did not send reads
// "Unavailable", never zero.
import { formatCredits } from "./credits-policy.js";
import { combinedTokenUsage, usagePercentage } from "./usage-percentage.js";

const PLAN_NAMES = { free: "Free", plus: "Plus", pro: "Pro", max: "Max", paid: "Pro" };
const planName = (tier) => PLAN_NAMES[tier] ?? "Free";
const count = (n) => Number(n).toLocaleString("en-US");
const finite = (n) => Number.isFinite(Number(n)) && n !== null;

function creditsCounter(usage) {
  const credits = usage.credits;
  if (credits?.complimentary === true) return { id: "credits", label: "AI credits", value: "Unlimited", unlimited: true };
  if (credits?.active) {
    const used = formatCredits(credits.monthly?.consumedMicros ?? 0, "up");
    const total = credits.monthly?.credits;
    if (!finite(total)) return { id: "credits", label: "AI credits", value: "Unavailable" };
    return { id: "credits", label: "AI credits", value: `${used} / ${count(total)} credits used this month`, used: credits.monthly?.consumedMicros ?? 0, exhausted: Boolean(credits.exhausted) };
  }
  // Credits off: the token allowance, as one share of this month's.
  const { monthly } = combinedTokenUsage(usage);
  if (!(monthly.limit > 0)) return { id: "credits", label: "AI usage", value: usage.tier === "free" ? "Included with Free" : "Unavailable" };
  return { id: "credits", label: "AI usage", value: `${usagePercentage(monthly.used, monthly.limit)}% of this month's allowance used` };
}

function imagesCounter(usage) {
  const images = usage.overview?.images;
  if (!images) return { id: "images", label: "Images", value: "Unavailable" };
  if (!images.included) return { id: "images", label: "Images", value: `Not included on ${planName(usage.tier)}` };
  if (!finite(images.limit) || !finite(images.remaining)) return { id: "images", label: "Images", value: "Unavailable" };
  const used = Math.max(0, images.limit - images.remaining);
  return { id: "images", label: "Images", value: `${count(used)} / ${count(images.limit)} images used this ${images.period === "week" ? "week" : "month"}` };
}

function documentsCounter(usage) {
  const documents = usage.overview?.documents;
  if (!documents) return { id: "documents", label: "Documents", value: "Unavailable" };
  if (!documents.included) return { id: "documents", label: "Documents", value: `Not included on ${planName(usage.tier)}` };
  if (documents.unlimited) return { id: "documents", label: "Documents", value: "Unlimited", unlimited: true };
  if (!finite(documents.limit) || !finite(documents.remaining)) return { id: "documents", label: "Documents", value: "Unavailable" };
  const used = Math.max(0, documents.limit - documents.remaining);
  return { id: "documents", label: "Documents", value: `${count(used)} / ${count(documents.limit)} documents used this month` };
}

/** @param usage GET /api/usage, or null while it loads */
export function usageCounters(usage) {
  if (!usage) return null;
  return { plan: planName(usage.tier), rows: [creditsCounter(usage), imagesCounter(usage), documentsCounter(usage)] };
}
