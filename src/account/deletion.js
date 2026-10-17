import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  billingCustomers, conversationGroups, conversations, creditLedger, imageFolders, memoryFacts, subscriptions,
  usageEvents, userProfiles, voiceLiveSessions,
} from "../db/schema.js";

/* ==========================================================================
   Account deletion: everything the account owns, in one transaction.

   App data goes first (children before the rows they point at), then the
   sign-in records the auth library keeps (passkeys, two-factor secrets,
   sessions, linked accounts, pending verification codes), then the user
   row itself. Auth rows are removed explicitly rather than trusted to
   foreign-key cascades, so a database created without them still ends with
   nothing left. If any step fails the whole deletion rolls back and the
   account stays intact, so a retry starts clean.

   Uploaded files are removed by the caller before this runs; their rows
   must be gone before image folders can be.
   ========================================================================== */

/* Deletion never cancels a plan. While a plan could still renew or charge,
   deletion is refused and the person cancels it first: a web plan in Plan
   and billing, a plan bought elsewhere where it was bought. A web plan whose
   cancellation is already scheduled cannot renew, so it does not block, even
   though its paid period is still running. */
const OPEN_PLAN_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);
export const ACTIVE_SUBSCRIPTION_CODE = "active-subscription";
export const WEB_PLAN_BLOCK = "You have an active plan. Cancel it in Plan and billing, then delete your account. Nothing was deleted.";
export const OTHER_PLAN_BLOCK = "Your plan was bought outside the web, so it can't be canceled here. Cancel it where you bought it, then delete your account. Nothing was deleted.";

// The reason deletion is refused for this subscription row, or null.
export function deletionBlock(subscription, now = new Date()) {
  if (!subscription || subscription.tier === "free" || !OPEN_PLAN_STATUSES.has(subscription.status)) return null;
  const periodEndsAt = subscription.currentPeriodEndsAt ? new Date(subscription.currentPeriodEndsAt) : null;
  if (periodEndsAt && periodEndsAt <= now) return null;
  if (subscription.billingSource !== "stripe") return { error: OTHER_PLAN_BLOCK, code: ACTIVE_SUBSCRIPTION_CODE };
  if (subscription.cancelAtPeriodEnd === true) return null;
  return { error: WEB_PLAN_BLOCK, code: ACTIVE_SUBSCRIPTION_CODE };
}

// The auth library's tables, in delete order. Each is skipped if absent (a
// plugin that was never enabled has no table).
const AUTH_TABLES_BY_USER = ["passkey", "twoFactor", "session", "account"];

function rows(result) {
  return result?.rows ?? (Array.isArray(result) ? result : []);
}

async function tableExists(tx, name) {
  const result = await tx.execute(sql`select to_regclass(${`public."${name}"`}) as name`);
  return Boolean(rows(result)[0]?.name);
}

export async function deleteAccountData(db, userId) {
  if (typeof userId !== "string" || !userId) throw new Error("A user id is required to delete an account.");
  return db.transaction(async (tx) => {
    // Conversations take their messages with them (cascade), and must go
    // before the projects and folders they are filed in.
    await tx.delete(conversations).where(eq(conversations.userId, userId));
    await tx.delete(conversationGroups).where(and(eq(conversationGroups.userId, userId), isNotNull(conversationGroups.parentId)));
    await tx.delete(conversationGroups).where(eq(conversationGroups.userId, userId));
    await tx.delete(imageFolders).where(eq(imageFolders.userId, userId));
    await tx.delete(creditLedger).where(eq(creditLedger.userId, userId));
    await tx.delete(usageEvents).where(eq(usageEvents.userId, userId));
    await tx.delete(voiceLiveSessions).where(eq(voiceLiveSessions.userId, userId));
    await tx.delete(memoryFacts).where(eq(memoryFacts.userId, userId));
    await tx.delete(userProfiles).where(eq(userProfiles.userId, userId));
    await tx.delete(subscriptions).where(eq(subscriptions.userId, userId));
    await tx.delete(billingCustomers).where(eq(billingCustomers.userId, userId));

    // Sign-in records.
    const email = rows(await tx.execute(sql`select email from "user" where id = ${userId}`))[0]?.email ?? null;
    for (const table of AUTH_TABLES_BY_USER) {
      if (await tableExists(tx, table)) await tx.execute(sql`delete from ${sql.identifier(table)} where "userId" = ${userId}`);
    }
    // Pending email codes are keyed by an identifier that ends in the email
    // ("sign-in-otp-a@b.com"), never by user id. The hyphen keeps
    // "a@b.com" from matching "ba@b.com".
    if (email && await tableExists(tx, "verification")) {
      await tx.execute(sql`delete from "verification" where identifier = ${email} or identifier like ${`%-${email}`}`);
    }
    const deleted = rows(await tx.execute(sql`delete from "user" where id = ${userId} returning id`));
    return { userDeleted: deleted.length > 0 };
  });
}
