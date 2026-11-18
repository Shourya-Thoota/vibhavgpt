// What the purchased balance is, what it costs and what it can pay for. One module, used by the billing server (the amount it accepts and the
// units it grants) and by the screens (what they show and promise), so a screen can never say a different number from the one charged.
//
// The balance is called "Image & document credits" on screen. It was called Flex Credits, and keeps that name in the code (the ledger,
// the endpoints) and as "Previously called Flex Credits" for people who bought them under it.
//
// What is ENFORCED today (src/usage/service.js, reserveGeneration):
//   - $1 buys 100 credits. Credits do not expire. A balance never pays for Chat or Study.
//   - A credit pays for one thing: Plus's documents beyond its 20 a month, 1 credit each.
//   - Images never use credits: at the plan's image limit the request is refused until the allowance renews.
//   - Pro and Max have unlimited documents; Free has no documents. Neither has anything to spend credits on.
export const FLEX_NAME = "Image & document credits";
export const FLEX_FORMER_NAME = "Flex Credits";

export const CREDIT_PURCHASE = Object.freeze({
  minimumCents: 100,
  maximumCents: 50_000,
  stepCents: 10,
  creditsPerDollar: 100,
  presets: Object.freeze([5, 10, 20, 50]),
});

/** What one credit buys, per kind of action. Only documents beyond a plan's included number draw on credits. */
export const CREDIT_SPEND = Object.freeze({ extraDocument: 1 });

export const creditsForCents = (cents) => Math.round((Number(cents) * CREDIT_PURCHASE.creditsPerDollar) / 100);

/**
 * A typed or chosen dollar amount, validated the way the server validates it.
 * { ok: true, dollars, cents, credits } or { ok: false, error }.
 */
export function parsePurchaseAmount(amount) {
  const text = typeof amount === "string" ? amount.trim() : amount;
  const dollars = Number(text);
  const cents = Math.round(dollars * 100);
  const faithfullyRepresented = text !== "" && text !== null && text !== undefined && Number.isFinite(dollars) && Math.abs(dollars * 100 - cents) < 0.0001;
  if (!faithfullyRepresented || cents < CREDIT_PURCHASE.minimumCents || cents > CREDIT_PURCHASE.maximumCents || cents % CREDIT_PURCHASE.stepCents !== 0) {
    return { ok: false, error: "Enter an amount from $1 to $500 in $0.10 increments." };
  }
  return { ok: true, dollars: cents / 100, cents, credits: creditsForCents(cents) };
}

/** Whole-credit count as the screens write it: "1,250". */
export const formatCreditCount = (credits) => Math.max(0, Math.trunc(Number(credits) || 0)).toLocaleString("en-US");
/** Dollars as the screens write them: "$5.00". */
export const formatDollars = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;
/** "1 credit" / "500 credits". */
export const creditUnits = (credits) => `${formatCreditCount(credits)} ${Number(credits) === 1 ? "credit" : "credits"}`;

/**
 * Whether a purchase would be spendable on this plan, and what for. Pure and plan-only: it says nothing about balances, because a
 * balance bought earlier stays on the account whatever the plan is now.
 *   { eligible, uses: [{ id, text }], reason, action }
 */
export function purchaseEligibility(tier) {
  if (tier === "plus") {
    return { eligible: true, uses: [{ id: "extra-documents", text: "documents beyond your 20 a month, 1 credit each" }], reason: null, action: null };
  }
  if (tier === "pro" || tier === "max" || tier === "paid") {
    return { eligible: false, uses: [], reason: "Your plan includes unlimited documents, and images renew with your plan, so there is nothing these credits could pay for.", action: null };
  }
  return { eligible: false, uses: [], reason: "These credits pay for extra documents on Plus. Free does not include documents, and images are a weekly allowance that credits cannot add to.", action: { id: "plans", label: "See Plus and Pro" } };
}

/** "Buy 500 credits for $5.00". */
export const purchaseButtonLabel = (cents) => {
  const credits = creditsForCents(cents);
  return `Buy ${creditUnits(credits)} for ${formatDollars(cents)}`;
};
