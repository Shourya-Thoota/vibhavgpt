// What a price must be for a checkout to send a person to pay it. Pure, so the server and the owner-run verifier apply the same rule.
//
// Plans are sold in US dollars, as a recurring price billed every one month or every one year, under our own lookup key. A price that is
// archived, in another currency, one-time, on another interval, or for another plan is a configuration slip, never something to charge.

export function planPriceProblem(price, priceLookupKey) {
  if (!price || typeof price !== "object") return "missing";
  if (price.active !== true) return "inactive";
  if (price.type !== "recurring") return "not-recurring";
  if (price.currency !== "usd") return "wrong-currency";
  const interval = String(priceLookupKey ?? "").endsWith("_yearly") ? "year" : "month";
  if (price.recurring?.interval !== interval || (price.recurring?.interval_count ?? 1) !== 1) return "wrong-interval";
  if (price.lookup_key !== priceLookupKey) return "wrong-plan";
  return null;
}

// The approved Max amounts in cents. Only the owner-run verifier compares these: checkout itself does not refuse a price for its amount, so
// a deliberate, reviewed price change in Stripe never blocks anyone from paying.
// Approved by the owner on 2026-11-15: $49.99 a month and $499.90 a year, for new subscriptions (the first prices were $50 and $500).
export const APPROVED_MAX_PRICES = Object.freeze({
  vibhavgpt_max_monthly: 4999,
  vibhavgpt_max_yearly: 49990,
});
