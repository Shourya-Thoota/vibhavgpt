// Where an account's plan comes from, for the plans page and for entitlements alike.
//
// A subscription row can come from four places (billing_source):
//   - "stripe":        a web subscription, kept in step by Stripe's signed webhooks;
//   - "google_play":   an Android store purchase from before in-app billing was removed (migration 0025 dropped the Play tables and
//                      its verifier). Such a row is honoured, and shown as an Android purchase, only while it still carries the
//                      purchase token Play verified, reads active or trialing, and its paid period has not ended. Anything else is a
//                      leftover: it grants nothing and is never shown as a current plan;
//   - "internal":      access granted by VibhavGPT directly (no store, no web checkout). Honoured as before; shown as granted access,
//                      never as a store purchase, with nothing to manage or cancel;
//   - anything else:   treated like a leftover store row (verified never), so an unexpected value can never show or grant a plan.
// Complimentary accounts (COMP_PLAN_ACCOUNTS) sit above all of these: always Max, shown "Complimentary", unless the account also has
// a real, current web subscription, which billing then shows.

export const KNOWN_SOURCES = Object.freeze(["stripe", "google_play", "internal"]);

const inPaidPeriod = (row, now) => ["plus", "pro", "max", "paid"].includes(row?.tier)
  && ["active", "trialing"].includes(row?.status)
  && (!row?.currentPeriodEndsAt || new Date(row.currentPeriodEndsAt) > now);

/** A store (Android) subscription that still verifies: Play's purchase token, active or trialing, and a paid period still open. */
export function storeSubscriptionVerified(row, now = new Date()) {
  if (row?.billingSource !== "google_play") return false;
  if (!row.providerPurchaseTokenHash) return false;
  // A store purchase always had an end; without one it cannot be a verified paid period.
  if (!row.currentPeriodEndsAt) return false;
  return inPaidPeriod(row, now);
}

/** Whether a row may grant its tier at all. Stripe and internal rows follow their own status and period; store rows must verify. */
export function rowMayGrant(row, now = new Date()) {
  if (!row) return false;
  const source = row.billingSource ?? "stripe";
  if (source === "stripe" || source === "internal") return true;
  return storeSubscriptionVerified(row, now);
}

/** A real web subscription in force now: the one thing that is shown instead of the complimentary state. */
export const webSubscriptionCurrent = (row, now = new Date()) => (row?.billingSource ?? "stripe") === "stripe" && inPaidPeriod(row, now);

/**
 * What the plans page shows as the current plan's source, from the stored row and the account's complimentary status:
 *   "complimentary" | "stripe" | "google_play" | "internal" | "none".
 * The plan's tier itself always comes from the one plan resolver (tierForSubscription), the same one the sidebar reads.
 */
export function planSourceFor(row, { complimentary = false, now = new Date() } = {}) {
  if (complimentary && !webSubscriptionCurrent(row, now)) return "complimentary";
  if (!row) return "none";
  const source = row.billingSource ?? "stripe";
  if (source === "stripe") return inPaidPeriod(row, now) ? "stripe" : "none";
  if (source === "internal") return inPaidPeriod(row, now) ? "internal" : "none";
  return storeSubscriptionVerified(row, now) ? "google_play" : "none";
}
