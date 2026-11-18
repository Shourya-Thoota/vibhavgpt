import { sql } from "drizzle-orm";
import { config } from "../config.js";

// Complimentary-plan accounts (COMP_PLAN_ACCOUNTS). An account whose email is listed is always on Max with unlimited AI usage:
//   - every place that reads a plan sees Max (getActiveSubscription marks it; tierForSubscription honours the mark);
//   - AI credit and allowance limits are not enforced for it, and its credits never show as used up;
//   - billing can never move it below Max: its plan does not come from the subscription row, so no webhook, reconciliation or page
//     action can lower it. A real subscription still shows on the billing page, but Max stays the floor.
// Abuse protection is unchanged: chat bursts, concurrency and capacity limits and upload sizes apply exactly as for anyone.
// With the list empty, nothing here runs a query and nothing behaves differently.

const rowsOf = (result) => (Array.isArray(result) ? result : result?.rows ?? []);

export const compPlanAccountCount = (list = config.compPlanAccounts) => list.length;

export function isCompPlanEmail(email, list = config.compPlanAccounts) {
  if (!list.length || typeof email !== "string") return false;
  return list.includes(email.trim().toLowerCase());
}

/** Whether this account is complimentary, read from its own sign-in email. False, with no query, when the list is empty. */
export async function isCompPlanAccount(userId, executor, list = config.compPlanAccounts) {
  if (!list.length || !userId || !executor?.execute) return false;
  const [row] = rowsOf(await executor.execute(sql`select email from "user" where id = ${userId} limit 1`));
  return isCompPlanEmail(row?.email, list);
}

/** Whether a stored subscription is a paid plan in force now (the same test tierForSubscription applies, kept here so billing needs no usage code). */
export function paidPlanIsCurrent(record, now = new Date()) {
  return Boolean(record)
    && ["plus", "pro", "max", "paid"].includes(record.tier)
    && ["active", "trialing"].includes(record.status)
    && (!record.currentPeriodEndsAt || new Date(record.currentPeriodEndsAt) > now);
}

/** The subscription a complimentary account is shown when it has no paid one of its own. */
export const COMPLIMENTARY_SUBSCRIPTION = Object.freeze({ tier: "max", status: "active", billingSource: "complimentary", currentPeriodEndsAt: null, cancelAtPeriodEnd: false });
